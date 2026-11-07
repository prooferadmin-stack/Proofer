import Link from "next/link";
import { formatDateTime, formatDay } from "@/lib/dates";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { presignGet, r2Configured } from "@/lib/r2";
import { GRID_SIZE, MAX_VARIANT_ATTEMPTS, displayKey } from "@/lib/galleries/variants";
import {
  createSet,
  deleteAsset,
  deleteCollection,
  deleteSet,
  moveAsset,
  moveSet,
  renameSet,
  retryProcessing,
  setSetDownloadable,
  setCollectionStatus,
  setCover,
  updateCollection,
  updateCollectionAccess,
  updateCollectionLink,
  updateDownloadSettings,
  updateStoreSettings,
} from "../actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/galleries/access";
import { accessSecret } from "@/lib/galleries/viewer-access";
import { DOWNLOAD_SIZES, DOWNLOAD_SIZE_LABELS } from "@/lib/galleries/download";
import { BLOCKER_TEXT } from "@/lib/galleries/paid-downloads";
import { formatCents } from "@/lib/email/events";
import { CollectionFields } from "../collection-fields";
import { Uploader } from "../uploader";
import type { Collection, MediaAsset, PhotoSet } from "../types";
import { ConfirmButton } from "@/app/admin/_components/confirm-button";
import { ClientLink } from "@/app/admin/_components/client-link";
import { isMissingTable } from "@/lib/db-errors";
import { VIDEO_URL_TTL_SECONDS, formatDuration, playableKeys } from "@/lib/galleries/video";

export const dynamic = "force-dynamic";

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export default async function CollectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; set?: string; section?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam, set: setParam, section: sectionParam } = await searchParams;

  const db = supabaseAdmin();
  const [collectionRes, setsRes, assetsRes, contactsRes, projectsRes, favsRes] = await Promise.all([
    db.from("collections").select("*").eq("id", id).single(),
    db.from("photo_sets").select("*").eq("collection_id", id).order("position"),
    db.from("media_assets").select("*").eq("collection_id", id).order("position"),
    db.from("contacts").select("id, name, email").order("name"),
    db.from("projects").select("id, title, contact_id").eq("archived", false).order("created_at", { ascending: false }),
    db.from("favorites").select("asset_id, visitor_email, created_at").eq("collection_id", id).order("created_at"),
  ]);
  if (collectionRes.error || !collectionRes.data) notFound();
  if (setsRes.error) throw setsRes.error;
  if (assetsRes.error) throw assetsRes.error;
  if (contactsRes.error) throw contactsRes.error;
  if (projectsRes.error) throw projectsRes.error;
  if (favsRes.error) throw favsRes.error;

  const collection = collectionRes.data as Collection;
  const sets = (setsRes.data ?? []) as PhotoSet[];
  const assets = (assetsRes.data ?? []) as MediaAsset[];
  const contacts = (contactsRes.data ?? []) as { id: string; name: string; email: string | null }[];
  const projects = (projectsRes.data ?? []) as { id: string; title: string; contact_id: string | null }[];
  // The linked project may be archived; keep it selectable so saving the
  // form doesn't silently unlink it.
  if (collection.project_id && !projects.some((p) => p.id === collection.project_id)) {
    const { data } = await db
      .from("projects")
      .select("id, title, contact_id")
      .eq("id", collection.project_id)
      .maybeSingle();
    if (data) projects.unshift({ ...data, title: `${data.title} (archived)` });
  }

  // Favorites grouped by the visitor's email, labelled with the contact who
  // has that email (if any). The email is self-reported, not verified.
  const contactByEmail = new Map(
    contacts.filter((c) => c.email).map((c) => [c.email!.trim().toLowerCase(), c] as const)
  );
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const favoritesByVisitor = new Map<string, MediaAsset[]>();
  for (const f of favsRes.data ?? []) {
    const asset = assetById.get(f.asset_id);
    if (!asset) continue;
    favoritesByVisitor.set(f.visitor_email, [...(favoritesByVisitor.get(f.visitor_email) ?? []), asset]);
  }
  // Downloads used (5.5): distinct photos per visitor. Tolerates the table not
  // existing yet (42P01) so the page works before migration 0021 is run.
  const { data: grantRows, error: grantsErr } = await db
    .from("download_grants")
    .select("asset_id, visitor_key")
    .eq("collection_id", id);
  if (grantsErr && !isMissingTable(grantsErr)) throw grantsErr;
  const downloadsMigrated = !grantsErr;
  const grants = grantRows ?? [];
  const grantsByVisitor = new Map<string, number>();
  for (const g of grants) grantsByVisitor.set(g.visitor_key, (grantsByVisitor.get(g.visitor_key) ?? 0) + 1);
  const photosDownloaded = new Set(grants.map((g) => g.asset_id)).size;

  // Paid extra downloads (5.7). Read on their own so the page still works
  // before migration 0034 adds them.
  const { data: purchaseRows } = await db
    .from("download_purchases")
    .select("id, visitor_key, photo_count, amount_cents, paid_at, invoice_id, granted_count")
    .eq("collection_id", id)
    .eq("status", "paid")
    .order("paid_at", { ascending: false });
  const purchases = (purchaseRows ?? []) as {
    id: string;
    visitor_key: string;
    photo_count: number;
    amount_cents: number;
    paid_at: string | null;
    invoice_id: string | null;
    granted_count: number | null;
  }[];
  const { data: blockerData } = await db.rpc("download_purchase_blocker", { p_collection_id: id });
  const buyBlocker = (blockerData as string | null) ?? null;

  const storageReady = r2Configured();
  // The cover is the chosen photo, else the first uploaded one (same rule as the Galleries list and client page).
  const coverId = collection.cover_asset_id ?? assets.find((a) => a.status === "uploaded" && a.kind !== "video")?.id ?? null;

  // Thumbnails are short-lived presigned GETs of the 640 variant, or of the
  // original until the variants job has made it. Signing is local crypto, no
  // request to R2 per photo.
  const thumbs = new Map<string, string>();
  if (storageReady) {
    await Promise.all(
      assets
        .filter((a) => a.status === "uploaded" && a.kind !== "video")
        .map(async (a) => thumbs.set(a.id, await presignGet(displayKey(a, GRID_SIZE))))
    );
  }
  // Video thumbnails are the poster frame the variants job made.
  if (storageReady) {
    await Promise.all(
      assets
        .filter((a) => a.kind === "video")
        .map(async (a) => {
          const keys = playableKeys(a);
          if (keys) thumbs.set(a.id, await presignGet(keys.poster, VIDEO_URL_TTL_SECONDS));
        })
    );
  }

  const updateThis = updateCollection.bind(null, collection.id);
  const updateAccess = updateCollectionAccess.bind(null, collection.id);
  const updateLink = updateCollectionLink.bind(null, collection.id);
  const updateDownloads = updateDownloadSettings.bind(null, collection.id);
  const updateStore = updateStoreSettings.bind(null, collection.id);
  // Store switch (7.2). Read on its own so the page works before migration 0025.
  const { data: storeRow, error: storeErr } = await db
    .from("collections")
    .select("store_enabled")
    .eq("id", collection.id)
    .maybeSingle();
  const storeMigrated = !storeErr;
  const storeEnabled = storeRow?.store_enabled === true;
  const accessSecretSet = accessSecret() !== null;
  const toggleStatus = setCollectionStatus.bind(
    null,
    collection.id,
    collection.status === "published" ? "draft" : "published"
  );
  const deleteThis = deleteCollection.bind(null, collection.id);
  const addSet = createSet.bind(null, collection.id);

  // ---- editor layout (Pixieset-style): top bar, left panel (cover + tabs), main area ----
  const tab = tabParam === "settings" || tabParam === "activity" ? tabParam : "photos";
  const section =
    sectionParam === "privacy" || sectionParam === "downloads" || sectionParam === "store" ? sectionParam : "general";
  const activeSet = sets.find((s) => s.id === setParam) ?? sets[0];
  const base = `/admin/galleries/${collection.id}`;
  const coverThumb = coverId ? thumbs.get(coverId) : undefined;
  const published = collection.status === "published";
  const dateLabel = collection.event_date ? formatDay(collection.event_date) : "No date";
  const uploadedCount = assets.filter((a) => a.status === "uploaded").length;

  const activeAssets = activeSet ? assets.filter((a) => a.set_id === activeSet.id) : [];
  const activeIndex = activeSet ? sets.findIndex((s) => s.id === activeSet.id) : -1;

  const linkedProject = collection.project_id ? projects.find((p) => p.id === collection.project_id) ?? null : null;
  const linkedContact = collection.contact_id ? contacts.find((c) => c.id === collection.contact_id) ?? null : null;
  const SETTINGS_SECTIONS = [
    { key: "general", name: "General" },
    { key: "privacy", name: "Privacy" },
    { key: "downloads", name: "Downloads" },
    { key: "store", name: "Store" },
  ];

  return (
    <main className="fluid workspace editor">
      <Link className="back" href="/admin/galleries">
        ← Galleries
      </Link>
      <header className="ws-head ed-head">
        <div className="ed-headtext">
          <h1>{collection.name}</h1>
          <div className="ws-meta">
            <span className={`st ${published ? "green" : "blue"}`}>{published ? "Published" : "Draft"}</span>
            {dateLabel && <span>{dateLabel}</span>}
            <span>
              {assets.length} photo{assets.length === 1 ? "" : "s"}
            </span>
            {linkedProject && <Link href={`/admin/projects/${linkedProject.id}`}>{linkedProject.title}</Link>}
          </div>
        </div>
        <div className="ed-actions">
          <Link
            href={`/g/${collection.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            title={published ? "Open the client gallery" : "Draft galleries aren't visible to clients yet"}
          >
            Preview
          </Link>
          <details className="menu">
            <summary className="btn primary">Share</summary>
            <div className="menu-pop wide">
              <p className="hint" style={{ margin: "0 0 6px" }}>
                Client link
              </p>
              <ClientLink path={`/g/${collection.slug}`} />
              {!published && <p className="hint">Not viewable until published.</p>}
              {published && collection.visibility === "private" && (
                <p className="hint">Private: closed to everyone for now. Change this under Settings, Privacy.</p>
              )}
            </div>
          </details>
          <details className="menu">
            <summary className="btn">More</summary>
            <div className="menu-pop">
              <form action={deleteThis}>
                <ConfirmButton message="Delete this gallery and every photo in it? This can't be undone.">
                  Delete gallery
                </ConfirmButton>
              </form>
            </div>
          </details>
        </div>
      </header>

      <div className="ws">
        <aside className="ws-side" aria-label="Gallery summary">
          {coverThumb ? <img className="ed-cover" src={coverThumb} alt="" /> : <div className="ed-cover ph">No cover yet</div>}
          <dl className="ws-facts">
            <div>
              <dt>Client</dt>
              <dd>{linkedContact ? <Link href={`/admin/contacts/${linkedContact.id}`}>{linkedContact.name}</Link> : "Not linked"}</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd style={{ textTransform: "capitalize" }}>{collection.visibility}</dd>
            </div>
            <div>
              <dt>Downloads</dt>
              <dd>{collection.downloads_enabled === false ? "Off" : "On"}</dd>
            </div>
            <div>
              <dt>Store</dt>
              <dd>{storeEnabled ? "On" : "Off"}</dd>
            </div>
          </dl>
          <form action={toggleStatus}>
            <button type="submit" className={published ? undefined : "primary"}>
              {published ? "Unpublish (back to draft)" : "Publish gallery"}
            </button>
          </form>

          <div className="ed-sets">
            <span className="lbl">Sets</span>
            <ul className="ws-rows">
              {sets.map((s) => {
                const count = assets.filter((a) => a.set_id === s.id).length;
                const on = tab === "photos" && activeSet?.id === s.id;
                return (
                  <li key={s.id} className={on ? "on" : undefined}>
                    <Link href={`${base}?tab=photos&set=${s.id}`} className="grow" aria-current={on ? "page" : undefined}>
                      {s.name}
                    </Link>
                    <span className="muted small">{count}</span>
                  </li>
                );
              })}
            </ul>
            <form action={addSet} className="ed-addset">
              <input type="text" name="name" placeholder="New set name" required aria-label="New set name" />
              <button type="submit">Add</button>
            </form>
          </div>
        </aside>

        <section className="ed-main ws-main">
          <div className="ed-tabbar">
            <nav className="seg" aria-label="Gallery sections">
              <Link href={`${base}?tab=photos`} className={tab === "photos" ? "on" : undefined}>
                Photos
              </Link>
              <Link href={`${base}?tab=settings`} className={tab === "settings" ? "on" : undefined}>
                Settings
              </Link>
              <Link href={`${base}?tab=activity`} className={tab === "activity" ? "on" : undefined}>
                Activity
              </Link>
            </nav>
            {tab === "settings" && (
              <nav className="ed-subnav" aria-label="Settings sections">
                {SETTINGS_SECTIONS.map((x) => (
                  <Link key={x.key} href={`${base}?tab=settings&section=${x.key}`} className={section === x.key ? "on" : undefined}>
                    {x.name}
                  </Link>
                ))}
              </nav>
            )}
          </div>
          {tab === "photos" && activeSet && (
            <>
              <div className="ed-maintop">
                <h2>
                  {activeSet.name} <span className="muted">({activeAssets.length})</span>
                </h2>
                <details className="menu">
                  <summary className="btn">Set options ▾</summary>
                  <div className="menu-pop wide">
                    <form action={renameSet.bind(null, activeSet.id, collection.id)} className="row" style={{ marginBottom: 6 }}>
                      <input type="text" name="name" defaultValue={activeSet.name} required />
                      <button type="submit">Rename</button>
                    </form>
                    <form action={setSetDownloadable.bind(null, activeSet.id, collection.id, activeSet.downloadable === false)}>
                      <button type="submit">
                        {activeSet.downloadable === false ? "Allow downloads from this set" : "Turn off downloads for this set"}
                      </button>
                    </form>
                    <form action={moveSet.bind(null, activeSet.id, "up")}>
                      <button type="submit" disabled={activeIndex === 0}>
                        Move set up
                      </button>
                    </form>
                    <form action={moveSet.bind(null, activeSet.id, "down")}>
                      <button type="submit" disabled={activeIndex === sets.length - 1}>
                        Move set down
                      </button>
                    </form>
                    <form action={deleteSet.bind(null, activeSet.id)}>
                      <ConfirmButton message="Delete this set and all its photos? This can't be undone.">
                        Delete set{activeAssets.length > 0 ? " and its photos" : ""}
                      </ConfirmButton>
                    </form>
                  </div>
                </details>
              </div>

              {storageReady ? (
                <div>
                  <Uploader
                    collectionId={collection.id}
                    sets={[activeSet, ...sets.filter((s) => s.id !== activeSet.id)].map((s) => ({ id: s.id, name: s.name }))}
                  />
                </div>
              ) : (
                <p role="alert" className="notice">
                  Uploads are disabled: R2 isn&apos;t configured on this environment (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
                  R2_SECRET_ACCESS_KEY, R2_BUCKET).
                </p>
              )}

              <ul className="tiles">
                {activeAssets.map((asset, j) => {
                  const thumb = thumbs.get(asset.id);
                  const isCover = asset.id === coverId;
                  return (
                    <li key={asset.id} className="tile">
                      <div className="tile-img">
                        {thumb ? (
                          <img src={thumb} alt={asset.original_filename} loading="lazy" />
                        ) : (
                          <div className="ph">
                            {asset.status === "pending" ? "Upload didn't finish" : asset.kind === "video" ? "Video" : "No preview"}
                          </div>
                        )}
                        {isCover && <span className="pill tile-badge">Cover</span>}
                        {asset.kind === "video" && (
                          <span className="vbadge" aria-label="Video">
                            ▶{formatDuration(asset.duration_seconds) ? ` ${formatDuration(asset.duration_seconds)}` : ""}
                          </span>
                        )}
                        <details className="menu tile-menu">
                          <summary aria-label="Photo options">⋮</summary>
                          <div className="menu-pop">
                            {!isCover && asset.status === "uploaded" && asset.kind !== "video" && (
                              <form action={setCover.bind(null, collection.id, asset.id)}>
                                <button type="submit">Set as cover</button>
                              </form>
                            )}
                            <form action={moveAsset.bind(null, asset.id, "up")}>
                              <button type="submit" disabled={j === 0}>
                                Move earlier
                              </button>
                            </form>
                            <form action={moveAsset.bind(null, asset.id, "down")}>
                              <button type="submit" disabled={j === activeAssets.length - 1}>
                                Move later
                              </button>
                            </form>
                            <form action={deleteAsset.bind(null, asset.id)}>
                              <ConfirmButton
                                message={`Delete this ${asset.kind === "video" ? "video" : "photo"}? This can't be undone.`}
                              >
                                Delete
                              </ConfirmButton>
                            </form>
                          </div>
                        </details>
                      </div>
                      <div className="name">
                        {asset.original_filename} · {formatBytes(asset.size_bytes)}
                      </div>
                      {asset.status === "uploaded" && !asset.variants_ready && (
                        <div className="hint">
                          {asset.variant_attempts >= MAX_VARIANT_ATTEMPTS ? (
                            <>
                              <span className="st red" title={asset.variant_error ?? undefined}>
                                Failed
                              </span>{" "}
                              {asset.kind === "video" ? "Couldn't make the web copy." : "Couldn't make the sizes."}{" "}
                              <form action={retryProcessing.bind(null, asset.id)} className="inline">
                                <button type="submit" className="ghost sm">
                                  Retry
                                </button>
                              </form>
                            </>
                          ) : (
                            <span className="st amber">{asset.kind === "video" ? "Preparing video (up to an hour)" : "Sizes processing"}</span>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
                {activeAssets.length === 0 && <li className="muted">Nothing in this set yet.</li>}
              </ul>
            </>
          )}

          {tab === "settings" && section === "general" && (
            <div className="ed-form">
              <h2>General</h2>
              <form action={updateThis}>
                <CollectionFields collection={collection} />
                <button type="submit" className="primary" style={{ marginTop: 12 }}>
                  Save details
                </button>
              </form>

              <h2>Client</h2>
              <form action={updateLink}>
                <div>
                  <label htmlFor="contact_id">Contact</label>
                  <select id="contact_id" name="contact_id" defaultValue={collection.contact_id ?? ""}>
                    <option value="">None</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.email ? ` (${c.email})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="project_id">Project</label>
                  <select id="project_id" name="project_id" defaultValue={collection.project_id ?? ""}>
                    <option value="">None</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" style={{ marginTop: 12 }}>
                  Save client link
                </button>
              </form>
              <p className="hint">
                {collection.project_id && <Link href={`/admin/projects/${collection.project_id}`}>Open project</Link>}
                {collection.project_id && collection.contact_id && " · "}
                {collection.contact_id && <Link href={`/admin/contacts/${collection.contact_id}`}>Open contact</Link>}
                {!collection.project_id && !collection.contact_id && "Picking only a project also links its contact."}
              </p>
            </div>
          )}

          {tab === "settings" && section === "privacy" && (
            <div className="ed-form">
              <h2>Privacy</h2>
              <p className="muted">
                Client link: <Link href={`/g/${collection.slug}`}>/g/{collection.slug}</Link>
                {collection.status === "draft" && " (not viewable until published)"}
              </p>
              <form action={updateAccess}>
                <div>
                  <label htmlFor="visibility">Visibility</label>
                  <select id="visibility" name="visibility" defaultValue={collection.visibility}>
                    <option value="public">Public: anyone with the link</option>
                    <option value="password">Password: anyone with the link and password</option>
                    <option value="private">Private: closed to everyone for now</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="password">
                    Gallery password ({collection.password_hash ? "set; blank keeps it" : "not set"}, min{" "}
                    {MIN_PASSWORD_LENGTH} characters)
                  </label>
                  <input id="password" name="password" type="password" autoComplete="new-password" />
                </div>
                <button type="submit" className="primary" style={{ marginTop: 12 }}>
                  Save access
                </button>
              </form>
              {collection.visibility === "private" && (
                <p className="notice">
                  Private galleries can&apos;t be opened by clients until client sign-in for galleries is set up.
                </p>
              )}
              {collection.visibility === "password" && !accessSecretSet && (
                <p role="alert" className="notice">
                  Clients can&apos;t unlock password galleries yet: GALLERY_ACCESS_SECRET isn&apos;t set on this environment.
                </p>
              )}
              <p className="hint">Changing visibility or the password signs every visitor out.</p>
            </div>
          )}

          {tab === "settings" && section === "store" && (
            <div className="ed-form">
              <h2>Store</h2>
              {!storeMigrated && (
                <p role="alert" className="notice">
                  The store needs migration 0025 run in Supabase before this saves.
                </p>
              )}
              <p className="hint">
                Adds a Shop tab to this gallery with every active product from <Link href="/admin/store">Store</Link>.
                Orders aren&apos;t recorded in Proofer yet (task 7.3); payments show in Stripe.
              </p>
              <form action={updateStore}>
                <label>
                  <input type="checkbox" name="store_enabled" defaultChecked={storeEnabled} /> Show the Shop tab to clients
                </label>
                <button type="submit" className="primary" style={{ marginTop: 12 }}>
                  Save store
                </button>
              </form>
            </div>
          )}

          {tab === "settings" && section === "downloads" && (
            <div className="ed-form">
              <h2>Downloads</h2>
              {!downloadsMigrated && (
                <p role="alert" className="notice">
                  Download limits need migration 0021 run in Supabase before these settings save.
                </p>
              )}
              <form action={updateDownloads}>
                <div>
                  <label>
                    <input type="checkbox" name="downloads_enabled" defaultChecked={collection.downloads_enabled !== false} />{" "}
                    Clients can download photos
                  </label>
                </div>
                <div>
                  <label htmlFor="download_size">Size clients download</label>
                  <select id="download_size" name="download_size" defaultValue={collection.download_size ?? "original"}>
                    {DOWNLOAD_SIZES.map((sz) => (
                      <option key={sz} value={sz}>
                        {DOWNLOAD_SIZE_LABELS[sz]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="download_limit">Gallery limit: photos that can be downloaded in total (blank = no limit)</label>
                  <input
                    id="download_limit"
                    name="download_limit"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={collection.download_limit ?? ""}
                  />
                </div>
                <div>
                  <label htmlFor="per_person_download_limit">
                    Per-person limit: photos each client email can download (blank = no limit)
                  </label>
                  <input
                    id="per_person_download_limit"
                    name="per_person_download_limit"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={collection.per_person_download_limit ?? ""}
                  />
                </div>
                <div>
                  <label htmlFor="extra_download_price">
                    Price per extra photo, in dollars (blank = clients can&apos;t buy more)
                  </label>
                  <input
                    id="extra_download_price"
                    name="extra_download_price"
                    inputMode="decimal"
                    placeholder="e.g. 15"
                    defaultValue={
                      collection.extra_download_price_cents != null ? (Number(collection.extra_download_price_cents) / 100).toFixed(2) : ""
                    }
                  />
                </div>
                <p className={buyBlocker ? "muted" : "hint"}>
                  {buyBlocker
                    ? `Buying more downloads is off: ${BLOCKER_TEXT[buyBlocker] ?? buyBlocker}`
                    : "Clients can buy more: their free downloads are used first, then each extra photo is charged at this price and becomes a paid invoice on the gallery's project."}
                </p>
                <button type="submit" className="primary" style={{ marginTop: 12 }}>
                  Save downloads
                </button>
              </form>
              <p className="hint">
                Limits count photos, not clicks: downloading the same photo again is free. With a per-person limit, clients
                enter their email (the same one favorites use) before they can download; that email isn&apos;t verified.
                Turn off downloads for a single set from its Set options menu.
              </p>
              {sets.some((st) => st.downloadable === false) && (
                <p className="muted">
                  Not downloadable: {sets.filter((st) => st.downloadable === false).map((st) => st.name).join(", ")}
                </p>
              )}
            </div>
          )}

          {tab === "activity" && (
            <div className="ed-form wide">
              <h2>Downloads</h2>
              {grants.length === 0 ? (
                <p className="muted">No downloads yet.</p>
              ) : (
                <>
                  <p>
                    {photosDownloaded} photo{photosDownloaded === 1 ? "" : "s"} downloaded
                    {collection.download_limit != null ? ` of ${collection.download_limit} allowed` : ""}.
                  </p>
                  <ul>
                    {[...grantsByVisitor].map(([visitor, count]) => {
                      const contact = visitor ? contactByEmail.get(visitor) : undefined;
                      return (
                        <li key={visitor || "anon"}>
                          {contact ? <Link href={`/admin/contacts/${contact.id}`}>{contact.name}</Link> : visitor || "Visitors without an email"}
                          {contact && ` (${visitor})`}: {count} photo{count === 1 ? "" : "s"}
                          {visitor && collection.per_person_download_limit != null ? ` of ${collection.per_person_download_limit}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              <h2>Bought downloads</h2>
              {purchases.length === 0 ? (
                <p className="muted">No downloads bought yet.</p>
              ) : (
                <ul>
                  {purchases.map((p) => (
                    <li key={p.id}>
                      {p.visitor_key}: {p.photo_count} photo{p.photo_count === 1 ? "" : "s"}, {formatCents(p.amount_cents)}
                      {p.paid_at ? ` · ${formatDateTime(p.paid_at)}` : ""}
                      {p.invoice_id && (
                        <>
                          {" "}
                          · <Link href={`/admin/invoices/${p.invoice_id}`}>Invoice</Link>
                        </>
                      )}
                      {p.granted_count != null && p.granted_count < p.photo_count && (
                        <span className="muted"> · {p.photo_count - p.granted_count} no longer in the gallery when paid</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <h2>Favorites</h2>
              {favoritesByVisitor.size === 0 && <p className="muted">No favorites yet.</p>}
              {[...favoritesByVisitor].map(([email, picks]) => {
                const contact = contactByEmail.get(email);
                return (
                  <section key={email}>
                    <h3>
                      {contact ? <Link href={`/admin/contacts/${contact.id}`}>{contact.name}</Link> : email}
                      {contact && ` (${email})`} · {picks.length} favorite{picks.length === 1 ? "" : "s"}
                    </h3>
                    <ul className="tiles">
                      {picks.map((asset) => {
                        const thumb = thumbs.get(asset.id);
                        return (
                          <li key={asset.id} className="tile">
                            <div className="tile-img">
                              {thumb ? <img src={thumb} alt={asset.original_filename} loading="lazy" /> : <div className="ph" />}
                            </div>
                            <div className="name">{asset.original_filename}</div>
                          </li>
                        );
                      })}
                    </ul>
                    <details>
                      <summary>Filenames to copy</summary>
                      <textarea readOnly rows={3} defaultValue={picks.map((a) => a.original_filename).join(", ")} />
                    </details>
                  </section>
                );
              })}
              <p className="hint">Clients name themselves by email when they favorite; the email isn&apos;t verified.</p>
              <p className="hint">
                {uploadedCount} photo{uploadedCount === 1 ? "" : "s"} in this gallery.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
