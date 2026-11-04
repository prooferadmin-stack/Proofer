"use client";

// Gift card design image (2.7): presigned URL from the server, PUT straight
// to R2, then the server saves it. Same flow as product images.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveGiftCardDesignImage, startGiftCardDesignUpload } from "../actions";

export function DesignImageUpload({ designId, hasImage }: { designId: string; hasImage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const start = await startGiftCardDesignUpload(designId, { type: file.type, size: file.size });
      if (!start.ok) throw new Error(start.error);
      const res = await fetch(start.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const saved = await saveGiftCardDesignImage(designId, start.key);
      if (!saved.ok) throw new Error(saved.error ?? "Couldn't save the image");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="brand-upload">
      <label className={`btn sm${busy ? " disabled" : ""}`}>
        {busy ? "Uploading…" : hasImage ? "Replace photo" : "Upload photo"}
        <input
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) void upload(f);
          }}
        />
      </label>
      {error && <span className="err small"> {error}</span>}
    </span>
  );
}
