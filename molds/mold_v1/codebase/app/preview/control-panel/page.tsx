import { ControlPanelPreview } from "./preview";

/**
 * The Control Panel over a chat with seven specialists, dev only (see ../layout.tsx): no auth, no database. The
 * specialists' own streams are answered by the spec (tests/control-panel.spec.ts), which plays a large finished one,
 * a stalled one, a slow one, two small ones, a running one whose first read fails, and a parked one asking a
 * question. The page offers what the chat around a real panel does to it: say the conversation is up (the chat's
 * `harvestReady`), remount it (a resync or reattach), and leave for another chat and come back.
 */
export default function ControlPanelPage() {
  return <ControlPanelPreview />;
}
