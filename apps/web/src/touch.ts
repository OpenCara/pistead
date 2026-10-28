/**
 * Touch-screen behaviour. A phone is a touch screen whose shorter side is under 600 CSS pixels: its chat boxes add a line
 * on Enter (the on-screen keyboard has no Shift) and send with the button, as messaging apps do. Tablets, which often
 * have a keyboard attached, keep Enter to send.
 */
export function isPhone(): boolean {
  return coarsePointer() && Math.min(window.screen.width, window.screen.height) < 600;
}

/** A finger rather than a mouse: focusing a search box there opens the on-screen keyboard over the list it filters. */
export function coarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

/** Whether Enter (without Shift, outside IME composition) sends the message in a chat box. */
export function enterSends(): boolean {
  return !isPhone();
}

/**
 * Keeps `--viewport-height` at the visible height on touch screens. iOS Safari doesn't shrink the layout (or `100dvh`)
 * when its keyboard opens, so the chat box at the bottom of a full-height app would sit under the keyboard; sizing the
 * app to the visual viewport keeps it just above. Pinch zoom also shrinks the visual viewport, so a zoomed page keeps
 * the last unzoomed height.
 */
export function trackVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport || !coarsePointer()) return;
  const root = document.documentElement;
  const update = () => {
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty("--viewport-height", `${Math.round(viewport.height)}px`);
    // iOS pans the page to reveal a focused field even when it is already visible; the app fits the viewport, so undo it.
    if (window.scrollY !== 0 && document.body.scrollHeight <= viewport.height + 1) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
}
