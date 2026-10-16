// One lucide glyph by its own module (app/_components/ops/record-hub.tsx loads a profile's hub glyph on first use).
declare module "lucide-react/dist/esm/icons/*.mjs" {
  const Icon: import("lucide-react").LucideIcon;
  export default Icon;
}
