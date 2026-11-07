import type { Variants } from "@/lib/galleries/variants";
import type { Visibility } from "@/lib/galleries/access";

export type Collection = {
  id: string;
  name: string;
  slug: string;
  event_date: string | null;
  status: "draft" | "published";
  visibility: Visibility;
  password_hash: string | null;
  access_version: number;
  contact_id: string | null;
  project_id: string | null;
  cover_asset_id?: string | null; // added in 0019; absent until that migration is run
  // Download limits (5.5, migration 0021); absent until it's run.
  downloads_enabled?: boolean;
  download_size?: string;
  download_limit?: number | null;
  per_person_download_limit?: number | null;
  extra_download_price_cents?: number | null;
  created_at: string;
  updated_at: string;
};

export type PhotoSet = {
  id: string;
  collection_id: string;
  name: string;
  position: number;
  downloadable?: boolean; // 0021
};

export type MediaAsset = {
  id: string;
  collection_id: string;
  set_id: string;
  kind: "photo" | "video";
  r2_key: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  status: "pending" | "uploaded";
  position: number;
  created_at: string;
  variants: Variants;
  variants_ready: boolean;
  variant_attempts: number;
  variant_error: string | null;
  // Video (Phase 6, migration 0029); absent until it's run, null for photos.
  duration_seconds?: number | null;
};
