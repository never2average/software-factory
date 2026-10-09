"use client";

import { cn } from "@/lib/utils";
import { CustomerMark } from "./customer-mark";

/**
 * The workspace's mark. Renders the uploaded logo when the org has one
 * (Workspace → click the org avatar), and otherwise falls back to the SAME
 * generated monogram language we use for customers — deterministic hue + up to
 * two initials — so a workspace without a logo still reads as a real brand tile
 * rather than a generic building glyph.
 */
export function OrgMark({
  name,
  logoUrl,
  size = "md",
  className,
}: {
  readonly name: string;
  readonly logoUrl?: string | null;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}) {
  if (!logoUrl) return <CustomerMark name={name || "Workspace"} size={size} className={className} />;
  const box = size === "lg" ? "size-9 rounded-lg" : size === "sm" ? "size-5 rounded-[5px]" : "size-7 rounded-md";
  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden border border-border/60", box, className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logoUrl} alt="" className="size-full object-cover" />
    </span>
  );
}

/**
 * Downscale a picked image to a square data URI. Stored inline on the org's
 * `branding` (a few KB of jsonb) — which keeps it CSP-safe (`img-src data:`)
 * with no extra host to allow and no public bucket to manage.
 */
export function toLogoDataUrl(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a readable image."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable."));
        // Cover-crop to a square so non-square logos aren't distorted.
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
