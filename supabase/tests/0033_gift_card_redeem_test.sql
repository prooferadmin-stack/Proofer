-- Database tests for 0033_gift_card_redeem.sql (Phase 2.8). Run against a
-- scratch database with every migration applied:
--   psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/tests/0033_gift_card_redeem_test.sql
-- One transaction, rolled back. "ALL REDEEM TESTS PASSED" means every check held.
-- The concurrent-redemption check needs two sessions; see the bottom.
begin;

create or replace function pg_temp.expect_error(sql text, needle text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(needle in sqlerrm) = 0 then
      raise exception 'expected error containing "%", got "%" from: %', needle, sqlerrm, sql;
    end if;
    return;
  end;
  raise exception 'expected an error containing "%" from: %', needle, sql;
end;
$$;

-- A paid card worth p_cents; returns its stored code.
create or replace function pg_temp.card(p_cents int) returns text
language plpgsql as $$
declare d uuid; p uuid; sid text := 'cs_' || replace(gen_random_uuid()::text, '-', ''); r text;
begin
  select id into d from gift_card_designs limit 1;
  if d is null then insert into gift_card_designs (name) values ('t') returning id into d; end if;
  insert into gift_card_purchases (kind, face_cents, amount_cents, design_id, buyer_name, buyer_email, stripe_checkout_session_id)
    values ('amount', p_cents, p_cents, d, 'B', 'b@x.co', sid) returning id into p;
  r := issue_gift_card('evt_' || sid, 'checkout.session.completed', false, p, sid, 'pi_' || sid, p_cents, 'usd', true, '{}');
  assert r = 'gift_card_issued', 'card setup: ' || r;
  return (select code from gift_cards where purchase_id = p);
end;
$$;

-- A sent invoice for p_total; with p_schedule, installments of those amounts.
create or replace function pg_temp.invoice(p_total int, p_schedule int[] default null, p_status text default 'sent') returns uuid
language plpgsql as $$
declare c uuid; pr uuid; i uuid; n int := 0; a int;
begin
  insert into contacts (name) values ('Client') returning id into c;
  insert into projects (title, contact_id) values ('Shoot', c) returning id into pr;
  insert into invoices (project_id, contact_id, status, subtotal_cents, total_cents) values (pr, c, 'draft', p_total, p_total) returning id into i;
  insert into invoice_line_items (invoice_id, description, unit_price_cents) values (i, 'Session', p_total);
  if p_schedule is not null then
    foreach a in array p_schedule loop
      n := n + 1;
      insert into invoice_installments (invoice_id, position, label, amount_cents) values (i, n, 'Part ' || n, a);
    end loop;
  end if;
  if p_status <> 'draft' then update invoices set status = p_status where id = i; end if;
  return i;
end;
$$;

create or replace function pg_temp.pay(p_event text, p_invoice uuid, p_inst uuid, p_cents int) returns text
language sql as $$
  select record_stripe_event(p_event, 'checkout.session.completed', false, p_invoice, p_inst, 'cs_' || p_event, 'pi_' || p_event, p_cents, 'usd', true, '{}');
$$;

create or replace function pg_temp.inst(p_invoice uuid, p_pos int) returns uuid
language sql as $$ select id from invoice_installments where invoice_id = p_invoice and position = p_pos; $$;

do $$
declare
  inv uuid; inv2 uuid; inv3 uuid; sched uuid; drafted uuid;
  k text; k2 text; k3 text;
  res jsonb; r text; lid uuid; cid uuid;
begin
  ---------------------------------------------------------------------------
  -- record_stripe_event: every existing outcome, no gift cards involved.
  inv := pg_temp.invoice(53500);
  assert pg_temp.pay('e1', inv, null, 50000) = 'amount_mismatch', 'plain mismatch';
  assert pg_temp.pay('e2', inv, null, 53500) = 'paid', 'plain paid';
  assert (select amount_paid_cents from invoices where id = inv) = 53500, 'plain amount paid';
  assert pg_temp.pay('e2', inv, null, 53500) = 'duplicate', 'duplicate';
  assert pg_temp.pay('e3', inv, null, 53500) = 'already_paid', 'already paid';
  assert pg_temp.pay('e4', gen_random_uuid(), null, 100) = 'unknown_invoice', 'unknown';
  assert record_stripe_event('e4b', 'checkout.session.completed', false, null, null, 'cs', 'pi', 100, 'usd', true, '{}') = 'unknown_invoice', 'no invoice';
  drafted := pg_temp.invoice(1000, null, 'draft');
  assert pg_temp.pay('e5', drafted, null, 1000) = 'not_payable', 'draft';
  assert record_stripe_event('e6', 'checkout.session.expired', false, drafted, null, 'cs', null, 1000, 'usd', false, '{}') = 'recorded', 'recorded';
  assert record_stripe_event('e6b', 'checkout.session.completed', false, drafted, null, 'cs', 'pi', 1000, 'eur', true, '{}') = 'not_payable', 'draft wins over currency';
  inv := pg_temp.invoice(1000);
  assert record_stripe_event('e6c', 'checkout.session.completed', false, inv, null, 'cs', 'pi', 1000, 'eur', true, '{}') = 'amount_mismatch', 'currency';
  assert pg_temp.pay('e6d', inv, gen_random_uuid(), 1000) = 'not_payable', 'installment on a plain invoice';
  sched := pg_temp.invoice(50000, array[20000, 30000]);
  assert pg_temp.pay('e7', sched, null, 20000) = 'not_payable', 'schedule without installment';
  assert pg_temp.pay('e8', sched, pg_temp.inst(sched, 1), 30000) = 'amount_mismatch', 'installment mismatch';
  assert pg_temp.pay('e9', sched, pg_temp.inst(sched, 1), 20000) = 'installment_paid', 'installment paid';
  assert pg_temp.pay('e10', sched, pg_temp.inst(sched, 1), 20000) = 'already_paid', 'installment already paid';
  assert pg_temp.pay('e11', sched, pg_temp.inst(sched, 2), 30000) = 'paid', 'last installment';
  assert (select amount_paid_cents from invoices where id = sched) = 50000, 'schedule amount paid';

  ---------------------------------------------------------------------------
  -- A $500 card on an $850 invoice: all of it applies, $350 is left to pay.
  k := pg_temp.card(50000);
  inv := pg_temp.invoice(85000);
  res := redeem_gift_card(lower(substr(k, 1, 7)) || '-' || substr(k, 8), inv, 'client');
  assert (res->>'ok')::boolean and (res->>'applied_cents')::int = 50000 and (res->>'balance_cents')::int = 0
     and not (res->>'invoice_paid')::boolean, 'partial: ' || res;
  assert gift_card_credit_cents(inv, null) = 50000, 'credit';
  -- Stripe must charge the amount due, not the old total.
  assert pg_temp.pay('g1', inv, null, 85000) = 'amount_mismatch', 'old total after credit';
  assert (select status from invoices where id = inv) = 'sent', 'not paid by the wrong amount';
  assert pg_temp.pay('g2', inv, null, 35000) = 'paid', 'amount due';
  assert (select amount_paid_cents from invoices where id = inv) = 85000, 'paid records the whole total';
  -- An empty card is refused.
  assert redeem_gift_card(k, pg_temp.invoice(1000), 'client')->>'reason' = 'empty', 'empty';

  -- A $500 card: pays a $350 invoice in full (no Stripe), keeps $150, then pays a $100 one.
  k2 := pg_temp.card(50000);
  inv2 := pg_temp.invoice(35000);
  res := redeem_gift_card(k2, inv2, 'client');
  assert (res->>'applied_cents')::int = 35000 and (res->>'balance_cents')::int = 15000 and (res->>'invoice_paid')::boolean, 'full: ' || res;
  assert (select status = 'paid' and amount_paid_cents = 35000 and stripe_payment_intent_id is null from invoices where id = inv2), 'paid by card';
  inv3 := pg_temp.invoice(10000);
  res := redeem_gift_card(k2, inv3, 'admin');
  assert (res->>'applied_cents')::int = 10000 and (res->>'balance_cents')::int = 5000, 'second invoice: ' || res;
  assert (select balance_cents from gift_cards where code = k2) = 5000, 'balance';
  assert (select count(*) from gift_card_ledger l join gift_cards c on c.id = l.gift_card_id where c.code = k2 and l.kind = 'redeem' and l.actor = 'admin') = 1, 'actor';
  -- Paid invoices take no more card.
  assert redeem_gift_card(k2, inv2, 'client')->>'reason' = 'invoice_not_payable', 'paid invoice';

  -- Schedule: $250 card on $200 + $300. Part 1 paid by card, $50 off part 2.
  k3 := pg_temp.card(25000);
  sched := pg_temp.invoice(50000, array[20000, 30000]);
  res := redeem_gift_card(k3, sched, 'client');
  assert (res->>'applied_cents')::int = 25000 and (res->>'covered')::int = 1 and not (res->>'invoice_paid')::boolean, 'schedule: ' || res;
  assert (select status from invoice_installments where id = pg_temp.inst(sched, 1)) = 'paid', 'part 1 paid by card';
  assert gift_card_credit_cents(sched, pg_temp.inst(sched, 2)) = 5000, 'part 2 credit';
  assert pg_temp.pay('g3', sched, pg_temp.inst(sched, 2), 30000) = 'amount_mismatch', 'part 2 old amount';
  assert pg_temp.pay('g4', sched, pg_temp.inst(sched, 2), 25000) = 'paid', 'part 2 amount due';
  assert (select amount_paid_cents from invoices where id = sched) = 50000, 'schedule total paid';

  -- A card covering a whole schedule marks the invoice paid.
  k3 := pg_temp.card(60000);
  sched := pg_temp.invoice(50000, array[20000, 30000]);
  res := redeem_gift_card(k3, sched, 'admin');
  assert (res->>'invoice_paid')::boolean and (res->>'covered')::int = 2 and (res->>'balance_cents')::int = 10000, 'whole schedule: ' || res;

  ---------------------------------------------------------------------------
  -- Refusals change nothing.
  inv := pg_temp.invoice(1000);
  assert redeem_gift_card('DMP-2222-2222-2222', inv, 'client')->>'reason' = 'not_found', 'not found';
  assert redeem_gift_card('', inv, 'client')->>'reason' = 'not_found', 'blank';
  assert redeem_gift_card(k3, pg_temp.invoice(1000, null, 'draft'), 'client')->>'reason' = 'invoice_not_payable', 'draft';
  assert redeem_gift_card(k3, gen_random_uuid(), 'client')->>'reason' = 'invoice_not_payable', 'no invoice';
  perform pg_temp.expect_error(format('select redeem_gift_card(%L, %L, %L)', k3, inv, 'webhook'), 'Unknown actor');
  update invoices set currency = 'eur' where id = inv;
  assert redeem_gift_card(k3, inv, 'client')->>'reason' = 'currency', 'currency';
  -- Booking on hold.
  inv := pg_temp.invoice(1000);
  insert into session_types (name, slug, duration_minutes, price_cents) values ('S', 'gc-redeem-test', 60, 1000) returning id into cid;
  insert into bookings (session_type_id, invoice_id, starts_at, ends_at, blocked_from, blocked_until, timezone, hold_expires_at)
    values (cid, inv, now() + interval '2 days', now() + interval '2 days 1 hour', now() + interval '2 days', now() + interval '2 days 1 hour',
            'America/New_York', now() + interval '20 minutes');
  assert redeem_gift_card(k3, inv, 'client')->>'reason' = 'booking_hold', 'booking hold';
  assert (select balance_cents from gift_cards where code = k3) = 10000, 'refusals spent nothing';
  -- Expired card (dates moved back past 5 years with the guard off).
  k := pg_temp.card(1000);
  alter table gift_cards disable trigger gift_cards_guard;
  update gift_cards set issued_at = now() - interval '6 years', expires_at = now() - interval '1 year' where code = k;
  alter table gift_cards enable trigger gift_cards_guard;
  assert redeem_gift_card(k, pg_temp.invoice(1000), 'client')->>'reason' = 'expired', 'expired';

  ---------------------------------------------------------------------------
  -- Freeze: live credit locks the invoice like a paid installment.
  k := pg_temp.card(30000);
  inv := pg_temp.invoice(50000);
  res := redeem_gift_card(k, inv, 'client');
  perform pg_temp.expect_error(format('update invoices set notes = %L where id = %L', 'x', inv), 'can''t be changed');
  perform pg_temp.expect_error(format('update invoices set status = %L where id = %L', 'void', inv), 'can''t be changed');
  perform pg_temp.expect_error(format('delete from invoices where id = %L', inv), 'can''t be deleted');
  perform pg_temp.expect_error(format('insert into invoice_line_items (invoice_id, description) values (%L, %L)', inv, 'x'), 'line items can''t be changed');
  perform pg_temp.expect_error(format('insert into invoice_installments (invoice_id, position, label, amount_cents) values (%L, 1, %L, 100)', inv, 'x'), 'schedule can''t be changed');
  -- Opening Checkout still records its session id.
  update invoices set stripe_checkout_session_id = 'cs_open', updated_at = now() where id = inv;
  -- Nobody but the functions writes the ledger's money.
  perform pg_temp.expect_error(format('update gift_card_ledger set amount_cents = -1 where invoice_id = %L', inv), 'append-only');

  -- Undo: credit gone, balance back, invoice editable again.
  select id into lid from gift_card_ledger where invoice_id = inv and kind = 'redeem';
  assert reverse_gift_card_redemption(lid, 'wrong invoice') = 'undone', 'undo';
  assert gift_card_credit_cents(inv, null) = 0 and (select balance_cents from gift_cards where code = k) = 30000, 'undo restored';
  assert reverse_gift_card_redemption(lid, null) = 'already_undone', 'undo twice';
  assert reverse_gift_card_redemption(gen_random_uuid(), null) = 'not_found', 'undo unknown';
  update invoices set notes = 'editable again' where id = inv;
  -- Undo is refused once the target is paid.
  res := redeem_gift_card(k, inv, 'client');
  select id into lid from gift_card_ledger where invoice_id = inv and kind = 'redeem' and id <> lid;
  assert pg_temp.pay('g5', inv, null, 20000) = 'paid', 'rest paid';
  assert reverse_gift_card_redemption(lid, null) = 'target_paid', 'undo after paid';
  -- Undo on an installment that is paid is refused; on one still unpaid it works.
  k := pg_temp.card(25000);
  sched := pg_temp.invoice(50000, array[20000, 30000]);
  res := redeem_gift_card(k, sched, 'client');
  select id into lid from gift_card_ledger where invoice_id = sched and installment_id = pg_temp.inst(sched, 1);
  assert reverse_gift_card_redemption(lid, null) = 'target_paid', 'undo paid installment';
  select id into lid from gift_card_ledger where invoice_id = sched and installment_id = pg_temp.inst(sched, 2);
  assert reverse_gift_card_redemption(lid, null) = 'undone', 'undo unpaid installment';
  assert pg_temp.pay('g6', sched, pg_temp.inst(sched, 2), 30000) = 'paid', 'full amount due again after undo';

  ---------------------------------------------------------------------------
  -- Void for refund: only untouched cards within 30 days.
  k := pg_temp.card(20000);
  select id into cid from gift_cards where code = k;
  assert void_gift_card(cid, 'Refunded at buyer''s request') = 'voided', 'void';
  assert (select status = 'void' and balance_cents = 0 and voided_at is not null from gift_cards where id = cid), 'void state';
  assert void_gift_card(cid, null) = 'already_void', 'void twice';
  assert redeem_gift_card(k, pg_temp.invoice(1000), 'client')->>'reason' = 'void', 'void card refused';
  assert void_gift_card(gen_random_uuid(), null) = 'not_found', 'void unknown';
  -- Used (even if the use was undone) can't be voided.
  k := pg_temp.card(20000);
  select id into cid from gift_cards where code = k;
  inv := pg_temp.invoice(5000);
  res := redeem_gift_card(k, inv, 'client');
  assert void_gift_card(cid, null) = 'used', 'used';
  select id into lid from gift_card_ledger where gift_card_id = cid and kind = 'redeem';
  perform reverse_gift_card_redemption(lid, null);
  -- inv was fully paid by the card, so that undo is refused; card stays used.
  assert void_gift_card(cid, null) = 'used', 'used after attempted undo';
  -- Older than 30 days.
  k := pg_temp.card(20000);
  alter table gift_cards disable trigger gift_cards_guard;
  update gift_cards set issued_at = now() - interval '31 days', expires_at = now() - interval '31 days' + interval '5 years' where code = k;
  alter table gift_cards enable trigger gift_cards_guard;
  select id into cid from gift_cards where code = k;
  assert void_gift_card(cid, null) = 'too_late', 'too late';

  ---------------------------------------------------------------------------
  -- Every card's balance equals the sum of its ledger rows.
  assert not exists (
    select 1 from gift_cards c
    where c.balance_cents <> (select coalesce(sum(amount_cents), 0) from gift_card_ledger l where l.gift_card_id = c.id)
  ), 'ledger sum != balance';
  -- Only the service role may call the new functions.
  assert not has_function_privilege('anon', 'redeem_gift_card(text, uuid, text)', 'execute'), 'anon can redeem';
  assert not has_function_privilege('authenticated', 'void_gift_card(uuid, text)', 'execute'), 'authenticated can void';
  assert not has_function_privilege('anon', 'reverse_gift_card_redemption(uuid, text)', 'execute'), 'anon can undo';
  assert has_function_privilege('service_role', 'redeem_gift_card(text, uuid, text)', 'execute'), 'service role cannot redeem';

  raise notice 'ALL REDEEM TESTS PASSED';
end;
$$;

rollback;
