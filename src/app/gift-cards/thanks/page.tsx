// After Stripe Checkout for a gift card (2.7). Shows nothing about the card:
// the code goes only to the buyer's email, once the webhook has issued it.
import { BrandFooter, BrandHeader } from "@/app/_brand/brand-frame";

export const dynamic = "force-dynamic";
export const metadata = { title: "Thank you", robots: { index: false } };

export default function GiftCardThanksPage() {
  return (
    <main>
      <BrandHeader />
      <h1>Thank you</h1>
      <p>Your gift card is on its way to your email, with the code and a printable card. It usually arrives within a few minutes.</p>
      <p className="muted">Nothing there after an hour? Check your spam folder, then reply to any of my emails and I&apos;ll sort it out.</p>
      <BrandFooter />
    </main>
  );
}
