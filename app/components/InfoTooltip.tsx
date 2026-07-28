"use client";

import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";

const VIEWPORT_MARGIN = 12;
const PANEL_GAP = 10;
const CLOSE_DELAY = 150;
// "left" placement assumes room beside the trigger — on a narrow viewport
// a left-edge trigger (e.g. the fighter A flag) has nowhere to its left
// at all, so below this width it falls back to opening below instead,
// same as the default placement. Matches the breakpoint the rest of the
// app's mobile layout switches at.
const LEFT_PLACEMENT_MIN_WIDTH = 768;

// Reusable info/disclosure trigger used beside section titles and the nav
// "about" icon. The panel is rendered through a portal into document.body
// — every card has `overflow: hidden` (to clip content to its rounded
// corners), which would otherwise clip a panel positioned inside it.
// Portaling also lets us compute an exact, viewport-clamped position
// instead of guessing with CSS alone.
//
// Desktop uses real hover-intent: entering the trigger OR the panel keeps
// it open, and leaving both starts a short close delay so the small gap
// between them doesn't cause flicker. Touch is handled entirely through
// onClick (pointerType checks skip touch-originated pointer events so a
// tap doesn't get opened-then-immediately-closed by a synthetic hover).
export default function InfoTooltip({
  label,
  children,
  width = 240,
  trigger,
  triggerClassName,
  placement = "bottom",
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  width?: number;
  // When provided, this renders as the trigger itself (e.g. an existing
  // badge) instead of the default "i" icon — for cases where the icon
  // would be redundant with something already there to hover/tap.
  trigger?: React.ReactNode;
  triggerClassName?: string;
  // "left" opens beside the trigger instead of below it — for triggers
  // sitting directly above other content, where a panel below would
  // cover it (e.g. the flag icons above the fighter record row).
  placement?: "bottom" | "left";
  // Skips the fixed `width` box and shrinks the panel to its content
  // instead — for short single-line labels (e.g. a country name) where
  // the standard paragraph-sized box reads as oversized.
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width, arrowLeft: width / 2, arrowTop: 0 });
  // Tracks which placement actually got used the last time reposition()
  // ran — may differ from the `placement` prop on a narrow viewport (see
  // LEFT_PLACEMENT_MIN_WIDTH). Drives the arrow's style, since it has to
  // match whichever positioning math coords was actually computed with.
  const [resolvedPlacement, setResolvedPlacement] = useState(placement);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    function reposition() {
      const btn = btnRef.current;
      const panel = panelRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();

      const effectivePlacement =
        placement === "left" && window.innerWidth < LEFT_PLACEMENT_MIN_WIDTH ? "bottom" : placement;
      setResolvedPlacement(effectivePlacement);

      if (effectivePlacement === "left") {
        // The panel is always mounted (just opacity: 0 while closed — see
        // the render below), so it already has real layout dimensions to
        // measure here, compact/content-sized width included.
        const panelWidth = panel?.offsetWidth || width;
        const panelHeight = panel?.offsetHeight || 0;

        const minLeft = window.scrollX + VIEWPORT_MARGIN;
        const desiredLeft = rect.left + window.scrollX - PANEL_GAP - panelWidth;
        const left = Math.max(desiredLeft, minLeft);

        const targetCenterY = rect.top + window.scrollY + rect.height / 2;
        const minTop = window.scrollY + VIEWPORT_MARGIN;
        const top = Math.max(targetCenterY - panelHeight / 2, minTop);

        const arrowTop = Math.min(Math.max(targetCenterY - top, 14), Math.max(panelHeight - 14, 14));

        setCoords({ top, left, width: panelWidth, arrowLeft: 0, arrowTop });
        return;
      }

      // Compact panels shrink to their content instead of the fixed
      // `width` prop — measure the real rendered width so the clamp/arrow
      // math below lines up with what's actually on screen, same as the
      // "left" branch already does.
      const rawWidth = compact ? panel?.offsetWidth || width : width;
      const available = window.innerWidth - VIEWPORT_MARGIN * 2;
      const effectiveWidth = Math.min(rawWidth, available);

      const minLeft = window.scrollX + VIEWPORT_MARGIN;
      const maxLeft = window.scrollX + window.innerWidth - VIEWPORT_MARGIN - effectiveWidth;
      const left = Math.min(Math.max(rect.left + window.scrollX, minLeft), maxLeft);
      const top = rect.bottom + window.scrollY + PANEL_GAP;

      const targetCenter = rect.left + window.scrollX + rect.width / 2;
      const arrowLeft = Math.min(Math.max(targetCenter - left, 14), effectiveWidth - 14);

      setCoords({ top, left, width: effectiveWidth, arrowLeft, arrowTop: 0 });
    }

    reposition();
    window.addEventListener("resize", reposition);

    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, width, placement, compact]);

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openNow() {
    clearCloseTimer();
    setOpen(true);
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  }

  // Touch doesn't have real hover — pointerType lets us ignore the
  // synthetic pointer events some browsers fire on tap, so a tap only
  // ever goes through onClick below instead of being opened by "hover"
  // and immediately toggled shut again by the click that follows it.
  function handlePointerEnter(e: PointerEvent) {
    if (e.pointerType !== "mouse") return;
    openNow();
  }

  function handlePointerLeave(e: PointerEvent) {
    if (e.pointerType !== "mouse") return;
    scheduleClose();
  }

  function handleClick() {
    clearCloseTimer();
    setOpen((v) => !v);
  }

  function handleBlur(e: FocusEvent<HTMLButtonElement>) {
    if (e.relatedTarget !== panelRef.current) {
      clearCloseTimer();
      setOpen(false);
    }
  }

  return (
    <div className="info-tooltip" ref={wrapperRef}>
      <button
        ref={btnRef}
        type="button"
        className={trigger ? `info-tooltip-btn-custom ${triggerClassName || ""}` : "info-tooltip-btn"}
        aria-label={trigger ? undefined : `${label} info`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={panelId}
        onClick={handleClick}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={openNow}
        onBlur={handleBlur}
      >
        {trigger || "i"}
      </button>

      {mounted &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            role="tooltip"
            className={`info-tooltip-panel ${compact ? "info-tooltip-panel-compact" : ""} ${open ? "info-tooltip-panel-open" : ""}`}
            style={{
              top: coords.top,
              left: coords.left,
              ...(compact ? {} : { width: coords.width }),
            }}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            <span
              className={`info-tooltip-arrow ${resolvedPlacement === "left" ? "info-tooltip-arrow-left" : ""}`}
              style={resolvedPlacement === "left" ? { top: coords.arrowTop } : { left: coords.arrowLeft }}
            />
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}
