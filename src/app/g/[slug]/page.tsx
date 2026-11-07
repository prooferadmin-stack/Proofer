// Public gallery page — no auth middleware. Access is decided server-side by
// resolveGalleryAccess (draft → 404, public → open, password → unlock cookie,
// private → closed for now). Once granted: sets as tabs, photo grid, lightbox,
// and downloads (Phase 5.4), plus favorites under a visitor email (5.6).
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { presignGet, r2Configured } from "@/lib/r2";
import { resolveGalleryAccess, resolveVisitorEmail } from "@/lib/galleries/viewer-access";
import { GRID_SIZE, LIGHTBOX_SIZE, displayKey, type Variants } from "@/lib/galleries/variants";
import { CLAIM_REFUSALS, isClaimRefusal, remainingDownloads } from "@/lib/galleries/download";
import { addToCart, checkoutCart, clearFavoritesEmail, setCartQty, setFavoritesEmail, toggleFavorite, unlockGallery } from "./actions";
import { Shop } from "./shop";
import { pricedCart } from "@/lib/store/cart";
import { loadCatalog, readCart } from "@/lib/store/gallery-store";
import { GalleryGrid, type GridPhoto } from "./gallery-grid";
import { BrandAccent, BrandFooter, BrandHeader } from "@/app/_brand/brand-frame";
import { VIDEO_URL_TTL_SECONDS, formatDuration, playableKeys } from "@/lib/galleries/video";
import { brandImageUrl, getBrand } from "@/lib/brand/brand";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  wrong: "That password isn't right.",
  limited: "Too many attempts. Please wait a few minutes and try again.",
  unavailable: "This gallery can't be unlocked right now. Please contact your photographer.",
};

const FAV_ERRORS: Record<string, string> = {
  "bad-email": "Please enter a valid email address.",
  limited: "Too many attempts. Please wait a few minutes and try again.",
  unavailable: "Favorites aren't available right now.",
};

const DOWNLOAD_NOT_READY = "This photo isn't ready to download yet. Try again in a few minutes.";

// The client gallery always uses this dark, warm palette (direction C, David
// 2026-11-07), whatever theme the visitor's browser would otherwise pick. The
// selector outranks the theme CSS in the root layout; BrandAccent still sets
// the accent when David has chosen one.
const GALLERY_PALETTE =
  "html:root:root:root{color-scheme:dark;--bg:#131210;--s0:#131210;--s1:#1b1a17;--s2:#22201c;--s3:#2a2823;--bd:#2c2a26;--bd-hi:#3d3a34;--t1:#eeeae0;--t2:#a7a194;--t3:#77726a;--acc:#8fa078;--acc-ink:#151411;--acc-soft:#8fa0781a;--acc-line:#8fa07866}";

// Width / height of the grid image, so the masonry grid can lay photos out
// before they load. Falls back to 3:2.
function aspectRatio(a: { variants?: unknown; width?: number | null; height?: number | null }): number {
  const v = (a.variants as Variants | null)?.[String(GRID_SIZE)];
  if (v?.width && v?.height) return v.width / v.height;
  if (a.width && a.height) return a.width / a.height;
  return 1.5;
}

const FAVORITES_TAB = "favorites";
const SHOP_TAB = "shop";

export default async function GalleryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; set?: string; fav?: string; dl?: string; cart?: string }>;
}) {
  const { slug } = await params;
  const { error, set: setParam, fav, dl, cart: cartMessage } = await searchParams;

  const result = await resolveGalleryAccess(slug);
  if (!result) notFound();
  const { collection, access } = result;

  if (access === "private") {
    return (
      <main>
        <BrandHeader />
        <h1>{collection.name}</h1>
        <p>This gallery is private. Please contact your photographer for access.</p>
        <BrandFooter />
      </main>
    );
  }

  if (access === "needs_password") {
    const unlock = unlockGallery.bind(null, collection.slug);
    return (
      <main>
        <BrandHeader />
        <h1>{collection.name}</h1>
        <p>This gallery is password protected.</p>
        {error && ERRORS[error] && <p role="alert">{ERRORS[error]}</p>}
        <form action={unlock}>
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <button type="submit">View gallery</button>
        </form>
        <BrandFooter />
      </main>
    );
  }

  // Granted. Only uploaded photos are shown. Sets are tabs via ?set=, so only
  // the open set's photos get URLs signed. ?set=favorites shows the visitor's
  // picks across every set.
  const db = supabaseAdmin();
  const visitorEmail = await resolveVisitorEmail(collection.id);
  const [setsRes, assetsRes, favsRes] = await Promise.all([
    db.from("photo_sets").select("id, name, downloadable").eq("collection_id", collection.id).order("position"),
    db
      .from("media_assets")
      // "*" so the page keeps working before migration 0029 adds the video columns.
      .select("*")
      .eq("collection_id", collection.id)
      .eq("status", "uploaded")
      .order("position"),
    visitorEmail
      ? db.from("favorites").select("asset_id").eq("collection_id", collection.id).eq("visitor_email", visitorEmail)
      : Promise.resolve({ data: [] as { asset_id: string }[], error: null }),
  ]);
  if (setsRes.error) throw setsRes.error;
  if (assetsRes.error) throw assetsRes.error;
  if (favsRes.error) throw favsRes.error;
  const sets = setsRes.data ?? [];
  const assets = assetsRes.data ?? [];
  const { data: coverRow, error: coverErr } = await db
    .from("collections")
    .select("cover_asset_id, downloads_enabled, download_limit, per_person_download_limit")
    .eq("id", collection.id)
    .maybeSingle();
  if (coverErr) throw coverErr;
  const coverAsset = assets.find((a) => a.id === coverRow?.cover_asset_id) ?? assets.find((a) => a.kind !== "video");
  // Brand (9.2): the default cover stands in until the gallery has photos,
  // and the light logo sits on the cover.
  const brand = await getBrand();
  const heroUrl =
    coverAsset && r2Configured() ? await presignGet(displayKey(coverAsset, LIGHTBOX_SIZE)) : await brandImageUrl(brand, "default_cover");
  const coverLogo = await brandImageUrl(brand, "cover_logo");
  const favoriteIds = new Set((favsRes.data ?? []).map((f) => f.asset_id));

  // Downloads (5.5). The download route enforces all of this again; here it
  // only decides which buttons to show and what to tell the visitor.
  const downloadsOn = coverRow?.downloads_enabled !== false;
  const downloadableSets = new Set(sets.filter((s) => s.downloadable !== false).map((s) => s.id));
  const galleryLimit = (coverRow?.download_limit as number | null) ?? null;
  const personLimit = (coverRow?.per_person_download_limit as number | null) ?? null;
  let remaining: number | null = null;
  if (downloadsOn && (galleryLimit !== null || personLimit !== null)) {
    const { data: grants, error: grantsErr } = await db
      .from("download_grants")
      .select("asset_id, visitor_key")
      .eq("collection_id", collection.id);
    if (grantsErr) throw grantsErr;
    const rows = grants ?? [];
    remaining = remainingDownloads({
      galleryLimit,
      galleryUsed: new Set(rows.map((g) => g.asset_id)).size,
      personLimit,
      personUsed: visitorEmail ? rows.filter((g) => g.visitor_key === visitorEmail).length : 0,
    });
  }
  const needsEmailToDownload = downloadsOn && personLimit !== null && !visitorEmail;
  const dlMessage = dl === "not_ready" ? DOWNLOAD_NOT_READY : dl && isClaimRefusal(dl) ? CLAIM_REFUSALS[dl] : null;

  // Store (7.2): a Shop tab when David has turned the store on. Read on its
  // own so the gallery still works before migration 0025 adds the column.
  const { data: storeRow } = await db.from("collections").select("store_enabled").eq("id", collection.id).maybeSingle();
  const storeOn = storeRow?.store_enabled === true;
  const showShop = storeOn && setParam === SHOP_TAB;

  const showFavorites = setParam === FAVORITES_TAB && visitorEmail !== null;
  const activeSet = showFavorites ? undefined : (sets.find((s) => s.id === setParam) ?? sets[0]);
  const activeTab = showShop ? SHOP_TAB : showFavorites ? FAVORITES_TAB : (activeSet?.id ?? "");
  const setAssets = showShop
    ? []
    : showFavorites
    ? assets.filter((a) => favoriteIds.has(a.id))
    : activeSet
      ? assets.filter((a) => a.set_id === activeSet.id)
      : [];

  // Presigned GETs are local signing, no request to R2 per photo. The grid
  // uses the 640 variant, the lightbox 2048 (original until variants exist).
  // Videos play their web copy straight from R2, signed the same way (with a
  // longer expiry so a long film keeps playing). Only past the access check.
  let photos: GridPhoto[] = [];
  if (r2Configured()) {
    photos = await Promise.all(
      setAssets.map(async (a, i) => {
        const isVideo = a.kind === "video";
        const keys = isVideo ? playableKeys(a) : null;
        return {
        id: a.id,
        label: `${isVideo ? "Video" : "Photo"} ${i + 1}`,
        ratio: aspectRatio(a),
        gridUrl: isVideo ? (keys ? await presignGet(keys.poster, VIDEO_URL_TTL_SECONDS) : "") : await presignGet(displayKey(a, GRID_SIZE)),
        largeUrl: isVideo ? "" : await presignGet(displayKey(a, LIGHTBOX_SIZE)),
        video: isVideo
          ? { src: keys ? await presignGet(keys.web, VIDEO_URL_TTL_SECONDS) : null, duration: formatDuration(a.duration_seconds) }
          : undefined,
        downloadHref:
          downloadsOn && downloadableSets.has(a.set_id) && !needsEmailToDownload
            ? `/g/${collection.slug}/download/${a.id}`
            : null,
        favorited: favoriteIds.has(a.id),
        };
      })
    );
  }

  let shop: React.ReactNode = null;
  if (showShop) {
    const { products, variants } = await loadCatalog(db);
    const imageUrls = new Map<string, string>();
    if (r2Configured()) {
      for (const p of products) if (p.image_key) imageUrls.set(p.id, await presignGet(p.image_key));
    }
    shop = (
      <Shop
        products={products}
        variants={variants}
        imageUrls={imageUrls}
        lines={pricedCart(await readCart(collection.id), products, variants)}
        message={cartMessage}
        addToCart={addToCart.bind(null, collection.slug)}
        setCartQty={setCartQty.bind(null, collection.slug)}
        checkout={checkoutCart.bind(null, collection.slug)}
      />
    );
  }

  const saveEmail = setFavoritesEmail.bind(null, collection.slug, activeTab === SHOP_TAB ? "" : activeTab);
  const forgetEmail = clearFavoritesEmail.bind(null, collection.slug);
  const toggle = toggleFavorite.bind(null, collection.slug);

  const personLeft = remaining !== null && !needsEmailToDownload ? remaining : null;
  const freeLimit = personLimit ?? galleryLimit;
  const photoCount = assets.length;

  return (
    <>
      <style>{GALLERY_PALETTE}</style>
      <BrandAccent />
      <header className="ghero">
        {heroUrl && <img src={heroUrl} alt="" />}
        <div className="ghero-in">
          {coverLogo ? (
            <img src={coverLogo} alt={brand.businessName} className="ghero-logo" />
          ) : (
            <span className="gkicker">{brand.businessName}</span>
          )}
          <h1>{collection.name}</h1>
          <p className="ghero-meta">
            {collection.event_date && <span>{collection.event_date}</span>}
            <span>
              {photoCount} {photoCount === 1 ? "photograph" : "photographs"}
            </span>
          </p>
        </div>
      </header>

      <div className="gx">
        <aside className="gside">
          <div className="gside-in">
            {(sets.length > 1 || visitorEmail || storeOn) && (
              <nav aria-label="Sets" className="gsets">
                {sets.map((set) => {
                  const n = assets.filter((a) => a.set_id === set.id).length;
                  return set.id === activeTab ? (
                    <strong key={set.id} aria-current="page">
                      {set.name} <span>{n}</span>
                    </strong>
                  ) : (
                    <Link key={set.id} href={`/g/${collection.slug}?set=${set.id}`}>
                      {set.name} <span>{n}</span>
                    </Link>
                  );
                })}
                {visitorEmail &&
                  (showFavorites ? (
                    <strong aria-current="page">
                      Favorites <span>{favoriteIds.size}</span>
                    </strong>
                  ) : (
                    <Link href={`/g/${collection.slug}?set=${FAVORITES_TAB}`}>
                      Favorites <span>{favoriteIds.size}</span>
                    </Link>
                  ))}
                {storeOn &&
                  (showShop ? (
                    <strong aria-current="page">Shop</strong>
                  ) : (
                    <Link href={`/g/${collection.slug}?set=${SHOP_TAB}`}>Shop</Link>
                  ))}
              </nav>
            )}

            {personLeft !== null && freeLimit !== null && freeLimit > 0 && (
              <div className="gbox">
                <div className="gbox-row">
                  <span>Free downloads left</span>
                  <span>
                    {personLeft} of {freeLimit}
                  </span>
                </div>
                <div className="gmeter" aria-hidden="true">
                  <i style={{ width: `${Math.round((personLeft / freeLimit) * 100)}%` }} />
                </div>
                <p>
                  {personLeft === 0
                    ? "Photos you've already downloaded can be downloaded again."
                    : "Downloading a photo again doesn't use one."}
                </p>
              </div>
            )}
            {dlMessage && (
              <p role="alert" className="gnote">
                {dlMessage}
              </p>
            )}

            {visitorEmail ? (
              <form action={forgetEmail} className="gwho">
                Saving favorites as <strong>{visitorEmail}</strong>{" "}
                <button type="submit">Not you?</button>
              </form>
            ) : (
              <form action={saveEmail} className="gmail">
                <label htmlFor="fav-email">
                  {personLimit !== null && downloadsOn
                    ? "Enter your email to save favorites and download"
                    : "Enter your email to save favorites"}
                </label>
                <input id="fav-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
                <button type="submit">Continue</button>
              </form>
            )}
            {fav && FAV_ERRORS[fav] && (
              <p role="alert" className="gnote">
                {FAV_ERRORS[fav]}
              </p>
            )}
          </div>
        </aside>

        <main className="gmain" id="photos">
          {showShop ? (
            shop
          ) : setAssets.length > 0 && !r2Configured() ? (
            <p>Photos aren&apos;t available right now. Please try again later.</p>
          ) : (
            <GalleryGrid
              key={activeTab}
              photos={photos}
              toggleFavorite={visitorEmail ? toggle : null}
              emptyText={showFavorites ? "No favorites yet. Tap the heart on a photo to add it." : undefined}
            />
          )}
        </main>
      </div>
      <div className="gfoot">
        <BrandFooter />
      </div>
    </>
  );
}
