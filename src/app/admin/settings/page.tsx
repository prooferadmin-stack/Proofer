import Link from "next/link";
import { ThemePicker } from "./theme-picker";
import { BrandImageUpload } from "./brand-upload";
import { removeBrandImage, updateBrand } from "./brand-actions";
import { brandImageUrl, getBrand, type BrandImageKind } from "@/lib/brand/brand";
import { getLink, googleConfigured } from "@/lib/gcal/client";
import { disconnectCalendar } from "./calendar-actions";
import { formatDateTime } from "@/lib/dates";

export const dynamic = "force-dynamic";

const IMAGES: { kind: BrandImageKind; name: string; hint: string; accept: string }[] = [
  { kind: "logo", name: "Logo", hint: "On client pages and at the top of every email. PNG or SVG, transparent background.", accept: "image/png,image/svg+xml,image/webp,image/jpeg" },
  { kind: "cover_logo", name: "Light logo", hint: "A white or light version for gallery covers over photos.", accept: "image/png,image/svg+xml,image/webp" },
  { kind: "default_cover", name: "Default cover", hint: "Used on a gallery before you pick its own cover.", accept: "image/jpeg,image/png,image/webp" },
];

const CALENDAR_RESULTS: Record<string, { text: string; ok?: boolean }> = {
  connected: { text: "Google Calendar connected.", ok: true },
  declined: { text: "Google didn't connect (access wasn't allowed)." },
  bad_state: { text: "That sign-in link expired. Please try connecting again." },
  missing_scope: { text: "Proofer needs both calendar boxes ticked on Google's screen. Please try again." },
  no_refresh: { text: "Google didn't give lasting access. Remove Proofer under your Google account's third-party access, then connect again." },
  failed: { text: "Couldn't connect to Google. Please try again." },
  not_configured: { text: "Google sign-in isn't set up on this environment yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)." },
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ calendar?: string }> }) {
  const { calendar: calendarResult } = await searchParams;
  const brand = await getBrand();
  const calendar = await getLink().catch(() => null);
  const calendarNote = calendarResult ? CALENDAR_RESULTS[calendarResult] : undefined;
  const urls = Object.fromEntries(await Promise.all(IMAGES.map(async (i) => [i.kind, await brandImageUrl(brand, i.kind)] as const)));

  return (
    <main>
      <div className="pagehead">
        <h1>Settings</h1>
      </div>

      <h2 style={{ marginTop: 0 }}>Brand</h2>
      <p className="muted">What clients see on galleries, booking, invoices, contracts and emails. Your admin look below stays separate.</p>

      <ul className="ws-rows brand-images">
        {IMAGES.map((img) => (
          <li key={img.kind}>
            <span className="brand-thumb">{urls[img.kind] ? <img src={urls[img.kind] as string} alt="" /> : <span aria-hidden="true" />}</span>
            <span className="grow">
              <strong>{img.name}</strong>
              <span className="muted small"> · {img.hint}</span>
            </span>
            <BrandImageUpload kind={img.kind} accept={img.accept} />
            {urls[img.kind] && (
              <form action={removeBrandImage.bind(null, img.kind)}>
                <button type="submit" className="ghost sm">
                  Remove
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <form action={updateBrand} className="brand-form">
        <div>
          <label htmlFor="business_name">Business name</label>
          <input id="business_name" name="business_name" type="text" required maxLength={120} defaultValue={brand.businessName} />
        </div>
        <div>
          <label>
            <input type="checkbox" name="use_accent" defaultChecked={brand.accent !== null} /> Use my own accent color on client pages
          </label>
          <input name="accent_color" type="color" defaultValue={brand.accent ?? "#2f4b63"} aria-label="Accent color" />
        </div>
        <div>
          <label htmlFor="reply_to_email">Replies go to</label>
          <input id="reply_to_email" name="reply_to_email" type="email" maxLength={254} defaultValue={brand.replyTo ?? ""} placeholder="you@gmail.com" />
        </div>
        <div>
          <label htmlFor="footer_text">Email footer (optional)</label>
          <input id="footer_text" name="footer_text" type="text" maxLength={300} defaultValue={brand.footer ?? ""} placeholder="David Monroe Photography · Savannah, Georgia" />
        </div>
        <button type="submit" className="primary">
          Save brand
        </button>
      </form>

      <h2 id="gift-cards">Gift cards</h2>
      <p className="muted">
        On/off switch, amounts, the session card discount, terms and card designs: <Link href="/admin/gift-cards/settings">Gift card settings</Link>.
      </p>

      <h2 id="calendar">Google Calendar</h2>
      <p className="muted">
        Confirmed bookings go onto your calendar, and anything already on it blocks those times on the booking page.
      </p>
      {calendarNote && (
        <p role="status" className={calendarNote.ok ? "notice" : "notice err"}>
          {calendarNote.text}
        </p>
      )}
      {calendar?.refresh_token ? (
        <div className="ws-rows">
          <p>
            <span className="st green">Connected</span> {calendar.account_email ?? "Google account"}
            {calendar.connected_at && <span className="muted small"> · since {formatDateTime(calendar.connected_at)}</span>}
          </p>
          {calendar.last_error && (
            <p className="small">
              <span className="st red">Problem</span> {calendar.last_error}
              {calendar.last_error_at && <span className="muted"> ({formatDateTime(calendar.last_error_at)})</span>}
            </p>
          )}
          <form action={disconnectCalendar}>
            <button type="submit" className="ghost sm">
              Disconnect
            </button>
          </form>
        </div>
      ) : (
        <>
          {calendar?.last_error && <p className="small"><span className="st red">Disconnected</span> {calendar.last_error}</p>}
          {googleConfigured() ? (
            <a href="/admin/calendar/connect" className="btn">
              Connect Google Calendar
            </a>
          ) : (
            <p className="hint">Waiting on Google sign-in keys for this environment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).</p>
          )}
        </>
      )}

      <h2>Appearance</h2>
      <p className="muted">How Proofer looks to you. Changes apply right away.</p>
      <ThemePicker />
    </main>
  );
}
