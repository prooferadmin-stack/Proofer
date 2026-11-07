"use server";

// Collection / set / photo CRUD + the presigned upload flow. Every action
// checks requireAdmin() first (outside any try, since it redirects by
// throwing), then uses the service-role client directly. Validation mirrors
// the DB checks in 0011_galleries.sql.
import { revalidatePath } from "next/cache";
import { parsePriceDollars } from "@/lib/galleries/paid-downloads";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth/require-admin";
import { deletePrefix, headObjectSize, presignPut, r2Configured } from "@/lib/r2";
import {
  assetPrefix,
  collectionPrefix,
  mediaKind,
  originalKey,
  validateUpload,
  type UploadRequest,
} from "@/lib/galleries/media-rules";
import {
  VISIBILITIES,
  hashPassword,
  normalizePassword,
  validatePassword,
  type Visibility,
} from "@/lib/galleries/access";
import { isDownloadSize, parseLimit } from "@/lib/galleries/download";

function str(raw: FormDataEntryValue | null): string | null {
  const v = raw ? String(raw).trim() : "";
  return v.length > 0 ? v : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectionFields(formData: FormData) {
  const name = str(formData.get("name"));
  if (!name) throw new Error("Name is required");

  const slug = slugify(str(formData.get("slug")) ?? name);
  if (!slug) throw new Error("Slug must contain at least one letter or number");

  return { name, slug, event_date: str(formData.get("event_date")) };
}

// Postgres unique_violation — the only constraint on collections that can
// collide is the slug.
function rethrow(error: { code?: string }, slug: string): never {
  if (error.code === "23505") throw new Error(`Slug "${slug}" is already used by another collection`);
  throw error;
}

function revalidateCollection(id: string) {
  revalidatePath("/admin/galleries");
  revalidatePath(`/admin/galleries/${id}`);
}

// ---------------------------------------------------------------- collections

export async function createCollection(formData: FormData) {
  await requireAdmin();
  const fields = collectionFields(formData);
  const link = await resolveLink(null, str(formData.get("project_id")));

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("collections")
    .insert({ ...fields, ...link })
    .select("id")
    .single();
  if (error) rethrow(error, fields.slug);

  // Every collection starts with one set, so photos always have somewhere to go.
  const { error: setErr } = await db.from("photo_sets").insert({ collection_id: data.id, name: "All photos" });
  if (setErr) throw setErr;

  revalidatePath("/admin/galleries");
  if (link.project_id) revalidatePath(`/admin/projects/${link.project_id}`);
  redirect(`/admin/galleries/${data.id}`);
}

export async function updateCollection(id: string, formData: FormData) {
  await requireAdmin();
  const fields = collectionFields(formData);

  const db = supabaseAdmin();
  const { error } = await db
    .from("collections")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) rethrow(error, fields.slug);

  revalidateCollection(id);
}

export async function setCollectionStatus(id: string, status: "draft" | "published") {
  await requireAdmin();
  if (status !== "draft" && status !== "published") throw new Error("Invalid status");

  const db = supabaseAdmin();
  const { error } = await db
    .from("collections")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;

  revalidateCollection(id);
}

// Visibility + gallery password (5.3). The password is hashed here and never
// stored or echoed in plaintext. Changing visibility or setting a new password
// bumps access_version, which signs every visitor out of this gallery.
export async function updateCollectionAccess(id: string, formData: FormData) {
  await requireAdmin();
  const visibility = String(formData.get("visibility") ?? "") as Visibility;
  if (!VISIBILITIES.includes(visibility)) throw new Error("Invalid visibility");
  const password = normalizePassword(String(formData.get("password") ?? ""));

  const db = supabaseAdmin();
  const { data: current, error: loadErr } = await db
    .from("collections")
    .select("visibility, password_hash, access_version")
    .eq("id", id)
    .single();
  if (loadErr) throw loadErr;

  let passwordHash: string | null = null;
  if (visibility === "password") {
    if (password) {
      validatePassword(password);
      passwordHash = await hashPassword(password);
    } else if (current.password_hash) {
      passwordHash = current.password_hash;
    } else {
      throw new Error("Set a password to make this gallery password-protected");
    }
  }

  const changed = visibility !== current.visibility || passwordHash !== current.password_hash;
  if (!changed) return;

  const { error } = await db
    .from("collections")
    .update({
      visibility,
      password_hash: passwordHash,
      access_version: current.access_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;

  revalidateCollection(id);
}

// CRM link (5.6). Picking only a project also links that project's contact,
// since a gallery for a project is that client's gallery.
async function resolveLink(contactId: string | null, projectId: string | null) {
  if (!projectId) return { contact_id: contactId, project_id: null };

  const { data: project, error } = await supabaseAdmin()
    .from("projects")
    .select("id, contact_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!project) throw new Error("That project no longer exists");
  return { contact_id: contactId ?? project.contact_id, project_id: project.id };
}

export async function updateCollectionLink(id: string, formData: FormData) {
  await requireAdmin();
  const link = await resolveLink(str(formData.get("contact_id")), str(formData.get("project_id")));

  const { error } = await supabaseAdmin()
    .from("collections")
    .update({ ...link, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;

  revalidateCollection(id);
  if (link.project_id) revalidatePath(`/admin/projects/${link.project_id}`);
}

// R2 objects go first: if that fails the rows survive and the delete can be
// retried, rather than leaving orphaned files nobody can find.
export async function deleteCollection(id: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const { count, error: countErr } = await db
    .from("media_assets")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", id);
  if (countErr) throw countErr;

  if (r2Configured()) {
    await deletePrefix(collectionPrefix(id));
  } else if ((count ?? 0) > 0) {
    throw new Error("R2 isn't configured, so this collection's photos can't be removed from storage yet");
  }

  const { error } = await db.from("collections").delete().eq("id", id);
  if (error) throw error;

  revalidatePath("/admin/galleries");
  redirect("/admin/galleries");
}

// ----------------------------------------------------------------------- sets

export async function createSet(collectionId: string, formData: FormData) {
  await requireAdmin();
  const name = str(formData.get("name"));
  if (!name) throw new Error("Set name is required");

  const db = supabaseAdmin();
  const { error } = await db.from("photo_sets").insert({ collection_id: collectionId, name });
  if (error) throw error;

  revalidateCollection(collectionId);
}

export async function renameSet(setId: string, collectionId: string, formData: FormData) {
  await requireAdmin();
  const name = str(formData.get("name"));
  if (!name) throw new Error("Set name is required");

  const db = supabaseAdmin();
  const { error } = await db
    .from("photo_sets")
    .update({ name })
    .eq("id", setId)
    .eq("collection_id", collectionId);
  if (error) throw error;

  revalidateCollection(collectionId);
}

// Swaps position with the nearest neighbour in the given direction. Positions
// come from a sequence (never tied), so a swap is always well-defined.
async function swapWithNeighbour(
  table: "photo_sets" | "media_assets",
  scope: { column: "collection_id" | "set_id"; value: string },
  id: string,
  position: number,
  direction: "up" | "down"
) {
  const db = supabaseAdmin();
  const { data: neighbour, error } = await db
    .from(table)
    .select("id, position")
    .eq(scope.column, scope.value)
    .filter("position", direction === "up" ? "lt" : "gt", position)
    .order("position", { ascending: direction === "down" })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!neighbour) return;

  const [a, b] = await Promise.all([
    db.from(table).update({ position: neighbour.position }).eq("id", id),
    db.from(table).update({ position }).eq("id", neighbour.id),
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
}

export async function moveSet(setId: string, direction: "up" | "down") {
  await requireAdmin();
  const db = supabaseAdmin();
  const { data: set, error } = await db
    .from("photo_sets")
    .select("id, collection_id, position")
    .eq("id", setId)
    .single();
  if (error) throw error;

  await swapWithNeighbour(
    "photo_sets",
    { column: "collection_id", value: set.collection_id },
    set.id,
    set.position,
    direction
  );
  revalidateCollection(set.collection_id);
}

export async function deleteSet(setId: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const { data: set, error } = await db
    .from("photo_sets")
    .select("id, collection_id")
    .eq("id", setId)
    .single();
  if (error) throw error;

  const { count: setCount, error: countErr } = await db
    .from("photo_sets")
    .select("id", { count: "exact", head: true })
    .eq("collection_id", set.collection_id);
  if (countErr) throw countErr;
  if ((setCount ?? 0) <= 1) throw new Error("A collection needs at least one set");

  const { data: assets, error: assetsErr } = await db.from("media_assets").select("id").eq("set_id", setId);
  if (assetsErr) throw assetsErr;

  if (assets && assets.length > 0) {
    if (!r2Configured()) {
      throw new Error("R2 isn't configured, so this set's photos can't be removed from storage yet");
    }
    const prefixes = assets.map((a) => assetPrefix(set.collection_id, a.id));
    await deletePrefix(collectionPrefix(set.collection_id), (key) => prefixes.some((p) => key.startsWith(p)));
  }

  // media_assets rows go with the set (on delete cascade).
  const { error: deleteErr } = await db.from("photo_sets").delete().eq("id", setId);
  if (deleteErr) throw deleteErr;

  revalidateCollection(set.collection_id);
}

// --------------------------------------------------------------------- photos

export async function moveAsset(assetId: string, direction: "up" | "down") {
  await requireAdmin();
  const db = supabaseAdmin();
  const { data: asset, error } = await db
    .from("media_assets")
    .select("id, collection_id, set_id, position")
    .eq("id", assetId)
    .single();
  if (error) throw error;

  await swapWithNeighbour(
    "media_assets",
    { column: "set_id", value: asset.set_id },
    asset.id,
    asset.position,
    direction
  );
  revalidatePath(`/admin/galleries/${asset.collection_id}`);
}

export async function deleteAsset(assetId: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const { data: asset, error } = await db
    .from("media_assets")
    .select("id, collection_id")
    .eq("id", assetId)
    .single();
  if (error) throw error;

  if (!r2Configured()) throw new Error("R2 isn't configured, so this photo can't be removed from storage yet");
  await deletePrefix(assetPrefix(asset.collection_id, asset.id));

  const { error: deleteErr } = await db.from("media_assets").delete().eq("id", assetId);
  if (deleteErr) throw deleteErr;

  revalidatePath(`/admin/galleries/${asset.collection_id}`);
}

// Pick the gallery's cover photo. The photo must be uploaded and belong to this
// gallery, so a forged asset id can't point a cover at someone else's photo.
export async function setCover(collectionId: string, assetId: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const { data: asset, error } = await db
    .from("media_assets")
    .select("id")
    .eq("id", assetId)
    .eq("collection_id", collectionId)
    .eq("status", "uploaded")
    .eq("kind", "photo")
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new Error("That photo can't be the cover (it isn't an uploaded photo in this gallery)");

  const { error: updateErr } = await db.from("collections").update({ cover_asset_id: assetId }).eq("id", collectionId);
  if (updateErr) throw updateErr;

  revalidateCollection(collectionId);
}

// --------------------------------------------------------------------- upload
// Called from the uploader client component, one file at a time. These return
// errors instead of throwing so the browser can show which file failed and
// carry on with the rest.

type StartResult = { ok: true; assetId: string; url: string } | { ok: false; error: string };
type FinishResult = { ok: true } | { ok: false; error: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export async function startUpload(collectionId: string, setId: string, file: UploadRequest): Promise<StartResult> {
  await requireAdmin();
  try {
    if (!r2Configured()) return { ok: false, error: "R2 isn't configured yet, uploads are disabled" };
    const ext = validateUpload(file);

    const db = supabaseAdmin();
    const { data: set, error: setErr } = await db
      .from("photo_sets")
      .select("id")
      .eq("id", setId)
      .eq("collection_id", collectionId)
      .maybeSingle();
    if (setErr) throw setErr;
    if (!set) return { ok: false, error: "That set doesn't belong to this collection" };

    // The key is built from server-generated ids only; the client's filename
    // is kept for display and never touches the storage path.
    const assetId = crypto.randomUUID();
    const r2Key = originalKey(collectionId, assetId, ext);
    const { error } = await db.from("media_assets").insert({
      id: assetId,
      collection_id: collectionId,
      set_id: setId,
      r2_key: r2Key,
      original_filename: String(file.name).slice(0, 255),
      content_type: file.type,
      size_bytes: file.size,
      // Only sent for videos, so photo uploads still work before 0029 is run.
      ...(mediaKind(file.type) === "video" ? { kind: "video" } : {}),
    });
    if (error) throw error;

    const url = await presignPut(r2Key, file.type);
    return { ok: true, assetId, url };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

// Marks an asset uploaded only after R2 confirms the object exists with the
// size that was declared at start. Anything else is cleaned up.
export async function finishUpload(assetId: string): Promise<FinishResult> {
  await requireAdmin();
  try {
    const db = supabaseAdmin();
    const { data: asset, error } = await db
      .from("media_assets")
      .select("id, collection_id, r2_key, size_bytes, status")
      .eq("id", assetId)
      .single();
    if (error) throw error;
    if (asset.status === "uploaded") return { ok: true };

    const size = await headObjectSize(asset.r2_key);
    if (size === null || size !== Number(asset.size_bytes)) {
      if (size !== null) await deletePrefix(assetPrefix(asset.collection_id, asset.id));
      await db.from("media_assets").delete().eq("id", asset.id);
      return {
        ok: false,
        error: size === null ? "Upload didn't reach storage" : "Uploaded file size didn't match, discarded",
      };
    }

    const { error: updateErr } = await db.from("media_assets").update({ status: "uploaded" }).eq("id", asset.id);
    if (updateErr) throw updateErr;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

// Photo sizes and video web copies (made by the hourly variants job) stop
// retrying after a few failures. This gives one asset a fresh set of tries,
// e.g. after re-uploading a damaged file's replacement or a job fix.
export async function retryProcessing(assetId: string) {
  await requireAdmin();
  const { data: asset, error } = await supabaseAdmin()
    .from("media_assets")
    .update({ variant_attempts: 0, variant_error: null })
    .eq("id", assetId)
    .eq("status", "uploaded")
    .eq("variants_ready", false)
    .select("collection_id")
    .maybeSingle();
  if (error) throw error;
  if (asset) revalidatePath(`/admin/galleries/${asset.collection_id}`);
}

// Download limits (5.5). Settings only: the counting and enforcement live in
// claim_download() in the database. Lowering a limit below what's already
// been used just stops new downloads; nothing is taken back.
export async function updateDownloadSettings(id: string, formData: FormData) {
  await requireAdmin();
  const size = String(formData.get("download_size") ?? "");
  if (!isDownloadSize(size)) throw new Error("Invalid download size");
  const { error } = await supabaseAdmin()
    .from("collections")
    .update({
      downloads_enabled: formData.get("downloads_enabled") === "on",
      download_size: size,
      download_limit: parseLimit(String(formData.get("download_limit") ?? "")),
      per_person_download_limit: parseLimit(String(formData.get("per_person_download_limit") ?? "")),
      // Paid extra downloads (5.7): blank = buying off.
      extra_download_price_cents: parsePriceDollars(String(formData.get("extra_download_price") ?? "")),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
  revalidateCollection(id);
}

// Shows or hides the gallery's Shop tab (7.2).
export async function updateStoreSettings(id: string, formData: FormData) {
  await requireAdmin();
  const { error } = await supabaseAdmin()
    .from("collections")
    .update({ store_enabled: formData.get("store_enabled") === "on", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  revalidateCollection(id);
}

export async function setSetDownloadable(setId: string, collectionId: string, downloadable: boolean) {
  await requireAdmin();
  const { error } = await supabaseAdmin()
    .from("photo_sets")
    .update({ downloadable })
    .eq("id", setId)
    .eq("collection_id", collectionId);
  if (error) throw error;
  revalidateCollection(collectionId);
}
