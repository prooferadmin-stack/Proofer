-- Database tests for 0034_paid_downloads.sql (Phase 5.7). Run against a
-- scratch database with every migration applied:
--   psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/tests/0034_paid_downloads_test.sql
-- One transaction, rolled back. "ALL PAID DOWNLOAD TESTS PASSED" means every check held.
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void
language plpgsql as $$
begin
  if not coalesce(ok, false) then
    raise exception 'FAILED: %', what;
  end if;
end;
$$;

-- A gallery with 10 photos, per-person limit 3, $15 a photo, linked to a project.
create temp table t_ids (k text primary key, id uuid);
do $$
declare
  ct uuid; pr uuid; col uuid; st uuid; col2 uuid; st2 uuid; other uuid; ost uuid; i int; a uuid;
begin
  insert into contacts (name, email) values ('Client', 'client@example.com') returning id into ct;
  insert into projects (title, contact_id) values ('Shoot', ct) returning id into pr;
  insert into collections (name, slug, status, project_id, per_person_download_limit, extra_download_price_cents)
    values ('Shoot gallery', 'pd-test-1', 'published', pr, 3, 1500) returning id into col;
  insert into photo_sets (collection_id, name) values (col, 'All') returning id into st;
  for i in 1..10 loop
    insert into media_assets (collection_id, set_id, r2_key, original_filename, content_type, size_bytes, status)
      values (col, st, 'pd-test/' || i, 'p' || i || '.jpg', 'image/jpeg', 100, 'uploaded') returning id into a;
    insert into t_ids values ('a' || i, a);
  end loop;
  -- A second gallery: gallery-wide limit 2, no per-person limit.
  insert into collections (name, slug, status, project_id, download_limit, extra_download_price_cents)
    values ('Wide gallery', 'pd-test-2', 'published', pr, 2, 1000) returning id into col2;
  insert into photo_sets (collection_id, name) values (col2, 'All') returning id into st2;
  for i in 1..5 loop
    insert into media_assets (collection_id, set_id, r2_key, original_filename, content_type, size_bytes, status)
      values (col2, st2, 'pd-test2/' || i, 'q' || i || '.jpg', 'image/jpeg', 100, 'uploaded') returning id into a;
    insert into t_ids values ('b' || i, a);
  end loop;
  -- A photo in some other gallery, to try smuggling into a purchase.
  insert into collections (name, slug, status) values ('Other', 'pd-test-3', 'published') returning id into other;
  insert into photo_sets (collection_id, name) values (other, 'All') returning id into ost;
  insert into media_assets (collection_id, set_id, r2_key, original_filename, content_type, size_bytes, status)
    values (other, ost, 'pd-test3/1', 'x.jpg', 'image/jpeg', 100, 'uploaded') returning id into a;
  insert into t_ids values ('col', col), ('col2', col2), ('st', st), ('pr', pr), ('ct', ct), ('foreign', a);
end $$;

create or replace function pg_temp.id(key text) returns uuid language sql as $$ select id from t_ids where k = key $$;
create or replace function pg_temp.fulfil(ev text, pur uuid, sess text, amt int, cur text default 'usd', paid boolean default true, typ text default 'checkout.session.completed')
returns text language sql as $$
  select fulfill_download_purchase(ev, typ, false, pur, sess, 'pi_' || ev, amt, cur, paid, '{}'::jsonb)
$$;

do $$
declare
  r jsonb; pur uuid; out text; inv invoices%rowtype; n int; s text;
  col uuid := pg_temp.id('col');
  picked uuid[];
begin
  -- Offer check.
  perform pg_temp.check(download_purchase_blocker(col) is null, 'gallery offers buying');
  perform pg_temp.check((start_download_purchase(col, 'not-an-email', null, true))->>'reason' = 'need_email', 'email required');

  -- 10 picked (plus a photo from another gallery): 3 free first, 7 to buy.
  select array_agg(id) || pg_temp.id('foreign') into picked from t_ids where k like 'a%';
  r := start_download_purchase(col, 'Buyer@Example.com', picked, false);
  perform pg_temp.check((r->>'ok')::boolean, 'start ok');
  perform pg_temp.check((r->>'free_granted')::int = 3, 'free first: 3 free, got ' || (r->>'free_granted'));
  perform pg_temp.check((r->>'photo_count')::int = 7, '7 to buy, got ' || (r->>'photo_count'));
  perform pg_temp.check((r->>'amount_cents')::int = 10500, 'amount = 7 x 1500');
  pur := (r->>'purchase_id')::uuid;
  perform pg_temp.check(not exists (select 1 from download_purchases where id = pur and pg_temp.id('foreign') = any (asset_ids)), 'foreign photo not sold');
  select count(*) into n from download_grants where collection_id = col and visitor_key = 'buyer@example.com' and source = 'free';
  perform pg_temp.check(n = 3, 'three free grants, email lowercased');

  -- Fulfilment refusals: no session saved yet, then wrong amount, wrong currency.
  out := pg_temp.fulfil('ev1', pur, 'cs_1', 10500);
  perform pg_temp.check(out = 'not_payable', 'session not the purchase''s own: ' || out);
  update download_purchases set stripe_checkout_session_id = 'cs_1' where id = pur;
  perform pg_temp.check(pg_temp.fulfil('ev2', pur, 'cs_1', 9000) = 'amount_mismatch', 'amount mismatch');
  perform pg_temp.check(pg_temp.fulfil('ev3', pur, 'cs_1', 10500, 'eur') = 'amount_mismatch', 'currency mismatch');
  perform pg_temp.check(pg_temp.fulfil('ev3b', pur, 'cs_1', 10500, 'usd', false) = 'recorded', 'unpaid completed event only recorded');
  perform pg_temp.check((select status from download_purchases where id = pur) = 'pending', 'still pending after refusals');
  select count(*) into n from download_grants where download_purchase_id = pur;
  perform pg_temp.check(n = 0, 'nothing granted by refusals');
  perform pg_temp.check(not exists (select 1 from invoices where project_id = pg_temp.id('pr')), 'no invoice by refusals');

  -- The real payment.
  out := pg_temp.fulfil('ev4', pur, 'cs_1', 10500);
  perform pg_temp.check(out = 'downloads_granted', 'fulfilled: ' || out);
  select * into inv from invoices where id = (select invoice_id from download_purchases where id = pur);
  perform pg_temp.check(inv.status = 'paid' and inv.total_cents = 10500 and inv.amount_paid_cents = 10500, 'invoice paid in full');
  perform pg_temp.check(inv.project_id = pg_temp.id('pr') and inv.contact_id = pg_temp.id('ct'), 'invoice on the project and its client');
  perform pg_temp.check(inv.stripe_payment_intent_id = 'pi_ev4' and inv.paid_checkout_session_id = 'cs_1', 'payment refs on invoice');
  select count(*) into n from invoice_line_items where invoice_id = inv.id and quantity = 7 and unit_price_cents = 1500
    and description like '%buyer@example.com%';
  perform pg_temp.check(n = 1, 'one line: 7 x $15, buyer email noted');
  select count(*) into n from download_grants where download_purchase_id = pur and source = 'purchase';
  perform pg_temp.check(n = 7, 'seven bought grants');
  perform pg_temp.check((select granted_count from download_purchases where id = pur) = 7, 'granted_count');
  perform pg_temp.check((select outcome from payment_events where stripe_event_id = 'ev4') = 'downloads_granted'
    and (select invoice_id from payment_events where stripe_event_id = 'ev4') = inv.id, 'audit row links the invoice');

  -- Replays change nothing.
  perform pg_temp.check(pg_temp.fulfil('ev4', pur, 'cs_1', 10500) = 'duplicate', 'same event = duplicate');
  perform pg_temp.check(pg_temp.fulfil('ev5', pur, 'cs_1', 10500) = 'already_fulfilled', 'second paid event = already_fulfilled');
  select count(*) into n from invoices where project_id = pg_temp.id('pr');
  perform pg_temp.check(n = 1, 'still one invoice');

  -- The paid invoice is locked like any paid invoice.
  begin
    update invoices set total_cents = 1 where id = inv.id;
    raise exception 'FAILED: paid invoice editable';
  exception when others then
    if sqlerrm like 'FAILED%' then raise; end if;
  end;

  -- Downloads after purchase: every bought photo is free to download; a new photo hits the limit.
  perform pg_temp.check(claim_download(col, pg_temp.id('a10'), 'buyer@example.com', '2048', null, null) = 'ok', 'bought photo downloads');
  select count(*) into n from download_grants where visitor_key = 'buyer@example.com' and collection_id = col;
  perform pg_temp.check(n = 10, 're-download made no new grant');
  insert into media_assets (collection_id, set_id, r2_key, original_filename, content_type, size_bytes, status)
    values (col, pg_temp.id('st'), 'pd-test/11', 'p11.jpg', 'image/jpeg', 100, 'uploaded');
  perform pg_temp.check(claim_download(col, (select id from media_assets where r2_key = 'pd-test/11'), 'buyer@example.com', '2048', null, null) = 'person_limit',
    'new photo still limited after buying');

  -- "All remaining": only the one new photo is left.
  r := start_download_purchase(col, 'buyer@example.com', null, true);
  perform pg_temp.check((r->>'photo_count')::int = 1 and (r->>'free_granted')::int = 0 and (r->>'amount_cents')::int = 1500, 'all remaining = 1 photo, $15');
  pur := (r->>'purchase_id')::uuid;
  update download_purchases set stripe_checkout_session_id = 'cs_2' where id = pur;
  perform pg_temp.check(pg_temp.fulfil('ev6', pur, 'cs_2', null, 'usd', false, 'checkout.session.expired') = 'recorded', 'expiry recorded');
  perform pg_temp.check((select status from download_purchases where id = pur) = 'expired', 'expired purchase marked');
  perform pg_temp.check(pg_temp.fulfil('ev7', null, 'cs_x', 100) = 'unknown_purchase', 'unknown purchase');

  -- Nothing left to buy: free-only result, no purchase row.
  r := start_download_purchase(col, 'buyer@example.com', array[pg_temp.id('a1')], false);
  perform pg_temp.check((r->>'ok')::boolean and r->>'purchase_id' is null and (r->>'free_granted')::int = 0, 'already granted photo: nothing to buy');

  -- Gallery-wide limit 2, no per-person: 2 free (for the gallery), 3 bought.
  r := start_download_purchase(pg_temp.id('col2'), 'b@example.com', null, true);
  perform pg_temp.check((r->>'free_granted')::int = 2 and (r->>'photo_count')::int = 3 and (r->>'amount_cents')::int = 3000, 'gallery limit: 2 free, 3 x $10');
  -- Another visitor: the 2 gallery-free photos are already out, so those are free for them too; 3 to buy.
  r := start_download_purchase(pg_temp.id('col2'), 'c@example.com', null, true);
  perform pg_temp.check((r->>'free_granted')::int = 2 and (r->>'photo_count')::int = 3, 'second visitor: already-left photos free, rest bought');

  -- Blockers.
  update collections set extra_download_price_cents = null where id = col;
  perform pg_temp.check(download_purchase_blocker(col) = 'no_price', 'no price');
  perform pg_temp.check((start_download_purchase(col, 'z@example.com', null, true))->>'reason' = 'no_price', 'start refused without price');
  update collections set extra_download_price_cents = 1500, project_id = null where id = col;
  perform pg_temp.check(download_purchase_blocker(col) = 'no_project', 'no project');
  update collections set project_id = pg_temp.id('pr'), downloads_enabled = false where id = col;
  perform pg_temp.check(download_purchase_blocker(col) = 'downloads_off', 'downloads off');
  update collections set downloads_enabled = true, per_person_download_limit = null where id = col;
  perform pg_temp.check(download_purchase_blocker(col) = 'no_limit', 'no limit, nothing to sell');
  begin
    update collections set extra_download_price_cents = 99 where id = col;
    raise exception 'FAILED: price under $1 accepted';
  exception when check_violation then null;
  end;

  -- A gallery unlinked between Checkout and payment: money recorded, nothing granted.
  update collections set per_person_download_limit = 3 where id = col;
  r := start_download_purchase(col, 'late@example.com', null, true);
  pur := (r->>'purchase_id')::uuid;
  update download_purchases set stripe_checkout_session_id = 'cs_3' where id = pur;
  update collections set project_id = null where id = col;
  s := pg_temp.fulfil('ev8', pur, 'cs_3', (r->>'amount_cents')::int);
  perform pg_temp.check(s = 'no_project', 'unlinked gallery: ' || s);
  perform pg_temp.check((select status from download_purchases where id = pur) = 'pending', 'unlinked: still pending');

  raise notice 'ALL PAID DOWNLOAD TESTS PASSED';
end $$;

rollback;
