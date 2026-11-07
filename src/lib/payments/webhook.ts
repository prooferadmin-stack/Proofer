// Pulls what the payment audit needs out of a verified Stripe event (Phase
// 2.3). No imports beyond types, so Node's test runner can load it directly.
import type Stripe from "stripe";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EventPayment = {
  invoiceId: string | null;
  // Set when the session paid one installment of a schedule (2.4).
  installmentId: string | null;
  // Set when the session paid for a gift card (2.7). Never set together
  // with invoiceId.
  giftCardPurchaseId: string | null;
  // Paid extra downloads (5.7).
  downloadPurchaseId: string | null;
  sessionId: string | null;
  paymentIntentId: string | null;
  amountCents: number | null;
  currency: string | null;
  // True only for an event that says the money has actually arrived.
  markPaid: boolean;
};

const NONE: EventPayment = {
  invoiceId: null,
  installmentId: null,
  giftCardPurchaseId: null,
  downloadPurchaseId: null,
  sessionId: null,
  paymentIntentId: null,
  amountCents: null,
  currency: null,
  markPaid: false,
};

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.id);

// The invoice id our Checkout session carries (pay/[id]/actions.ts sets both
// metadata.invoice_id and client_reference_id). If they disagree, trust neither.
function invoiceIdOf(session: Stripe.Checkout.Session): string | null {
  const meta = session.metadata?.invoice_id ?? null;
  const ref = session.client_reference_id ?? null;
  if (!meta || !UUID_PATTERN.test(meta)) return null;
  if (ref !== null && ref !== meta) return null;
  return meta.toLowerCase();
}

function installmentIdOf(session: Stripe.Checkout.Session): string | null {
  const id = session.metadata?.installment_id ?? null;
  return id && UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

// A gift card Checkout (gift-cards/actions.ts) carries metadata.kind
// "gift_card", the purchase id in metadata AND client_reference_id, and no
// invoice id. Anything else, or the two ids disagreeing, trusts neither.
function giftCardPurchaseIdOf(session: Stripe.Checkout.Session): string | null {
  if (session.metadata?.kind !== "gift_card" || session.metadata?.invoice_id) return null;
  const meta = session.metadata?.gift_card_purchase_id ?? null;
  const ref = session.client_reference_id ?? null;
  if (!meta || !UUID_PATTERN.test(meta) || ref !== meta) return null;
  return meta.toLowerCase();
}

function downloadPurchaseIdOf(session: Stripe.Checkout.Session): string | null {
  if (session.metadata?.kind !== "download_purchase" || session.metadata?.invoice_id) return null;
  const meta = session.metadata?.download_purchase_id ?? null;
  const ref = session.client_reference_id ?? null;
  if (!meta || !UUID_PATTERN.test(meta) || ref !== meta) return null;
  return meta.toLowerCase();
}

// Sessions that are not invoice payments never pay an invoice, whatever
// other metadata they carry.
const NOT_INVOICE_KINDS = new Set(["gift_card", "download_purchase"]);

export function paymentFromEvent(event: Stripe.Event): EventPayment {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const s = event.data.object as Stripe.Checkout.Session;
      const giftCardPurchaseId = giftCardPurchaseIdOf(s);
      const downloadPurchaseId = downloadPurchaseIdOf(s);
      // A session that claims to be a gift card never pays an invoice.
      const invoiceId = NOT_INVOICE_KINDS.has(s.metadata?.kind ?? "") ? null : invoiceIdOf(s);
      // "completed" with payment_status "unpaid" is a delayed method (bank
      // debit); the money only counts once async_payment_succeeded arrives.
      const markPaid =
        (invoiceId !== null || giftCardPurchaseId !== null || downloadPurchaseId !== null) &&
        s.mode === "payment" &&
        ((event.type === "checkout.session.completed" && s.payment_status === "paid") ||
          event.type === "checkout.session.async_payment_succeeded");
      return {
        invoiceId,
        installmentId: invoiceId === null ? null : installmentIdOf(s),
        giftCardPurchaseId,
        downloadPurchaseId,
        sessionId: s.id,
        paymentIntentId: idOf(s.payment_intent),
        amountCents: s.amount_total ?? null,
        currency: s.currency ?? null,
        markPaid,
      };
    }
    case "charge.refunded": {
      const c = event.data.object as Stripe.Charge;
      return {
        ...NONE,
        paymentIntentId: idOf(c.payment_intent),
        amountCents: c.amount_refunded,
        currency: c.currency,
      };
    }
    default:
      return NONE;
  }
}
