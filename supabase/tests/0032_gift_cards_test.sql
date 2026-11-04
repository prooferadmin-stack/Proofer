-- Database tests for 0032_gift_cards.sql (Phase 2.7). Run against a scratch
-- database that has every migration applied:
--   psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/tests/0032_gift_cards_test.sql
-- Everything runs in one transaction and is rolled back. Any failed check
-- raises and stops the run; "ALL GIFT CARD TESTS PASSED" means every one held.
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

do $$
declare
  d uuid;
  st uuid;
  p_amount uuid;
  p_session uuid;
  p_other uuid;
  r text;
  c gift_cards%rowtype;
  n int;
  s int;
begin
  insert into gift_card_designs (name) values ('Forsyth fountain') returning id into d;
  insert into session_types (name, slug, duration_minutes, price_cents, gift_card_offered)
    values ('Headshot Session', 'gc-test-headshots', 60, 49000, true) returning id into st;

  -- An amount card: sold at its value.
  insert into gift_card_purchases (kind, face_cents, amount_cents, design_id, buyer_name, buyer_email, stripe_checkout_session_id)
    values ('amount', 25000, 25000, d, 'Jordan Ellis', 'jordan@example.com', 'cs_amount') returning id into p_amount;
  -- A session card at 20% off: worth $490, sold for $392.
  insert into gift_card_purchases (kind, face_cents, amount_cents, session_type_id, session_label, design_id,
      buyer_name, buyer_email, to_name, message, stripe_checkout_session_id)
    values ('session', 49000, 39200, st, 'Headshot Session', d, 'Sam Lee', 'sam@example.com', 'Riley', 'Happy birthday', 'cs_session')
    returning id into p_session;
  insert into gift_card_purchases (kind, face_cents, amount_cents, design_id, buyer_name, buyer_email, stripe_checkout_session_id)
    values ('amount', 10000, 10000, d, 'Pat Doe', 'pat@example.com', 'cs_other') returning id into p_other;

  -- Wrong amount: the session card charged at full value issues nothing.
  r := issue_gift_card('evt_mismatch', 'checkout.session.completed', false, p_session, 'cs_session', 'pi_s', 49000, 'usd', true, '{}');
  assert r = 'amount_mismatch', 'full price for a session card: ' || r;
  assert not exists (select 1 from gift_cards where purchase_id = p_session), 'mismatch created a card';
  assert (select status from gift_card_purchases where id = p_session) = 'pending', 'mismatch changed the purchase';

  -- Wrong currency.
  r := issue_gift_card('evt_currency', 'checkout.session.completed', false, p_session, 'cs_session', 'pi_s', 39200, 'eur', true, '{}');
  assert r = 'amount_mismatch', 'currency: ' || r;

  -- A session this purchase never opened.
  r := issue_gift_card('evt_wrong_session', 'checkout.session.completed', false, p_session, 'cs_forged', 'pi_s', 39200, 'usd', true, '{}');
  assert r = 'not_payable', 'wrong session: ' || r;

  -- Unknown purchase id.
  r := issue_gift_card('evt_unknown', 'checkout.session.completed', false, gen_random_uuid(), 'cs_x', 'pi_x', 1000, 'usd', true, '{}');
  assert r = 'unknown_purchase', 'unknown: ' || r;

  -- Not yet paid (delayed method): recorded, nothing issued, still pending.
  r := issue_gift_card('evt_async_pending', 'checkout.session.completed', false, p_session, 'cs_session', 'pi_s', 39200, 'usd', false, '{}');
  assert r = 'recorded', 'async pending: ' || r;
  assert (select status from gift_card_purchases where id = p_session) = 'pending', 'async pending changed status';

  -- Paid: exactly one card worth the session's full value.
  r := issue_gift_card('evt_paid', 'checkout.session.async_payment_succeeded', false, p_session, 'cs_session', 'pi_s', 39200, 'usd', true, '{"id":"evt_paid"}');
  assert r = 'gift_card_issued', 'paid: ' || r;
  select * into c from gift_cards where purchase_id = p_session;
  assert c.initial_cents = 49000 and c.balance_cents = 49000, 'card value';
  assert c.code ~ '^DMP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$', 'code format ' || c.code;
  assert c.expires_at = c.issued_at + interval '5 years', 'expiry';
  assert c.session_label = 'Headshot Session' and c.to_name = 'Riley' and c.message = 'Happy birthday', 'card details';
  assert c.status = 'active' and length(c.view_token) = 64, 'status/token';
  assert (select status from gift_card_purchases where id = p_session) = 'paid', 'purchase paid';
  assert (select stripe_payment_intent_id from gift_card_purchases where id = p_session) = 'pi_s', 'payment intent';
  assert (select sum(amount_cents) from gift_card_ledger where gift_card_id = c.id) = c.balance_cents, 'ledger = balance';
  assert (select count(*) from gift_card_ledger where gift_card_id = c.id and kind = 'issue' and actor = 'webhook' and stripe_event_id = 'evt_paid') = 1, 'issue row';

  -- Redelivery of the same event: no-op.
  r := issue_gift_card('evt_paid', 'checkout.session.async_payment_succeeded', false, p_session, 'cs_session', 'pi_s', 39200, 'usd', true, '{}');
  assert r = 'duplicate', 'duplicate: ' || r;
  -- A different paid event for the same purchase: recorded, no second card.
  r := issue_gift_card('evt_paid_again', 'checkout.session.completed', false, p_session, 'cs_session', 'pi_s', 39200, 'usd', true, '{}');
  assert r = 'already_issued', 'already issued: ' || r;
  assert (select count(*) from gift_cards where purchase_id = p_session) = 1, 'one card per purchase';
  -- An expiry notice after issue changes nothing.
  r := issue_gift_card('evt_late_expire', 'checkout.session.expired', false, p_session, 'cs_session', null, 39200, 'usd', false, '{}');
  assert r = 'recorded' and (select status from gift_card_purchases where id = p_session) = 'paid', 'late expire';

  -- Every event above is in the audit trail, with its outcome.
  select count(*) into n from payment_events where stripe_event_id like 'evt_%' and gift_card_purchase_id is not distinct from p_session;
  assert n = 7, 'audit rows for the session purchase: ' || n;
  assert (select outcome from payment_events where stripe_event_id = 'evt_unknown') = 'unknown_purchase', 'unknown audit';

  -- Amount card at its value.
  r := issue_gift_card('evt_amount', 'checkout.session.completed', false, p_amount, 'cs_amount', 'pi_a', 25000, 'USD', true, '{}');
  assert r = 'gift_card_issued', 'amount card: ' || r;
  assert (select initial_cents from gift_cards where purchase_id = p_amount) = 25000, 'amount card value';

  -- Abandoned checkout.
  r := issue_gift_card('evt_expired', 'checkout.session.expired', false, p_other, 'cs_other', null, 10000, 'usd', false, '{}');
  assert r = 'recorded' and (select status from gift_card_purchases where id = p_other) = 'expired', 'expired';

  -- Guards: nothing outside the functions creates or changes a card.
  perform pg_temp.expect_error(format($q$insert into gift_cards (code, purchase_id, initial_cents, balance_cents, kind, design_id,
      buyer_name, buyer_email, expires_at, issued_at, view_token)
    values ('DMP23456789ABCD', %L, 100, 100, 'amount', %L, 'x', 'x@x.co', now() + interval '5 years', now(), repeat('a', 64))$q$, p_other, d),
    'only through the gift card functions');
  perform pg_temp.expect_error(format('update gift_cards set balance_cents = 1 where id = %L', c.id), 'only through the gift card functions');
  perform set_config('proofer.gift_card_write', 'on', true);
  perform pg_temp.expect_error(format('update gift_cards set initial_cents = 99999 where id = %L', c.id), 'can''t be changed');
  perform pg_temp.expect_error(format('update gift_cards set code = ''DMP222222222222'' where id = %L', c.id), 'can''t be changed');
  perform set_config('proofer.gift_card_write', 'off', true);
  perform pg_temp.expect_error(format('delete from gift_cards where id = %L', c.id), 'can''t be deleted');
  perform pg_temp.expect_error(format('update gift_card_ledger set amount_cents = 1 where gift_card_id = %L', c.id), 'append-only');
  perform pg_temp.expect_error(format('delete from gift_card_ledger where gift_card_id = %L', c.id), 'append-only');
  perform pg_temp.expect_error(format('update gift_card_purchases set amount_cents = 100 where id = %L', p_session), 'can''t be changed');
  perform pg_temp.expect_error(format('update gift_card_purchases set status = ''pending'', paid_at = null where id = %L', p_session), 'stays paid');
  perform pg_temp.expect_error(format('delete from gift_card_purchases where id = %L', p_session), 'can''t be deleted');
  perform pg_temp.expect_error(format('update gift_card_purchases set status = ''paid'', paid_at = now() where id = %L', p_other), 'Only a verified Stripe payment');
  perform pg_temp.expect_error(format('update gift_card_purchases set stripe_checkout_session_id = ''cs_new'' where id = %L', p_other), 'Checkout session can''t be changed');
  perform pg_temp.expect_error(format($q$insert into gift_card_purchases (status, kind, face_cents, amount_cents, design_id, buyer_name, buyer_email, paid_at)
    values ('paid', 'amount', 100, 100, %L, 'x', 'x@x.co', now())$q$, d), 'starts pending');
  -- An amount card can't be discounted; a session card can't be sold above value.
  perform pg_temp.expect_error(format($q$insert into gift_card_purchases (kind, face_cents, amount_cents, design_id, buyer_name, buyer_email)
    values ('amount', 10000, 8000, %L, 'x', 'x@x.co')$q$, d), 'check');
  perform pg_temp.expect_error(format($q$insert into gift_card_purchases (kind, face_cents, amount_cents, session_label, design_id, buyer_name, buyer_email)
    values ('session', 10000, 12000, 'X', %L, 'x', 'x@x.co')$q$, d), 'check');
  -- A design that a purchase uses can't be deleted.
  perform pg_temp.expect_error(format('delete from gift_card_designs where id = %L', d), 'foreign key');
  -- Deleting the session type keeps the purchase (session_type_id goes null).
  delete from session_types where id = st;
  assert (select session_type_id from gift_card_purchases where id = p_session) is null, 'session type delete';

  -- Settings: presets in $50 steps only.
  perform pg_temp.expect_error('update gift_card_settings set preset_amounts_cents = ''{10000,12345}''', 'check');
  perform pg_temp.expect_error('update gift_card_settings set custom_min_cents = 5000', 'check');
  perform pg_temp.expect_error('update gift_card_settings set session_discount_percent = 60', 'check');
  update gift_card_settings set preset_amounts_cents = '{10000,20000,75000}', session_discount_percent = 0;

  -- 10,000 codes: right shape, no repeats, every symbol of the alphabet used.
  select count(distinct x), count(*) into n, s from (select gift_card_random_code() x from generate_series(1, 10000)) t;
  assert n = 10000 and s = 10000, 'code collision in 10,000: ' || n;
  assert not exists (select 1 from (select gift_card_random_code() x from generate_series(1, 2000)) t
                     where x !~ '^DMP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$'), 'code shape';
  select count(distinct ch) into n from (select regexp_split_to_table(substr(gift_card_random_code(), 4), '') ch from generate_series(1, 500)) t;
  assert n = 31, 'alphabet coverage: ' || n;

  -- Only the service role may call the functions.
  assert not has_function_privilege('anon', 'issue_gift_card(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb)', 'execute'), 'anon can issue';
  assert not has_function_privilege('authenticated', 'issue_gift_card(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb)', 'execute'), 'authenticated can issue';
  assert has_function_privilege('service_role', 'issue_gift_card(text, text, boolean, uuid, text, text, integer, text, boolean, jsonb)', 'execute'), 'service role cannot issue';

  -- RLS on every new table.
  assert (select bool_and(relrowsecurity) from pg_class where relname in
          ('gift_card_settings', 'gift_card_designs', 'gift_card_purchases', 'gift_cards', 'gift_card_ledger')), 'RLS off';

  raise notice 'ALL GIFT CARD TESTS PASSED';
end;
$$;

rollback;
