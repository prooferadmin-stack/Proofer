-- Paid extra downloads (Phase 5.7). Spec: specs/phase-5b-paid-downloads.md
-- (workstation). Review gate: money.
--
-- Guarantees enforced here, in the database:
--   * The price, the photos and the amount are decided by
--     start_download_purchase() from the gallery's own rows; nothing the
--     browser sends sets a price or a count.
--   * Free downloads are used first (David 2026-11-07): the photos that fit in
--     the buyer's remaining free allowance are granted free, following the
--     same rules as claim_download (0021); only the rest is charged.
--   * A purchase is fulfilled only by fulfill_download_purchase(), for a
--     verified, paid Stripe Checkout of that purchase, for exactly its amount
--     and currency. One purchase makes one paid invoice and one set of grants;
--     replayed events change nothing.
--   * Every verified event is written to payment_events with an outcome,
--     including the ones that granted nothing.

-- Per-photo price David sets on each gallery. Null = buying is off.
alter table collections add column if not exists extra_download_price_cents integer
  check (extra_download_price_cents is null or (extra_download_price_cents between 100 and 50000));

-- Which grants were bought, so admin can tell them apart.
alter table download_grants add column if not exists source text not null default 'free'
  check (source in ('free', 'purchase'));

create table if not exists download_purchases (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references collections(id) on delete restrict,
  visitor_key text not null check (visitor_key = lower(visitor_key) and visitor_key ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(visitor_key) <= 254),
  asset_ids uuid[] not null check (cardinality(asset_ids) between 1 and 500),
  unit_cents integer not null check (unit_cents between 100 and 50000),
  photo_count integer not null check (photo_count = cardinality(asset_ids)),
  amount_cents integer not null,
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  invoice_id uuid unique references invoices(id) on delete restrict,
  granted_count integer,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  check (amount_cents = unit_cents * photo_count),
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'paid') = (invoice_id is not null))
);
create index if not exists download_purchases_collection_idx on download_purchases (collection_id, created_at desc);
alter table download_purchases enable row level security;

alter table download_grants add column if not exists download_purchase_id uuid references download_purchases(id) on delete set null;
alter table payment_events add column if not exists download_purchase_id uuid references download_purchases(id) on delete set null;
create index if not exists payment_events_download_purchase_idx on payment_events (download_purchase_id)
  where download_purchase_id is not null;
alter table payment_events drop constraint if exists payment_events_outcome_check;
alter table payment_events add constraint payment_events_outcome_check check (outcome in (
  'paid', 'installment_paid', 'recorded', 'already_paid', 'not_payable', 'amount_mismatch', 'unknown_invoice',
  'gift_card_issued', 'already_issued', 'unknown_purchase',
  'downloads_granted',  -- this event paid for a download purchase: invoice made, photos granted
  'already_fulfilled',  -- a payment for a download purchase that was already fulfilled
  'no_project'          -- paid, but the gallery lost its project/client link; nothing granted
));

-- What a gallery offers and why not. Shared by the page (via the app) and the
-- start function, so they can't disagree.
create or replace function download_purchase_blocker(p_collection_id uuid) returns text
language sql stable as $fn$
  select case
    when c.id is null then 'not_found'
    when c.status <> 'published' then 'not_published'
    when not c.downloads_enabled then 'downloads_off'
    when c.download_limit is null and c.per_person_download_limit is null then 'no_limit'
    when c.extra_download_price_cents is null then 'no_price'
    when c.project_id is null then 'no_project'
    when coalesce(p.contact_id, c.contact_id) is null then 'no_contact'
    else null
  end
  from (select 1) one
  left join collections c on c.id = p_collection_id
  left join projects p on p.id = c.project_id;
$fn$;

-- Starts a purchase for the photos a visitor picked (or every photo they
-- can't download yet, when p_all). Grants the free ones first, then records a
-- pending purchase for the rest. Returns {ok, reason?, free_granted,
-- purchase_id?, photo_count?, unit_cents?, amount_cents?}.
create or replace function start_download_purchase(
  p_collection_id uuid,
  p_visitor_key text,
  p_asset_ids uuid[],
  p_all boolean
) returns jsonb
language plpgsql as $$
declare
  c collections%rowtype;
  blocker text;
  visitor text := lower(trim(coalesce(p_visitor_key, '')));
  candidate uuid;
  to_buy uuid[] := '{}';
  free_count integer := 0;
  used integer;
  free_ok boolean;
  purchase_id uuid;
begin
  if visitor !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(visitor) > 254 then
    return jsonb_build_object('ok', false, 'reason', 'need_email');
  end if;
  -- Same lock claim_download takes, so free grants here and there can't race.
  select * into c from collections where id = p_collection_id for update;
  blocker := download_purchase_blocker(p_collection_id);
  if blocker is not null then
    return jsonb_build_object('ok', false, 'reason', blocker);
  end if;

  -- Buyable: uploaded, in a downloadable set, not already granted to this
  -- visitor. Gallery order, each photo once; the picked list is only a filter.
  for candidate in
    select ma.id
    from media_assets ma
    join photo_sets ps on ps.id = ma.set_id
    where ma.collection_id = c.id
      and ma.status = 'uploaded'
      and ps.downloadable
      and (p_all or ma.id = any (coalesce(p_asset_ids, '{}')))
      and not exists (select 1 from download_grants g where g.asset_id = ma.id and g.visitor_key = visitor)
    order by ps.position, ma.position, ma.id
  loop
    -- Free first, by claim_download's own rules.
    free_ok := true;
    if c.download_limit is not null and not exists (select 1 from download_grants where asset_id = candidate) then
      select count(distinct asset_id) into used from download_grants where collection_id = c.id;
      if used >= c.download_limit then free_ok := false; end if;
    end if;
    if free_ok and c.per_person_download_limit is not null then
      select count(*) into used from download_grants where collection_id = c.id and visitor_key = visitor;
      if used >= c.per_person_download_limit then free_ok := false; end if;
    end if;
    if free_ok then
      insert into download_grants (collection_id, asset_id, visitor_key, source)
        values (c.id, candidate, visitor, 'free')
        on conflict (asset_id, visitor_key) do nothing;
      free_count := free_count + 1;
    else
      to_buy := to_buy || candidate;
    end if;
  end loop;

  if cardinality(to_buy) = 0 then
    return jsonb_build_object('ok', true, 'free_granted', free_count, 'purchase_id', null);
  end if;
  if cardinality(to_buy) > 500 then
    return jsonb_build_object('ok', false, 'reason', 'too_many', 'free_granted', free_count);
  end if;

  insert into download_purchases (collection_id, visitor_key, asset_ids, unit_cents, photo_count, amount_cents)
    values (c.id, visitor, to_buy, c.extra_download_price_cents, cardinality(to_buy),
            c.extra_download_price_cents * cardinality(to_buy))
    returning id into purchase_id;
  return jsonb_build_object('ok', true, 'free_granted', free_count, 'purchase_id', purchase_id,
                            'photo_count', cardinality(to_buy), 'unit_cents', c.extra_download_price_cents,
                            'amount_cents', c.extra_download_price_cents * cardinality(to_buy));
end;
$$;

-- The verified webhook's only way to fulfil a purchase. Same contract shape
-- as issue_gift_card (0032): writes the audit row and returns its outcome.
create or replace function fulfill_download_purchase(
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
  pur download_purchases%rowtype;
  col collections%rowtype;
  proj projects%rowtype;
  inv_id uuid;
  granted integer := 0;
  n integer;
  asset uuid;
  result text;
  now_ts timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_event_id, 0));
  if exists (select 1 from payment_events where stripe_event_id = p_event_id) then
    return 'duplicate';
  end if;

  if p_purchase_id is not null then
    select * into pur from download_purchases where id = p_purchase_id for update;
  end if;

  if pur.id is null then
    result := 'unknown_purchase';
  elsif pur.status = 'paid' then
    result := case when p_mark_paid then 'already_fulfilled' else 'recorded' end;
  elsif not p_mark_paid then
    if pur.status = 'pending' and p_type in ('checkout.session.expired', 'checkout.session.async_payment_failed') then
      update download_purchases
        set status = case when p_type = 'checkout.session.expired' then 'expired' else 'failed' end
        where id = pur.id;
    end if;
    result := 'recorded';
  elsif pur.stripe_checkout_session_id is distinct from p_session_id then
    result := 'not_payable';
  elsif p_amount_cents is distinct from pur.amount_cents or lower(p_currency) is distinct from pur.currency then
    result := 'amount_mismatch';
  else
    select * into col from collections where id = pur.collection_id;
    select * into proj from projects where id = col.project_id;
    if proj.id is null or coalesce(proj.contact_id, col.contact_id) is null then
      -- The gallery was unlinked after Checkout opened. Money is recorded
      -- with this outcome so David sees it; nothing is granted.
      result := 'no_project';
    else
      -- The invoice: created sent, its one line added, then marked paid in
      -- the same transaction (the paid guards only allow that while
      -- proofer.marking_paid is on).
      insert into invoices (project_id, contact_id, status, currency, subtotal_cents, total_cents, notes)
        values (proj.id, coalesce(proj.contact_id, col.contact_id), 'sent', pur.currency,
                pur.amount_cents, pur.amount_cents,
                'Extra downloads bought online from the gallery "' || col.name || '" by ' || pur.visitor_key || '.')
        returning id into inv_id;
      insert into invoice_line_items (invoice_id, description, quantity, unit_price_cents, position)
        values (inv_id, 'Extra downloads, ' || col.name || ' (bought by ' || pur.visitor_key || ')',
                pur.photo_count, pur.unit_cents, 0);
      perform set_config('proofer.marking_paid', 'on', true);
      update invoices set
        status = 'paid',
        paid_at = now_ts,
        amount_paid_cents = pur.amount_cents,
        stripe_payment_intent_id = p_payment_intent_id,
        paid_checkout_session_id = p_session_id,
        updated_at = now_ts
      where id = inv_id;
      perform set_config('proofer.marking_paid', 'off', true);

      -- Grants for every bought photo that still exists, whatever the limits.
      foreach asset in array pur.asset_ids loop
        if exists (select 1 from media_assets where id = asset and collection_id = pur.collection_id) then
          insert into download_grants (collection_id, asset_id, visitor_key, source, download_purchase_id)
            values (pur.collection_id, asset, pur.visitor_key, 'purchase', pur.id)
            on conflict (asset_id, visitor_key) do nothing;
          get diagnostics n = row_count;
          granted := granted + n;
        end if;
      end loop;

      update download_purchases set
        status = 'paid', paid_at = now_ts, invoice_id = inv_id,
        stripe_payment_intent_id = p_payment_intent_id, granted_count = granted
      where id = pur.id;
      result := 'downloads_granted';
    end if;
  end if;

  insert into payment_events (
    stripe_event_id, type, livemode, invoice_id, download_purchase_id, checkout_session_id,
    payment_intent_id, amount_cents, currency, outcome, payload
  ) values (
    p_event_id, p_type, p_livemode, inv_id, p_purchase_id, p_session_id,
    p_payment_intent_id, p_amount_cents, lower(p_currency), result, p_payload
  );
  return result;
end;
$$;

revoke all on function download_purchase_blocker(uuid) from public, anon, authenticated;
grant execute on function download_purchase_blocker(uuid) to service_role;
revoke all on function start_download_purchase(uuid, text, uuid[], boolean) from public, anon, authenticated;
grant execute on function start_download_purchase(uuid, text, uuid[], boolean) to service_role;
revoke all on function fulfill_download_purchase(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function fulfill_download_purchase(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb) to service_role;
