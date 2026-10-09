import type { MetadataRoute } from "next";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";

/**
 * The web app manifest, so the product can be ADDED TO THE HOME SCREEN as an app — which is the only way iPhone and
 * iPad Safari deliver Web Push (desktop notifications, app/_components/desktop-notify.ts). Elsewhere it only lets a
 * person install the product as its own window; nothing about the page changes.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
