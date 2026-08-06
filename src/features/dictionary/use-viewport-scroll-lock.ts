"use client";

import { useEffect } from "react";

let activeLocks = 0;
let restoreViewport: (() => void) | undefined;

function acquireViewportLock(): () => void {
  if (activeLocks === 0) {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
    const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;
    }

    restoreViewport = () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }

  activeLocks += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeLocks = Math.max(0, activeLocks - 1);
    if (activeLocks === 0) {
      restoreViewport?.();
      restoreViewport = undefined;
    }
  };
}

export function useViewportScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) {
      return;
    }
    return acquireViewportLock();
  }, [locked]);
}
