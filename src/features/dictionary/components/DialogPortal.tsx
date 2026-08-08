"use client";

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { ReadingScale } from "../reading-scale";

const subscribe = () => () => {};
const DialogPortalContext = createContext<ReadingScale>("default");

export function DialogPortalProvider({
  children,
  fontScale,
}: {
  children: ReactNode;
  fontScale: ReadingScale;
}) {
  return <DialogPortalContext.Provider value={fontScale}>{children}</DialogPortalContext.Provider>;
}

export function DialogPortal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const fontScale = useContext(DialogPortalContext);

  return mounted
    ? createPortal(
        <div className="dictionary-portal-root" data-font-scale={fontScale}>
          {children}
        </div>,
        document.body,
      )
    : null;
}
