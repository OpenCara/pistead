import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const GAP = 4;
const MARGIN = 8;

export interface PopoverPlacement {
  top: number;
  left: number;
  /** Height the content may use before it has to scroll. */
  maxHeight: number;
  side: "below" | "above";
}

/**
 * Where a popover of `size` fits next to `anchor`. Prefers `side`, flips when the other side has
 * more room and the preferred side cannot hold the content, keeps `MARGIN` from every viewport
 * edge, and reports the height available so long lists scroll instead of running off screen.
 */
export function placePopover(anchor: DOMRect, size: { width: number; height: number }, side: "below" | "above", align: "start" | "end"): PopoverPlacement {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const below = viewportHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const preferred = side === "below" ? below : above;
  const other = side === "below" ? above : below;
  const chosen = preferred >= size.height || preferred >= other ? side : side === "below" ? "above" : "below";
  const room = chosen === "below" ? below : above;
  const maxHeight = Math.max(80, Math.floor(room));
  const height = Math.min(size.height, maxHeight);
  const top = chosen === "below" ? anchor.bottom + GAP : anchor.top - GAP - height;
  const wanted = align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.min(Math.max(MARGIN, wanted), Math.max(MARGIN, viewportWidth - MARGIN - size.width));
  return { top, left, maxHeight, side: chosen };
}

/**
 * Popover content rendered into `document.body`, positioned against `anchor`, so no `overflow`
 * on a card, sheet, panel or scroll pane can clip it. Repositions on scroll and resize.
 */
export function Popover({ anchor, side = "below", align = "start", className = "", role, id, label, style, children }: {
  anchor: RefObject<HTMLElement | null>;
  side?: "below" | "above";
  align?: "start" | "end";
  className?: string;
  role?: string;
  id?: string;
  label?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const target = anchor.current;
    if (!element || !target) return;
    const update = () => {
      // Measure the natural size with no height cap, then fit it.
      element.style.maxHeight = "";
      const { width, height } = element.getBoundingClientRect();
      setPlacement(placePopover(target.getBoundingClientRect(), { width, height }, side, align));
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); document.removeEventListener("scroll", update, true); };
  }, [anchor, side, align]);
  const positioned: CSSProperties = placement
    ? { position: "fixed", top: placement.top, left: placement.left, maxHeight: placement.maxHeight, visibility: "visible" }
    : { position: "fixed", top: 0, left: 0, visibility: "hidden" };
  // A modal <dialog> makes the rest of the document inert, so a popover opened from a sheet must live inside it.
  const host = anchor.current?.closest("dialog[open]") ?? document.body;
  return createPortal(
    <div ref={ref} className={`popover portal ${placement?.side ?? side} ${className}`.trim()} role={role} id={id} aria-label={label} style={{ ...positioned, ...style }}>{children}</div>,
    host,
  );
}
