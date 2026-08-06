"use client";

import { Home, RefreshCw } from "lucide-react";

export function OfflineActions() {
  return (
    <div className="pwa-offline-actions">
      <button type="button" onClick={() => window.location.reload()}>
        <RefreshCw aria-hidden="true" />
        重新连接
      </button>
      <button
        className="is-secondary"
        type="button"
        onClick={() =>
          window.location.assign(new URL("/", window.location.href).href)
        }
      >
        <Home aria-hidden="true" />
        词典首页
      </button>
    </div>
  );
}
