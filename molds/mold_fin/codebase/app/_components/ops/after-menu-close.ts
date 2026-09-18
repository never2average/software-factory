/**
 * Open a dialog from a dropdown menu item WITHOUT freezing the page.
 *
 * Radix's DismissableLayer disables pointer events on <body> while a modal
 * layer is open, and on cleanup restores whatever the value was when that layer
 * mounted:
 *
 *   originalBodyPointerEvents = ownerDocument.body.style.pointerEvents;  // captured
 *   ownerDocument.body.style.pointerEvents = "none";
 *   …
 *   ownerDocument.body.style.pointerEvents = originalBodyPointerEvents;  // restored
 *
 * A menu is itself such a layer. So a dialog opened in the same tick as the
 * menu item's select mounts while the body is ALREADY "none", captures "none"
 * as the original, and faithfully restores it when the dialog closes — leaving
 * a page that renders perfectly and ignores every click. Nothing looks broken,
 * which is what makes it so disorienting.
 *
 * Deferring by two frames lets the menu unmount and put the body back to "" (or
 * whatever it truly was) before the dialog's layer captures it. Two rather than
 * one because the first frame runs Radix's cleanup and the second lets the
 * style land before another layer reads it.
 */
export function afterMenuClose(run: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    // Non-browser (SSR, tests): nothing to sequence around.
    run();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(run));
}
