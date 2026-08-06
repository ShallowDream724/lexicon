"use client";

import { RefreshCw, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  PWA_OFFLINE_URL,
  PWA_SERVICE_WORKER_URL,
} from "./cache-policy";
import { decideWaitingWorkerAction } from "./update-policy";

type IdleWindow = Window &
  typeof globalThis & {
    cancelIdleCallback?: (handle: number) => void;
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };

export function PwaRuntime() {
  const [online, setOnline] = useState(true);
  const [updateReady, setUpdateReady] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const activationRequestedRef = useRef(false);
  const reloadedRef = useRef(false);

  useEffect(() => {
    const updateOnlineState = () => {
      setOnline(
        window.location.pathname === PWA_OFFLINE_URL || navigator.onLine,
      );
    };
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    let observedInstaller: ServiceWorker | null = null;

    const activate = (worker: ServiceWorker) => {
      activationRequestedRef.current = true;
      setApplyingUpdate(true);
      worker.postMessage({ type: "SKIP_WAITING" });
    };

    const onControllerChange = () => {
      if (
        !activationRequestedRef.current ||
        reloadedRef.current ||
        cancelled
      ) {
        return;
      }
      reloadedRef.current = true;
      window.location.reload();
    };

    const inspectWaitingWorker = (
      discovery: "runtime" | "startup",
      worker: ServiceWorker | null,
    ) => {
      if (!worker || cancelled) {
        return;
      }
      const action = decideWaitingWorkerAction(
        discovery,
        Boolean(navigator.serviceWorker.controller),
      );
      if (action === "activate") {
        activate(worker);
      } else if (action === "prompt") {
        waitingWorkerRef.current = worker;
        setUpdateReady(true);
      }
    };

    const onInstallerStateChange = () => {
      if (observedInstaller?.state === "installed") {
        inspectWaitingWorker("runtime", registration?.waiting ?? null);
      }
    };

    const onUpdateFound = () => {
      observedInstaller?.removeEventListener(
        "statechange",
        onInstallerStateChange,
      );
      observedInstaller = registration?.installing ?? null;
      observedInstaller?.addEventListener(
        "statechange",
        onInstallerStateChange,
      );
    };

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register(
          PWA_SERVICE_WORKER_URL,
          {
            scope: "/",
            type: "module",
            updateViaCache: "none",
          },
        );
        if (cancelled) {
          return;
        }
        inspectWaitingWorker("startup", registration.waiting);
        registration.addEventListener("updatefound", onUpdateFound);
        if (registration.installing) {
          onUpdateFound();
        }
      } catch {
        return;
      }
    };

    const scheduleRegistration = () => {
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(() => void register(), {
          timeout: 2_000,
        });
      } else {
        idleHandle = window.setTimeout(() => void register(), 1);
      }
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );
    if (document.readyState === "complete") {
      scheduleRegistration();
    } else {
      window.addEventListener("load", scheduleRegistration, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("load", scheduleRegistration);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      registration?.removeEventListener("updatefound", onUpdateFound);
      observedInstaller?.removeEventListener(
        "statechange",
        onInstallerStateChange,
      );
      if (idleHandle !== undefined) {
        const idleWindow = window as IdleWindow;
        if (idleWindow.cancelIdleCallback) {
          idleWindow.cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waitingWorker = waitingWorkerRef.current;
    if (!waitingWorker) {
      return;
    }
    activationRequestedRef.current = true;
    setApplyingUpdate(true);
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  }, []);

  const dismissUpdate = useCallback(() => {
    setUpdateReady(false);
  }, []);

  if (online && !updateReady) {
    return null;
  }

  return (
    <div className="pwa-status-stack" aria-live="polite">
      {!online ? (
        <div className="pwa-status-notice" role="status">
          <WifiOff aria-hidden="true" />
          <span>当前离线，查询和媒体需要网络连接</span>
        </div>
      ) : null}
      {updateReady ? (
        <div className="pwa-status-notice is-update" role="status">
          <RefreshCw aria-hidden="true" />
          <span>{applyingUpdate ? "正在更新" : "新版本已就绪"}</span>
          <button
            className="pwa-update-action"
            type="button"
            onClick={applyUpdate}
            disabled={applyingUpdate}
          >
            更新
          </button>
          <button
            className="pwa-dismiss-action"
            type="button"
            aria-label="稍后更新"
            title="稍后更新"
            onClick={dismissUpdate}
            disabled={applyingUpdate}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
