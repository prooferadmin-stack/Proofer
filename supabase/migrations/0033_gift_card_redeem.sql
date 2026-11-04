-- Gift cards, part 2 (Phase 2.8): redeem on invoices, balances, undo, void.
-- Spec: specs/phase-2b-gift-cards.md (workstation). Review gate: money.
--
-- Guarantees enforced here, in the database:
--   * A card pays only invoices (never bookings on hold, drafts, void or paid
--     invoices), never more than its balance, never more than what is due.
--     Card and invoice are locked in that order, so two redemptions of one
--     card (or two cards on one invoice) can't overspend or deadlock.
--   * Every spend or undo is a gift_card_ledger row; the card's balance is
--     always the sum of its ledger rows.
--   * "Amount due" = the total (or installment amount) less live gift card
--     credit. record_stripe_event now requires Stripe's amount to equal the
--     amount due, so a card plus a card payment can never pay twice.
--   * Gift card credit counts as a payment for the freeze rules: an invoice
--     with live credit can't be edited, voided or deleted, and its line items
--     and schedule are frozen, until the credit is undone.
--   * Undo is allowed only while what it paid is still unpaid. Void (for a
--     refund) only for an untouched card within 30 days of purchase.

-- Which redemption an undo row reverses (each can be undone once).
alter table gift_card_ledger add column if not exists reverses_ledger_id uuid references gift_card_ledger(id) on delete restrict;
create unique index if not exists gift_card_ledger_reverses_idx on gift_card_ledger (reverses_ledger_id) where reverses_ledger_id is not null;
alter table gift_card_ledger drop constraint if exists gift_card_ledger_reverse_link;
alter table gift_card_ledger add constraint gift_card_ledger_reverse_link check ((kind = 'reverse') = (reverses_ledger_id is not null));
alter table gift_card_ledger drop constraint if exists gift_card_ledger_redeem_target;
alter table gift_card_ledger add constraint gift_card_ledger_redeem_target check (kind not in ('redeem', 'reverse') or invoice_id is not null);

-- Refund bookkeeping for a voided card (2.8). Set by the app after Stripe
-- answers; never touches a card or its balance.
alter table gift_card_purchases add column if not exists refund_id text;
alter table gift_card_purchases add column if not exists refunded_at timestamptz;
alter table gift_card_purchases add column if not exists refund_error text;

-- Live gift card credit on an invoice without a schedule (p_installment null)
-- or on one installment. Redemptions are negative, undos positive.
create or replace function gift_card_credit_cents(p_invoice_id uuid, p_installment_id uuid) returns integer
language sql stable as $$
  select coalesce(-sum(amount_cents), 0)::integer
  from gift_card_ledger
  where kind in ('redeem', 'reverse')
    and invoice_id = p_invoice_id
    and installment_id is not distinct from p_installment_id;
$$;

-- Any live credit anywhere on the invoice.
create or replace function invoice_has_gift_credit(p_invoice_id uuid) returns boolean
language sql stable as $$
  select coalesce(sum(amount_cents), 0) <> 0
  from gift_card_ledger
  where kind in ('redeem', 'reverse') and invoice_id = p_invoice_id;
$$;

-- The freeze rules (0023 guards) call this; gift card credit now counts.
create or replace function invoice_has_paid_installment(p_invoice_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from invoice_installments where invoice_id = p_invoice_id and status = 'paid')
      or invoice_has_gift_credit(p_invoice_id);
$$;

-- Same as 0023, plus: opening Checkout on a frozen invoice may still record
-- its session id (a card can leave an invoice partly paid and still sent).
create or replace function invoices_paid_guard() returns trigger
language plpgsql as $$
declare
  marking boolean := coalesce(current_setting('proofer.marking_paid', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.status = 'paid' or invoice_has_paid_installment(old.id) then
      raise exception 'An invoice with payments can''t be deleted';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'paid' then
    raise exception 'A paid invoice can''t be changed';
  end if;
  if tg_op = 'UPDATE' and not marking and invoice_has_paid_installment(old.id)
     and (to_jsonb(new) - 'stripe_checkout_session_id' - 'updated_at')
         is distinct from (to_jsonb(old) - 'stripe_checkout_session_id' - 'updated_at') then
    raise exception 'A payment has been made on this invoice, so it can''t be changed';
  end if;
  if new.status = 'paid' and not marking then
    raise exception 'Only a verified Stripe payment can mark an invoice paid';
  end if;
  if not marking and (
    new.paid_at is not null or new.amount_paid_cents is not null
    or new.stripe_payment_intent_id is not null or new.paid_checkout_session_id is not null
  ) then
    raise exception 'Payment fields are set only by a verified Stripe payment';
  end if;
  return new;
end;
$$;

-- Spends a card on an invoice: whatever is due, up to the card's balance,
-- across unpaid installments in order. Marks anything it fully covers paid.
-- Returns {ok, reason?, applied_cents, balance_cents, invoice_paid, covered}.
create or replace function redeem_gift_card(p_code text, p_invoice_id uuid, p_actor text) returns jsonb
language plpgsql as $$
declare
  code_norm text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  card gift_cards%rowtype;
  inv invoices%rowtype;
  inst invoice_installments%rowtype;
  balance integer;
  due integer;
  take integer;
  applied integer := 0;
  covered integer := 0;
  has_schedule boolean;
  paid_now boolean := false;
begin
  if p_actor not in ('client', 'admin') then
    raise exception 'Unknown actor';
  end if;
  if code_norm !~ '^DMP' then
    code_norm := 'DMP' || code_norm;
  end if;

  -- Card first, then invoice: the one lock order every redemption uses.
  select * into card from gift_cards where code = code_norm for update;
  if card.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into inv from invoices where id = p_invoice_id for update;
  if inv.id is null or inv.status <> 'sent' then
    return jsonb_build_object('ok', false, 'reason', 'invoice_not_payable');
  end if;
  if card.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'void');
  end if;
  if card.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if card.balance_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if lower(card.currency) <> lower(inv.currency) then
    return jsonb_build_object('ok', false, 'reason', 'currency');
  end if;
  -- A booking on hold is paid by card through Checkout, not with a gift card.
  if exists (select 1 from bookings where invoice_id = inv.id and status = 'pending_payment') then
    return jsonb_build_object('ok', false, 'reason', 'booking_hold');
  end if;

  balance := card.balance_cents;
  has_schedule := exists (select 1 from invoice_installments where invoice_id = inv.id);
  perform set_config('proofer.gift_card_write', 'on', true);
  perform set_config('proofer.marking_paid', 'on', true);

  if not has_schedule then
    due := inv.total_cents - gift_card_credit_cents(inv.id, null);
    if due > 0 then
      take := least(balance, due);
      insert into gift_card_ledger (gift_card_id, kind, amount_cents, invoice_id, installment_id, actor)
        values (card.id, 'redeem', -take, inv.id, null, p_actor);
      balance := balance - take;
      applied := take;
      if take = due then
        covered := 1;
        update invoices set status = 'paid', paid_at = now(), amount_paid_cents = total_cents, updated_at = now()
          where id = inv.id;
        paid_now := true;
      end if;
    end if;
  else
    for inst in
      select * from invoice_installments where invoice_id = inv.id and status = 'unpaid' order by position for update
    loop
      exit when balance <= 0;
      due := inst.amount_cents - gift_card_credit_cents(inv.id, inst.id);
      continue when due <= 0;
      take := least(balance, due);
      insert into gift_card_ledger (gift_card_id, kind, amount_cents, invoice_id, installment_id, actor)
        values (card.id, 'redeem', -take, inv.id, inst.id, p_actor);
      balance := balance - take;
      applied := applied + take;
      if take = due then
        covered := covered + 1;
        update invoice_installments set status = 'paid', paid_at = now() where id = inst.id;
      end if;
    end loop;
    if applied > 0 and not exists (select 1 from invoice_installments where invoice_id = inv.id and status <> 'paid') then
      update invoices set status = 'paid', paid_at = now(),
        amount_paid_cents = (select sum(amount_cents) from invoice_installments where invoice_id = inv.id),
        updated_at = now()
        where id = inv.id;
      paid_now := true;
    end if;
  end if;

  if applied = 0 then
    perform set_config('proofer.marking_paid', 'off', true);
    perform set_config('proofer.gift_card_write', 'off', true);
    return jsonb_build_object('ok', false, 'reason', 'nothing_due');
  end if;

  update gift_cards set balance_cents = balance where id = card.id;
  perform set_config('proofer.marking_paid', 'off', true);
  perform set_config('proofer.gift_card_write', 'off', true);
  return jsonb_build_object('ok', true, 'gift_card_id', card.id, 'applied_cents', applied, 'balance_cents', balance,
                            'invoice_paid', paid_now, 'covered', covered);
end;
$$;

-- Undoes one redemption while what it paid is still unpaid. Admin only.
create or replace function reverse_gift_card_redemption(p_ledger_id uuid, p_note text) returns text
language plpgsql as $$
declare
  r gift_card_ledger%rowtype;
  card gift_cards%rowtype;
  inv invoices%rowtype;
  inst invoice_installments%rowtype;
begin
  select * into r from gift_card_ledger where id = p_ledger_id;
  if r.id is null or r.kind <> 'redeem' then
    return 'not_found';
  end if;
  select * into card from gift_cards where id = r.gift_card_id for update;
  select * into inv from invoices where id = r.invoice_id for update;
  if exists (select 1 from gift_card_ledger where reverses_ledger_id = r.id) then
    return 'already_undone';
  end if;
  if inv.status <> 'sent' then
    return 'target_paid';
  end if;
  if r.installment_id is not null then
    select * into inst from invoice_installments where id = r.installment_id for update;
    if inst.id is null or inst.status <> 'unpaid' then
      return 'target_paid';
    end if;
  end if;
  if card.status <> 'active' then
    return 'card_void';
  end if;

  perform set_config('proofer.gift_card_write', 'on', true);
  insert into gift_card_ledger (gift_card_id, kind, amount_cents, invoice_id, installment_id, actor, note, reverses_ledger_id)
    values (card.id, 'reverse', -r.amount_cents, r.invoice_id, r.installment_id, 'admin',
            nullif(left(trim(coalesce(p_note, '')), 300), ''), r.id);
  update gift_cards set balance_cents = balance_cents - r.amount_cents where id = card.id;
  perform set_config('proofer.gift_card_write', 'off', true);
  return 'undone';
end;
$$;

-- Voids an untouched card bought in the last 30 days, before David refunds
-- the buyer in Stripe. Admin only.
create or replace function void_gift_card(p_card_id uuid, p_reason text) returns text
language plpgsql as $$
declare
  card gift_cards%rowtype;
begin
  select * into card from gift_cards where id = p_card_id for update;
  if card.id is null then
    return 'not_found';
  end if;
  if card.status <> 'active' then
    return 'already_void';
  end if;
  if card.balance_cents <> card.initial_cents
     or exists (select 1 from gift_card_ledger where gift_card_id = card.id and kind = 'redeem') then
    return 'used';
  end if;
  if card.issued_at <= now() - interval '30 days' then
    return 'too_late';
  end if;

  perform set_config('proofer.gift_card_write', 'on', true);
  insert into gift_card_ledger (gift_card_id, kind, amount_cents, actor, note)
    values (card.id, 'void', -card.balance_cents, 'admin', nullif(left(trim(coalesce(p_reason, '')), 300), ''));
  update gift_cards set status = 'void', voided_at = now(), balance_cents = 0,
    void_reason = nullif(left(trim(coalesce(p_reason, '')), 300), '')
    where id = card.id;
  perform set_config('proofer.gift_card_write', 'off', true);
  return 'voided';
end;
$$;

-- Replaces 0023's version (same signature and outcomes). The only change:
-- Stripe's amount must equal the AMOUNT DUE (total or installment less live
-- gift card credit), and a paid invoice records the full total as paid.
create or replace function record_stripe_event(
  p_event_id text,
  p_type text,
  p_livemode boolean,
  p_invoice_id uuid,
  p_installment_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text,
  p_mark_paid boolean,
  p_payload jsonb
) returns text
language plpgsql as $$
declare
  inv invoices%rowtype;
  inst invoice_installments%rowtype;
  has_schedule boolean := false;
  result text;
begin
  -- Serialize concurrent deliveries of the same event.
  perform pg_advisory_xact_lock(hashtextextended(p_event_id, 0));
  if exists (select 1 from payment_events where stripe_event_id = p_event_id) then
    return 'duplicate';
  end if;

  if p_invoice_id is not null then
    select * into inv from invoices where id = p_invoice_id for update;
  end if;
  if inv.id is not null then
    has_schedule := exists (select 1 from invoice_installments where invoice_id = inv.id);
    if p_installment_id is not null then
      select * into inst from invoice_installments
        where id = p_installment_id and invoice_id = inv.id for update;
    end if;
  end if;

  if inv.id is null and p_invoice_id is not null then
    result := 'unknown_invoice';
  elsif not p_mark_paid then
    result := 'recorded';
  elsif inv.id is null then
    result := 'unknown_invoice';
  elsif inv.status = 'paid' then
    result := 'already_paid';
  elsif inv.status <> 'sent' then
    result := 'not_payable';
  elsif lower(p_currency) is distinct from lower(inv.currency) then
    result := 'amount_mismatch';
  elsif has_schedule then
    if inst.id is null then
      result := 'not_payable';
    elsif inst.status = 'paid' then
      result := 'already_paid';
    elsif p_amount_cents is distinct from inst.amount_cents - gift_card_credit_cents(inv.id, inst.id) then
      result := 'amount_mismatch';
    else
      perform set_config('proofer.marking_paid', 'on', true);
      update invoice_installments set
        status = 'paid',
        paid_at = now(),
        stripe_payment_intent_id = p_payment_intent_id,
        paid_checkout_session_id = p_session_id
      where id = inst.id;
      if not exists (select 1 from invoice_installments where invoice_id = inv.id and status <> 'paid') then
        update invoices set
          status = 'paid',
          paid_at = now(),
          amount_paid_cents = (select sum(amount_cents) from invoice_installments where invoice_id = inv.id),
          stripe_payment_intent_id = p_payment_intent_id,
          paid_checkout_session_id = p_session_id,
          updated_at = now()
        where id = inv.id;
        result := 'paid';
      else
        result := 'installment_paid';
      end if;
      perform set_config('proofer.marking_paid', 'off', true);
    end if;
  elsif p_installment_id is not null then
    result := 'not_payable';
  elsif p_amount_cents is distinct from inv.total_cents - gift_card_credit_cents(inv.id, null) then
    result := 'amount_mismatch';
  else
    perform set_config('proofer.marking_paid', 'on', true);
    update invoices set
      status = 'paid',
      paid_at = now(),
      -- Stripe's amount plus any gift card credit: the whole total.
      amount_paid_cents = total_cents,
      stripe_payment_intent_id = p_payment_intent_id,
      paid_checkout_session_id = p_session_id,
      updated_at = now()
    where id = inv.id;
    perform set_config('proofer.marking_paid', 'off', true);
    result := 'paid';
  end if;

  insert into payment_events (
    stripe_event_id, type, livemode, invoice_id, installment_id, checkout_session_id,
    payment_intent_id, amount_cents, currency, outcome, payload
  ) values (
    p_event_id, p_type, p_livemode, inv.id, p_installment_id, p_session_id,
    p_payment_intent_id, p_amount_cents, lower(p_currency), result, p_payload
  );
  return result;
end;
$$;

revoke all on function record_stripe_event(text, text, boolean, uuid, uuid, text, text, integer, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function record_stripe_event(text, text, boolean, uuid, uuid, text, text, integer, text, boolean, jsonb) to service_role;
revoke all on function redeem_gift_card(text, uuid, text) from public, anon, authenticated;
grant execute on function redeem_gift_card(text, uuid, text) to service_role;
revoke all on function reverse_gift_card_redemption(uuid, text) from public, anon, authenticated;
grant execute on function reverse_gift_card_redemption(uuid, text) to service_role;
revoke all on function void_gift_card(uuid, text) from public, anon, authenticated;
grant execute on function void_gift_card(uuid, text) to service_role;
revoke all on function gift_card_credit_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function gift_card_credit_cents(uuid, uuid) to service_role;
revoke all on function invoice_has_gift_credit(uuid) from public, anon, authenticated;
grant execute on function invoice_has_gift_credit(uuid) to service_role;
revoke all on function invoice_has_paid_installment(uuid) from public, anon, authenticated;
grant execute on function invoice_has_paid_installment(uuid) to service_role;
