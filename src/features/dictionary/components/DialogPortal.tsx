"use client";

import { type ReactNode, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

export function DialogPortal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);

  return mounted ? createPortal(children, document.body) : null;
}
