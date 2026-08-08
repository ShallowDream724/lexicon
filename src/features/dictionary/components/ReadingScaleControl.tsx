"use client";

import { Type } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  readingScaleFromIndex,
  readingScaleIndex,
  readingScaleOptions,
  type ReadingScale,
} from "../reading-scale";

type ReadingScaleControlProps = {
  value: ReadingScale;
  onChange: (value: ReadingScale) => void;
};

export function ReadingScaleControl({ value, onChange }: ReadingScaleControlProps) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const activeIndex = readingScaleIndex(value);
  const activeOption = readingScaleOptions[activeIndex];

  useEffect(() => {
    if (!open) {
      return;
    }

    sliderRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="reading-scale-control" ref={controlRef}>
      <button
        ref={triggerRef}
        className="header-tool"
        type="button"
        title="字号"
        aria-label="字号"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <Type aria-hidden="true" />
      </button>

      {open ? (
        <div className="reading-scale-popover" id={panelId} role="dialog" aria-label="字号">
          <div className="reading-scale-heading">
            <strong>字号</strong>
          </div>
          <div className={`reading-scale-slider is-${value}`}>
            <span className="reading-scale-track" aria-hidden="true">
              {readingScaleOptions.map((option) => (
                <i key={option.value} />
              ))}
            </span>
            <input
              ref={sliderRef}
              type="range"
              min="0"
              max={String(readingScaleOptions.length - 1)}
              step="1"
              value={activeIndex}
              aria-label="阅读字号"
              aria-valuetext={activeOption.label}
              onChange={(event) => onChange(readingScaleFromIndex(Number(event.currentTarget.value)))}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
