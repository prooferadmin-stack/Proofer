-- Gift cards, part 1 (Phase 2.7): setup, online purchase, issue.
-- Spec: specs/phase-2b-gift-cards.md (workstation). Review gate: money.
--
-- Guarantees enforced here, in the database, so no app bug can break them:
--   * A card exists only because issue_gift_card() saw a verified, paid
--     Stripe Checkout for a purchase row, for exactly the price the server
--     fixed when Checkout opened (amount and currency). One card per purchase.
--   * The card's code is generated in the database: DMP + 12 characters from
--     an alphabet without look-alikes, unique, never chosen by a browser.
--   * A card's value, code and origin can never change. Its balance changes
--     only inside the gift card functions, and every change has a row in
--     gift_card_ledger (append-only), so balance = sum of its ledger rows.
--   * Every verified event is still written to payment_events with an
--     outcome, including the ones that issued nothing, so money that arrived
--     for a bad state is visible, never dropped.
--
-- Session cards (David 2026-11-03): the card's value is the session price
-- and the buyer pays that less the session discount (default 20%). Amount
-- cards are sold at their value. So face_cents (what the card is worth) and
-- amount_cents (what Stripe charges) are stored separately on the purchase.

-- Presets: whole $50 steps from $100 to $10,000, no nulls.
create or replace function gift_card_presets_valid(p integer[]) returns boolean
language sql immutable as $fn$
  select coalesce(bool_and(v is not null and v % 5000 = 0 and v between 10000 and 1000000), true)
  from unnest(p) v;
$fn$;

-- Settings: one row, same pattern as brand_settings. Off until David has set
-- it up (at least one active design, checked in the admin action).
create table if not exists gift_card_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  preset_amounts_cents integer[] not null default '{10000,15000,20000,25000,30000,35000,40000,45000,50000}',
  custom_min_cents integer not null default 10000 check (custom_min_cents >= 10000 and custom_min_cents % 100 = 0),
  custom_max_cents integer not null default 200000 check (custom_max_cents % 100 = 0 and custom_max_cents <= 1000000),
  session_discount_percent integer not null default 20 check (session_discount_percent between 0 and 50),
  terms text not null default 'Good toward any David Monroe Photography invoice. Use it all at once or over several invoices; any balance stays on the card. Expires on the date shown, 5 years from purchase. No cash value. An unused card can be refunded within 30 days of purchase; once used, it can''t be refunded.'
    check (length(trim(terms)) between 1 and 2000),
  updated_at timestamptz not null default now(),
  check (custom_max_cents >= custom_min_cents),
  -- Presets: $50 steps, at least the custom minimum, no more than 12 of them.
  check (cardinality(preset_amounts_cents) <= 12),
  check (gift_card_presets_valid(preset_amounts_cents))
);
alter table gift_card_settings enable row level security;
insert into gift_card_settings (id) values (1) on conflict (id) do nothing;

create sequence if not exists gift_card_designs_position_seq;
create table if not exists gift_card_designs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  image_key text check (image_key is null or image_key ~ '^gift-cards/designs/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  active boolean not null default true,
  position bigint not null default nextval('gift_card_designs_position_seq'),
  created_at timestamptz not null default now()
);
alter table gift_card_designs enable row level security;

alter table session_types add column if not exists gift_card_offered boolean not null default false;

-- One row per Checkout attempt. The price is fixed by the server here, before
-- Checkout opens; the webhook compares Stripe's amount against it.
create table if not exists gift_card_purchases (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed')),
  kind text not null check (kind in ('amount', 'session')),
  face_cents integer not null check (face_cents > 0),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= face_cents),
  currency text not null default 'usd' check (currency = lower(currency)),
  session_type_id uuid references session_types(id) on delete set null,
  session_label text check (session_label is null or length(session_label) <= 120),
  design_id uuid not null references gift_card_designs(id) on delete restrict,
  buyer_name text not null check (length(trim(buyer_name)) between 1 and 200),
  buyer_email text not null check (buyer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(buyer_email) <= 200),
  to_name text check (to_name is null or length(to_name) <= 60),
  message text check (message is null or length(message) <= 300),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  check ((status = 'paid') = (paid_at is not null)),
  -- An amount card sells at its value; a session card names its session.
  check (kind = 'session' or amount_cents = face_cents),
  check ((kind = 'session') = (session_label is not null))
);
create index if not exists gift_card_purchases_created_idx on gift_card_purchases (created_at desc);
alter table gift_card_purchases enable row level security;

create table if not exists gift_cards (
  id uuid primary key default gen_random_uuid(),
  -- Stored normalized: DMP + 12 symbols. Shown as DMP-XXXX-XXXX-XXXX.
  code text not null unique check (code ~ '^DMP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$'),
  purchase_id uuid not null unique references gift_card_purchases(id) on delete restrict,
  initial_cents integer not null check (initial_cents > 0),
  balance_cents integer not null,
  currency text not null default 'usd',
  kind text not null check (kind in ('amount', 'session')),
  session_label text,
  design_id uuid not null references gift_card_designs(id) on delete restrict,
  buyer_name text not null,
  buyer_email text not null,
  to_name text,
  message text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'void')),
  voided_at timestamptz,
  void_reason text,
  -- The printable card link carries this, never the spendable code.
  view_token text not null unique check (view_token ~ '^[0-9a-f]{64}$'),
  check (balance_cents between 0 and initial_cents),
  check (expires_at = issued_at + interval '5 years'),
  check ((status = 'void') = (voided_at is not null))
);
create index if not exists gift_cards_issued_idx on gift_cards (issued_at desc);
create index if not exists gift_cards_buyer_email_idx on gift_cards (lower(buyer_email));
alter table gift_cards enable row level security;

create table if not exists gift_card_ledger (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references gift_cards(id) on delete restrict,
  kind text not null check (kind in ('issue', 'redeem', 'reverse', 'void')),
  amount_cents integer not null,
  invoice_id uuid references invoices(id) on delete restrict,
  -- Plain id, like payment_events.installment_id.
  installment_id uuid,
  actor text not null check (actor in ('webhook', 'client', 'admin')),
  stripe_event_id text,
  note text,
  created_at timestamptz not null default now(),
  check (
    (kind = 'issue' and amount_cents > 0) or (kind = 'redeem' and amount_cents < 0)
    or (kind = 'reverse' and amount_cents > 0) or (kind = 'void' and amount_cents <= 0)
  )
);
create index if not exists gift_card_ledger_card_idx on gift_card_ledger (gift_card_id, created_at);
create index if not exists gift_card_ledger_invoice_idx on gift_card_ledger (invoice_id) where invoice_id is not null;
alter table gift_card_ledger enable row level security;

create or replace function gift_card_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'The gift card ledger is append-only';
end;
$$;
drop trigger if exists gift_card_ledger_append_only on gift_card_ledger;
create trigger gift_card_ledger_append_only before update or delete on gift_card_ledger
  for each row execute function gift_card_ledger_append_only();

-- Cards are created and changed only inside the gift card functions, which
-- set proofer.gift_card_write for their own transaction. Even then, what a
-- card is (code, value, purchase, dates, buyer) never changes, and a card is
-- never deleted.
create or replace function gift_cards_guard() returns trigger
language plpgsql as $$
declare
  writing boolean := coalesce(current_setting('proofer.gift_card_write', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception 'A gift card can''t be deleted';
  end if;
  if not writing then
    raise exception 'Gift cards change only through the gift card functions';
  end if;
  if tg_op = 'UPDATE' and (new.id, new.code, new.purchase_id, new.initial_cents, new.currency, new.kind,
        new.session_label, new.design_id, new.buyer_name, new.buyer_email, new.to_name, new.message,
        new.issued_at, new.expires_at, new.view_token)
      is distinct from (old.id, old.code, old.purchase_id, old.initial_cents, old.currency, old.kind,
        old.session_label, old.design_id, old.buyer_name, old.buyer_email, old.to_name, old.message,
        old.issued_at, old.expires_at, old.view_token) then
    raise exception 'A gift card''s code, value and details can''t be changed';
  end if;
  if tg_op = 'UPDATE' and old.status = 'void' then
    raise exception 'A void gift card can''t be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists gift_cards_guard on gift_cards;
create trigger gift_cards_guard before insert or update or delete on gift_cards
  for each row execute function gift_cards_guard();

-- A paid purchase is history: what was bought and for how much stays put.
create or replace function gift_card_purchases_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'paid' or exists (select 1 from gift_cards where purchase_id = old.id) then
      raise exception 'A paid gift card purchase can''t be deleted';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (
       (new.kind, new.face_cents, new.amount_cents, new.currency, new.session_label, new.design_id,
        new.buyer_name, new.buyer_email, new.to_name, new.message, new.created_at)
       is distinct from (old.kind, old.face_cents, old.amount_cents, old.currency, old.session_label, old.design_id,
        old.buyer_name, old.buyer_email, old.to_name, old.message, old.created_at)
       -- session_type_id may only go null (the session type was deleted).
       or (new.session_type_id is distinct from old.session_type_id and new.session_type_id is not null)) then
    raise exception 'A gift card purchase''s price and details can''t be changed';
  end if;
  if tg_op = 'UPDATE' and old.status = 'paid' and new.status <> 'paid' then
    raise exception 'A paid gift card purchase stays paid';
  end if;
  if tg_op = 'UPDATE' and new.status = 'paid' and old.status <> 'paid'
     and coalesce(current_setting('proofer.gift_card_write', true), '') <> 'on' then
    raise exception 'Only a verified Stripe payment can mark a gift card purchase paid';
  end if;
  if tg_op = 'INSERT' and new.status <> 'pending' then
    raise exception 'A gift card purchase starts pending';
  end if;
  -- The Checkout session id is set once, when Checkout opens.
  if tg_op = 'UPDATE' and old.stripe_checkout_session_id is not null
     and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then
    raise exception 'A gift card purchase''s Checkout session can''t be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists gift_card_purchases_guard on gift_card_purchases;
create trigger gift_card_purchases_guard before insert or update or delete on gift_card_purchases
  for each row execute function gift_card_purchases_guard();

-- Payment audit: gift card purchases share payment_events with invoices.
alter table payment_events add column if not exists gift_card_purchase_id uuid;
create index if not exists payment_events_gift_card_purchase_idx on payment_events (gift_card_purchase_id)
  where gift_card_purchase_id is not null;
alter table payment_events drop constraint if exists payment_events_outcome_check;
alter table payment_events add constraint payment_events_outcome_check check (outcome in (
  'paid', 'installment_paid', 'recorded', 'already_paid', 'not_payable', 'amount_mismatch', 'unknown_invoice',
  'gift_card_issued',  -- this event paid for a gift card purchase and issued its card
  'already_issued',    -- a payment for a purchase whose card already exists
  'unknown_purchase'   -- no gift card purchase with the id in the session metadata
));

-- 12 random symbols from the 31-letter alphabet, unbiased: bytes from
-- gen_random_uuid() (only its fully random bytes), keeping those below 248
-- (= 31 * 8) and taking them mod 31. About 59 bits per code.
create or replace function gift_card_random_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  raw bytea;
  b int;
  i int;
  out text := '';
begin
  while length(out) < 12 loop
    raw := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    for i in 0..15 loop
      -- Bytes 6 and 8 carry the uuid version and variant bits.
      continue when i = 6 or i = 8;
      b := get_byte(raw, i);
      continue when b >= 248;
      out := out || substr(alphabet, (b % 31) + 1, 1);
      exit when length(out) = 12;
    end loop;
  end loop;
  return 'DMP' || out;
end;
$$;

-- 64 hex characters (two uuids, 244 random bits) for the printable card link.
create or replace function gift_card_random_token() returns text
language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Records one verified Stripe event for a gift card purchase and, when the
-- money has arrived (p_mark_paid), issues the card, all in one transaction.
-- Returns the outcome, or 'duplicate' if this event id was already recorded.
create or replace function issue_gift_card(
  p_event_id text,
  p_type text,
  p_livemode boolean,
  p_purchase_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text,
  p_mark_paid boolean,
  p_payload jsonb
) returns text
language plpgsql as $$
declare
  pur gift_card_purchases%rowtype;
  card_id uuid;
  issued timestamptz := now();
  tries int := 0;
  result text;
begin
  -- Serialize concurrent deliveries of the same event.
  perform pg_advisory_xact_lock(hashtextextended(p_event_id, 0));
  if exists (select 1 from payment_events where stripe_event_id = p_event_id) then
    return 'duplicate';
  end if;

  if p_purchase_id is not null then
    select * into pur from gift_card_purchases where id = p_purchase_id for update;
  end if;

  if pur.id is null then
    result := 'unknown_purchase';
  elsif exists (select 1 from gift_cards where purchase_id = pur.id) then
    result := case when p_mark_paid then 'already_issued' else 'recorded' end;
  elsif not p_mark_paid then
    -- Abandoned or failed Checkout: the purchase stops being pending.
    if pur.status = 'pending' and p_type in ('checkout.session.expired', 'checkout.session.async_payment_failed') then
      update gift_card_purchases
        set status = case when p_type = 'checkout.session.expired' then 'expired' else 'failed' end
        where id = pur.id;
    end if;
    result := 'recorded';
  elsif pur.stripe_checkout_session_id is distinct from p_session_id then
    -- Paid through a session this purchase never opened.
    result := 'not_payable';
  elsif p_amount_cents is distinct from pur.amount_cents
        or lower(p_currency) is distinct from pur.currency then
    result := 'amount_mismatch';
  else
    perform set_config('proofer.gift_card_write', 'on', true);
    update gift_card_purchases set
      status = 'paid',
      paid_at = issued,
      stripe_payment_intent_id = p_payment_intent_id
    where id = pur.id;
    loop
      begin
        insert into gift_cards (
          code, purchase_id, initial_cents, balance_cents, currency, kind, session_label, design_id,
          buyer_name, buyer_email, to_name, message, issued_at, expires_at, view_token
        ) values (
          gift_card_random_code(), pur.id, pur.face_cents, pur.face_cents, pur.currency, pur.kind,
          pur.session_label, pur.design_id, pur.buyer_name, pur.buyer_email, pur.to_name, pur.message,
          issued, issued + interval '5 years', gift_card_random_token()
        ) returning id into card_id;
        exit;
      exception when unique_violation then
        -- A code (or token) collision: draw again. purchase_id is locked
        -- above and checked, so it can't be the column that collided.
        tries := tries + 1;
        if tries >= 5 then
          raise;
        end if;
      end;
    end loop;
    insert into gift_card_ledger (gift_card_id, kind, amount_cents, actor, stripe_event_id, note)
      values (card_id, 'issue', pur.face_cents, 'webhook', p_event_id,
              case when pur.amount_cents < pur.face_cents
                   then 'Sold at the session card discount for $' || trim(to_char(pur.amount_cents / 100.0, '999999990.00')) end);
    perform set_config('proofer.gift_card_write', 'off', true);
    result := 'gift_card_issued';
  end if;

  insert into payment_events (
    stripe_event_id, type, livemode, invoice_id, gift_card_purchase_id, checkout_session_id,
    payment_intent_id, amount_cents, currency, outcome, payload
  ) values (
    p_event_id, p_type, p_livemode, null, p_purchase_id, p_session_id,
    p_payment_intent_id, p_amount_cents, lower(p_currency), result, p_payload
  );
  return result;
end;
$$;

-- Callable by the service role only (the webhook's server code).
revoke all on function issue_gift_card(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function issue_gift_card(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb) to service_role;
revoke all on function gift_card_random_code() from public, anon, authenticated;
grant execute on function gift_card_random_code() to service_role;
revoke all on function gift_card_random_token() from public, anon, authenticated;
grant execute on function gift_card_random_token() to service_role;
