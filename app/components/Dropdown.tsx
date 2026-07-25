"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption<T> {
  key: string;
  label: string;
  value: T;
}

interface DropdownProps<T> {
  id?: string;
  options: DropdownOption<T>[];
  selectedKey: string | null | undefined;
  onSelect: (option: DropdownOption<T>) => void;
  placeholder?: string;
  ariaLabel: string;
  // Extra class on the portaled panel — for callers that need to scope
  // styling (e.g. font size) to one particular Dropdown instance, since
  // the panel is portaled to document.body and isn't reachable via a
  // normal descendant selector from the trigger's own wrapper.
  panelClassName?: string;
}

const VIEWPORT_MARGIN = 12;
const PANEL_GAP = 6;

// Generic custom dropdown standing in for a native <select> — the panel
// is portaled into document.body (same reasoning as InfoTooltip.tsx: an
// ancestor's own entrance animation can end up establishing a stacking
// context that paints above a same-DOM-position absolutely-positioned
// panel regardless of z-index, since z-index only competes within a
// shared stacking context), and the open/close transition is a small,
// deliberate fade rather than, e.g., iOS Safari's own native
// picker-opening animation, which can't be restyled or disabled via CSS.
//
// Follows the WAI-ARIA "select-only combobox" pattern: focus stays on
// the trigger button, the active option is tracked via
// aria-activedescendant rather than moving focus into the listbox.
export default function Dropdown<T>({
  id,
  options,
  selectedKey,
  onSelect,
  placeholder = "Select an option",
  ariaLabel,
  panelClassName,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((o) => o.key === String(selectedKey));
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => setMounted(true), []);

  function reposition() {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const minLeft = window.scrollX + VIEWPORT_MARGIN;
    const maxLeft = window.scrollX + window.innerWidth - VIEWPORT_MARGIN - rect.width;
    const left = Math.min(Math.max(rect.left + window.scrollX, minLeft), maxLeft);
    const top = rect.bottom + window.scrollY + PANEL_GAP;

    setCoords({ top, left, width: rect.width });
  }

  function openList() {
    if (options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    reposition();
    setOpen(true);
  }

  function closeList() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function commitSelection(index: number) {
    const option = options[index];
    if (!option) return;
    onSelect(option);
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const activeEl = panelRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function handleButtonKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commitSelection(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closeList();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div className="dropdown-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && options[activeIndex] ? `dropdown-option-${listboxId}-${options[activeIndex].key}` : undefined}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={handleButtonKeyDown}
      >
        {selectedOption ? selectedOption.label : placeholder}
      </button>

      {mounted &&
        createPortal(
          <ul
            ref={panelRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className={`dropdown-panel ${panelClassName || ""} ${open ? "dropdown-panel-open" : ""}`}
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            {options.map((option, index) => {
              const isSelected = option.key === String(selectedKey);
              const isActive = index === activeIndex;
              return (
                <li
                  key={option.key}
                  id={`dropdown-option-${listboxId}-${option.key}`}
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  className={`dropdown-option ${isActive ? "dropdown-option-active" : ""} ${isSelected ? "dropdown-option-selected" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commitSelection(index)}
                >
                  {option.label}
                </li>
              );
            })}
          </ul>,
          document.body
        )}
    </div>
  );
}
