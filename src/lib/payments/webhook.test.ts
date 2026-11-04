// Run with `npm test` (Node's built-in runner + type stripping, Node >= 22.18).
import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { paymentFromEvent } from "./webhook.ts";

const INVOICE = "fbbb1682-2f8f-494f-a44a-f8307e7e69e1";

function sessionEvent(type: string, session: Record<string, unknown>): Stripe.Event {
  return {
    id: "evt_1",
    type,
    livemode: false,
    data: {
      object: {
        id: "cs_test_1",
        mode: "payment",
        payment_status: "paid",
        payment_intent: "pi_1",
        amount_total: 53500,
        currency: "usd",
        metadata: { invoice_id: INVOICE },
        client_reference_id: INVOICE,
        ...session,
      },
    },
  } as unknown as Stripe.Event;
}

test("a paid checkout.session.completed marks the invoice paid", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", {}));
  assert.deepEqual(p, {
    invoiceId: INVOICE,
    installmentId: null,
    giftCardPurchaseId: null,
    sessionId: "cs_test_1",
    paymentIntentId: "pi_1",
    amountCents: 53500,
    currency: "usd",
    markPaid: true,
  });
});

test("an unpaid completed session (delayed bank payment) waits for async success", () => {
  const completed = paymentFromEvent(sessionEvent("checkout.session.completed", { payment_status: "unpaid" }));
  assert.equal(completed.markPaid, false);
  assert.equal(completed.invoiceId, INVOICE);
  const succeeded = paymentFromEvent(
    sessionEvent("checkout.session.async_payment_succeeded", { payment_status: "paid" })
  );
  assert.equal(succeeded.markPaid, true);
});

test("failed and expired sessions are recorded, never paid", () => {
  for (const type of ["checkout.session.async_payment_failed", "checkout.session.expired"]) {
    const p = paymentFromEvent(sessionEvent(type, { payment_status: "unpaid" }));
    assert.equal(p.markPaid, false);
    assert.equal(p.invoiceId, INVOICE);
  }
});

test("missing, malformed or conflicting invoice ids never mark anything paid", () => {
  const cases = [
    { metadata: {} },
    { metadata: { invoice_id: "not-a-uuid" } },
    { metadata: { invoice_id: `${INVOICE}' or 1=1` } },
    { client_reference_id: "3f2b8c1e-9a4d-4e7f-8b2a-1c0d9e8f7a6b" },
  ];
  for (const c of cases) {
    const p = paymentFromEvent(sessionEvent("checkout.session.completed", c));
    assert.equal(p.invoiceId, null);
    assert.equal(p.markPaid, false);
  }
});

test("a session without client_reference_id still uses the metadata id", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", { client_reference_id: null }));
  assert.equal(p.invoiceId, INVOICE);
  assert.equal(p.markPaid, true);
});

test("subscription or setup sessions never mark an invoice paid", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", { mode: "setup" }));
  assert.equal(p.markPaid, false);
});

test("an expanded payment_intent object is reduced to its id", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", { payment_intent: { id: "pi_2" } }));
  assert.equal(p.paymentIntentId, "pi_2");
});

test("charge.refunded carries the payment intent and refunded amount only", () => {
  const event = {
    id: "evt_2",
    type: "charge.refunded",
    livemode: false,
    data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 1000, currency: "usd" } },
  } as unknown as Stripe.Event;
  assert.deepEqual(paymentFromEvent(event), {
    invoiceId: null,
    installmentId: null,
    giftCardPurchaseId: null,
    sessionId: null,
    paymentIntentId: "pi_1",
    amountCents: 1000,
    currency: "usd",
    markPaid: false,
  });
});

test("other event types are ignored", () => {
  const event = { id: "evt_3", type: "customer.created", livemode: false, data: { object: {} } } as unknown as Stripe.Event;
  assert.equal(paymentFromEvent(event).markPaid, false);
  assert.equal(paymentFromEvent(event).invoiceId, null);
});

test("an installment session carries its installment id", () => {
  const INST = "0b9c1f7e-5a2d-4c3b-9e8f-7a6b5c4d3e2f";
  const p = paymentFromEvent(
    sessionEvent("checkout.session.completed", { metadata: { invoice_id: INVOICE, installment_id: INST.toUpperCase() } })
  );
  assert.equal(p.installmentId, INST);
  assert.equal(p.markPaid, true);
});

test("a malformed installment id is dropped, and never kept without an invoice", () => {
  const bad = paymentFromEvent(
    sessionEvent("checkout.session.completed", { metadata: { invoice_id: INVOICE, installment_id: "nope" } })
  );
  assert.equal(bad.installmentId, null);
  const orphan = paymentFromEvent(
    sessionEvent("checkout.session.completed", {
      metadata: { installment_id: "0b9c1f7e-5a2d-4c3b-9e8f-7a6b5c4d3e2f" },
    })
  );
  assert.equal(orphan.invoiceId, null);
  assert.equal(orphan.installmentId, null);
});

const PURCHASE = "5d0f9a3c-2b7e-4c1a-9f8d-6e5b4a3c2d1e";
const giftCard = (over: Record<string, unknown> = {}) => ({
  metadata: { kind: "gift_card", gift_card_purchase_id: PURCHASE },
  client_reference_id: PURCHASE,
  amount_total: 39200,
  ...over,
});

test("a paid gift card session names its purchase and no invoice", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", giftCard()));
  assert.equal(p.giftCardPurchaseId, PURCHASE);
  assert.equal(p.invoiceId, null);
  assert.equal(p.installmentId, null);
  assert.equal(p.amountCents, 39200);
  assert.equal(p.markPaid, true);
});

test("gift card sessions wait for the money like invoices do", () => {
  assert.equal(paymentFromEvent(sessionEvent("checkout.session.completed", giftCard({ payment_status: "unpaid" }))).markPaid, false);
  assert.equal(paymentFromEvent(sessionEvent("checkout.session.async_payment_succeeded", giftCard())).markPaid, true);
  for (const type of ["checkout.session.expired", "checkout.session.async_payment_failed"]) {
    const p = paymentFromEvent(sessionEvent(type, giftCard({ payment_status: "unpaid" })));
    assert.equal(p.markPaid, false);
    assert.equal(p.giftCardPurchaseId, PURCHASE);
  }
});

test("gift card ids that disagree, are missing or malformed trust neither", () => {
  const cases = [
    giftCard({ client_reference_id: "3f2b8c1e-9a4d-4e7f-8b2a-1c0d9e8f7a6b" }),
    giftCard({ client_reference_id: null }),
    giftCard({ metadata: { kind: "gift_card", gift_card_purchase_id: "nope" }, client_reference_id: "nope" }),
    giftCard({ metadata: { kind: "gift_card" } }),
    giftCard({ metadata: { gift_card_purchase_id: PURCHASE } }),
  ];
  for (const c of cases) {
    const p = paymentFromEvent(sessionEvent("checkout.session.completed", c));
    assert.equal(p.giftCardPurchaseId, null);
    assert.equal(p.invoiceId, null);
    assert.equal(p.markPaid, false);
  }
});

test("a session claiming to be both a gift card and an invoice pays neither", () => {
  const p = paymentFromEvent(
    sessionEvent("checkout.session.completed", giftCard({ metadata: { kind: "gift_card", gift_card_purchase_id: PURCHASE, invoice_id: INVOICE } }))
  );
  assert.equal(p.giftCardPurchaseId, null);
  assert.equal(p.invoiceId, null);
  assert.equal(p.markPaid, false);
});

test("invoice sessions never carry a gift card purchase", () => {
  const p = paymentFromEvent(sessionEvent("checkout.session.completed", { metadata: { invoice_id: INVOICE, gift_card_purchase_id: PURCHASE } }));
  assert.equal(p.invoiceId, INVOICE);
  assert.equal(p.giftCardPurchaseId, null);
});
