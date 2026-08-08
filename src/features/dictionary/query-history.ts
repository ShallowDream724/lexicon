import { type MouseEvent, type PointerEvent, useEffect, useMemo } from "react";

import type { QueryHistoryRecord } from "../../lib/storage/learning-data";

export const QUERY_HISTORY_PREVIEW_LIMIT = 5;
export const LONG_PRESS_DELAY_MS = 550;
export const LONG_PRESS_MOVE_THRESHOLD_PX = 12;

type LongPressPointer = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

type TimerScheduler = {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

type LongPressControllerOptions = {
  onLongPress: () => void;
  delay?: number;
  moveThreshold?: number;
  scheduler?: TimerScheduler;
};

export type LongPressController = {
  start: (pointer: LongPressPointer) => void;
  move: (pointer: LongPressPointer) => void;
  end: (pointerId: number) => void;
  cancel: () => void;
  consumeClick: () => boolean;
};

const browserScheduler: TimerScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createLongPressController({
  onLongPress,
  delay = LONG_PRESS_DELAY_MS,
  moveThreshold = LONG_PRESS_MOVE_THRESHOLD_PX,
  scheduler = browserScheduler,
}: LongPressControllerOptions): LongPressController {
  let active: LongPressPointer | undefined;
  let timer: unknown;
  let suppressClick = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
  };

  const cancel = () => {
    clearTimer();
    active = undefined;
  };

  return {
    start(pointer) {
      cancel();
      active = pointer;
      timer = scheduler.setTimeout(() => {
        if (!active || active.pointerId !== pointer.pointerId) {
          return;
        }
        timer = undefined;
        active = undefined;
        suppressClick = true;
        onLongPress();
      }, delay);
    },
    move(pointer) {
      if (!active || active.pointerId !== pointer.pointerId) {
        return;
      }
      if (Math.hypot(pointer.clientX - active.clientX, pointer.clientY - active.clientY) > moveThreshold) {
        cancel();
      }
    },
    end(pointerId) {
      if (active?.pointerId === pointerId) {
        cancel();
      }
    },
    cancel,
    consumeClick() {
      const shouldSuppress = suppressClick;
      suppressClick = false;
      return shouldSuppress;
    },
  };
}

export function queryHistoryPreviewRecords(
  records: readonly QueryHistoryRecord[],
  limit = QUERY_HISTORY_PREVIEW_LIMIT,
): QueryHistoryRecord[] {
  return records.slice(0, Math.max(0, limit));
}

export function queryHistoryDisplayText(record: QueryHistoryRecord): string {
  return record.query;
}

export function supportsTouchLongPress(pointerType: string): boolean {
  return pointerType === "touch";
}

export function useLongPress(onLongPress: () => void) {
  const controller = useMemo(
    () => createLongPressController({ onLongPress }),
    [onLongPress],
  );

  useEffect(() => {
    const cancelForScroll = () => controller.cancel();
    window.addEventListener("scroll", cancelForScroll, true);
    return () => {
      window.removeEventListener("scroll", cancelForScroll, true);
      controller.cancel();
    };
  }, [controller]);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!supportsTouchLongPress(event.pointerType)) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      controller.start({
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      controller.move({
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      controller.end(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      controller.cancel();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onLostPointerCapture() {
      controller.cancel();
    },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (controller.consumeClick()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
