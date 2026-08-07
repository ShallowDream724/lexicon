"use client";

import {
  ArrowUp,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  ListFilter,
  ScrollText,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { EntryPartProjection } from "../entry-sections";
import {
  fitHorizontalTabsToWidth,
  horizontalTabAvailableWidth,
  horizontalScrollState,
  scrollLeftToAlignItemStart,
  type HorizontalScrollState,
  type HorizontalTabLayout,
} from "../horizontal-scroll-state";
import { projectQuickFind } from "../quick-find-model";
import { entryResourceQuickFindAction, type EntryResource } from "../resource-model";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";

type MobileQuickFindProps = {
  scopeKey: string;
  projection: EntryPartProjection;
  activeSectionId?: string;
  onPartChange: (index: number) => void;
  onJump: (anchor: string) => void;
  resources: readonly EntryResource[];
  onOpenResource: (resource: EntryResource) => void;
};

export function MobileQuickFind({
  scopeKey,
  projection,
  activeSectionId,
  onPartChange,
  onJump,
  resources,
  onOpenResource,
}: MobileQuickFindProps) {
  const [open, setOpen] = useState(false);
  const [partScroll, setPartScroll] = useState<HorizontalScrollState>({
    overflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const [partLayout, setPartLayout] = useState<HorizontalTabLayout | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const partFrameRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const partTabsRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const pendingJumpRef = useRef<string | undefined>(undefined);
  const model = projectQuickFind(projection, resources);
  const partSignature = model.parts.map((part) => part.label).join("\u0000");
  useViewportScrollLock(open);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const frame = partFrameRef.current;
    const scroller = partTabsRef.current;
    const trigger = triggerRef.current;
    const firstPart = scroller?.querySelector<HTMLButtonElement>("[role=tab]");
    if (!dock || !frame || !scroller || !trigger || !firstPart) {
      setPartLayout(null);
      return;
    }

    let animationFrame = 0;
    const measure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const dockStyle = window.getComputedStyle(dock);
        const frameStyle = window.getComputedStyle(frame);
        const rootFontSize = Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        );
        const pixels = (value: string) => {
          const normalized = value.trim();
          const parsed = Number.parseFloat(normalized);
          if (!Number.isFinite(parsed)) {
            return 0;
          }
          if (normalized.endsWith("rem")) {
            return parsed * (Number.isFinite(rootFontSize) ? rootFontSize : 0);
          }
          return parsed;
        };
        const availableWidth = horizontalTabAvailableWidth({
          dockWidth: dock.getBoundingClientRect().width,
          visualViewportWidth: window.visualViewport?.width,
          paddingStart: pixels(dockStyle.paddingLeft),
          paddingEnd: pixels(dockStyle.paddingRight),
          trailingControlWidth: trigger.getBoundingClientRect().width,
          gap: pixels(dockStyle.columnGap),
        });
        const staticInset = pixels(
          frameStyle.getPropertyValue("--mobile-part-static-inset"),
        );
        const overflowInset = pixels(
          frameStyle.getPropertyValue("--mobile-part-edge-inset"),
        );
        const cueWidth = pixels(
          frameStyle.getPropertyValue("--mobile-part-cue-width"),
        );
        const itemWidth = firstPart.getBoundingClientRect().width;
        if (availableWidth <= 0 || !Number.isFinite(itemWidth) || itemWidth <= 0) {
          return;
        }
        const nextLayout = fitHorizontalTabsToWidth({
          availableWidth,
          itemCount: model.parts.length,
          itemWidth,
          staticChromeWidth: staticInset * 2,
          overflowChromeWidth: (overflowInset + cueWidth) * 2,
        });
        setPartLayout((current) =>
          current &&
          current.overflowing === nextLayout.overflowing &&
          current.visibleCount === nextLayout.visibleCount &&
          Math.abs(current.frameWidth - nextLayout.frameWidth) < 1
            ? current
            : nextLayout,
        );
      });
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(dock);
    resizeObserver.observe(trigger);
    resizeObserver.observe(firstPart);
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    visualViewport?.addEventListener("resize", measure);
    visualViewport?.addEventListener("scroll", measure);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      visualViewport?.removeEventListener("resize", measure);
      visualViewport?.removeEventListener("scroll", measure);
    };
  }, [partSignature, model.parts.length]);

  const close = () => setOpen(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      dialogRef.current?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }

    const pendingJump = pendingJumpRef.current;
    if (!pendingJump) {
      return;
    }
    pendingJumpRef.current = undefined;
    const frame = window.requestAnimationFrame(() => onJump(pendingJump));
    return () => window.cancelAnimationFrame(frame);
  }, [onJump, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    const element = partTabsRef.current;
    if (!element) {
      setPartScroll({ overflowing: false, canScrollLeft: false, canScrollRight: false });
      return;
    }

    let animationFrame = 0;
    const measure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const nextState = horizontalScrollState(element);
        setPartScroll((current) =>
          current.overflowing === nextState.overflowing &&
          current.canScrollLeft === nextState.canScrollLeft &&
          current.canScrollRight === nextState.canScrollRight
            ? current
            : nextState,
        );
      });
    };

    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    window.addEventListener("resize", measure);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      element.removeEventListener("scroll", measure);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [partLayout?.frameWidth, partSignature, scopeKey]);

  useLayoutEffect(() => {
    if (partTabsRef.current) {
      partTabsRef.current.scrollLeft = 0;
    }
  }, [partSignature, scopeKey]);

  useLayoutEffect(() => {
    if (partLayout && !partLayout.overflowing && partTabsRef.current) {
      partTabsRef.current.scrollLeft = 0;
    }
  }, [partLayout]);

  useEffect(() => {
    const element = partTabsRef.current;
    if (!element) {
      return;
    }
    if (!partLayout?.overflowing) {
      element.scrollLeft = 0;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const activePart = element.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!activePart) {
        return;
      }
      const elementBounds = element.getBoundingClientRect();
      const itemBounds = activePart.getBoundingClientRect();
      const leadingInset = Number.parseFloat(
        window.getComputedStyle(element).paddingInlineStart,
      ) || 0;
      const target = scrollLeftToAlignItemStart({
        scrollLeft: element.scrollLeft,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        itemLeft: itemBounds.left - elementBounds.left + element.scrollLeft,
        itemWidth: itemBounds.width,
        leadingInset,
      });
      if (Math.abs(target - element.scrollLeft) > 1) {
        element.scrollTo({ left: target, behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [partLayout?.frameWidth, partLayout?.overflowing, projection.activeIndex, scopeKey]);

  const scrollParts = (direction: -1 | 1) => {
    const element = partTabsRef.current;
    if (!element) {
      return;
    }
    element.scrollBy({
      left: direction * (partLayout?.pageWidth ?? element.clientWidth),
      behavior: "smooth",
    });
  };

  const choosePart = (index: number) => {
    close();
    onPartChange(index);
  };

  const jump = (anchor: string) => {
    pendingJumpRef.current = anchor;
    close();
  };

  return (
    <>
      <nav className="mobile-quick-find-dock" aria-label="词条快捷操作" ref={dockRef}>
        {model.parts.length ? (
          <div
            className={`mobile-quick-find-part-tabs-frame${partLayout?.overflowing ? " is-overflowing" : ""}`}
            ref={partFrameRef}
            style={partLayout ? {
              flexBasis: partLayout.frameWidth,
              width: partLayout.frameWidth,
            } : undefined}
          >
            {partLayout?.overflowing ? (
              <button
                aria-label="向左查看更多词性"
                className="mobile-quick-find-scroll-cue is-left"
                disabled={!partScroll.canScrollLeft}
                onClick={() => scrollParts(-1)}
                title="向左查看更多词性"
                type="button"
              >
                <ChevronLeft aria-hidden="true" />
              </button>
            ) : null}
            <div
              className="mobile-quick-find-part-tabs"
              ref={partTabsRef}
              role="tablist"
              aria-label="词性"
            >
              {model.parts.map((part) => (
                <button
                  aria-selected={part.active}
                  className={part.active ? "is-active" : ""}
                  key={part.index}
                  onClick={() => onPartChange(part.index)}
                  role="tab"
                  type="button"
                >
                  {part.label}
                </button>
              ))}
            </div>
            {partLayout?.overflowing ? (
              <button
                aria-label="向右查看更多词性"
                className="mobile-quick-find-scroll-cue is-right"
                disabled={!partScroll.canScrollRight}
                onClick={() => scrollParts(1)}
                title="向右查看更多词性"
                type="button"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="快捷查找"
          className="mobile-quick-find-trigger"
          onClick={() => setOpen(true)}
          ref={triggerRef}
          title="快捷查找"
          type="button"
        >
          <ListFilter aria-hidden="true" />
          <span>快捷查找</span>
        </button>
      </nav>

      {open ? (
        <div className="mobile-quick-find-backdrop" onPointerDown={close} role="presentation">
          <section
            aria-label="快捷查找"
            aria-modal="true"
            className="mobile-quick-find-dialog"
            onPointerDown={(event) => event.stopPropagation()}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="mobile-quick-find-header">
              <button aria-label="返回" onClick={close} title="返回" type="button">
                <ChevronLeft aria-hidden="true" />
                <span>返回</span>
              </button>
              <strong>快捷查找</strong>
              <button
                aria-label="回顶部"
                onClick={() => jump("dictionary-top")}
                title="回顶部"
                type="button"
              >
                <ArrowUp aria-hidden="true" />
                <span>回顶部</span>
              </button>
            </header>

            <div className="mobile-quick-find-content">
              {model.parts.length ? (
                <section className="mobile-quick-find-section">
                  <h2>词性</h2>
                  <div className="mobile-quick-find-part-list" role="tablist" aria-label="词性选择">
                    {model.parts.map((part) => (
                      <button
                        aria-selected={part.active}
                        className={part.active ? "is-active" : ""}
                        key={part.index}
                        onClick={() => choosePart(part.index)}
                        role="tab"
                        type="button"
                      >
                        {part.label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {model.resources.length ? (
                <section className="mobile-quick-find-section">
                  <h2>扩展内容</h2>
                  <div className="mobile-quick-find-resource-list">
                    {model.resources.map((resource, index) => (
                      <button
                        key={`${resource.kind}-${index}`}
                        onClick={() => {
                          close();
                          if (entryResourceQuickFindAction(resource) === "open-resource") {
                            onOpenResource(resource);
                          }
                        }}
                        type="button"
                      >
                        {resource.kind === "illustration" ? <ImageIcon aria-hidden="true" /> : resource.kind === "box" ? <BookOpenText aria-hidden="true" /> : <ScrollText aria-hidden="true" />}
                        <span>{resource.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {model.senseGroups.length ? (
                <section className="mobile-quick-find-section">
                  <h2>义项</h2>
                  <div className="mobile-quick-find-anchor-list is-senses">
                    {model.senseGroups.map((group) => (
                      <button
                        aria-current={activeSectionId === group.anchor ? "location" : undefined}
                        className={activeSectionId === group.anchor ? "is-current" : ""}
                        key={group.anchor}
                        onClick={() => jump(group.anchor)}
                        type="button"
                      >
                        {group.label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {model.idioms.length || model.phrasalVerbs.length ? (
                <section className="mobile-quick-find-section">
                  <h2>习语&amp;短语动词</h2>
                  <div className="mobile-quick-find-anchor-list is-phrases">
                    {model.idioms.map((item) => (
                      <button
                        aria-current={activeSectionId === item.anchor ? "location" : undefined}
                        className={activeSectionId === item.anchor ? "is-current" : ""}
                        key={item.anchor}
                        onClick={() => jump(item.anchor)}
                        type="button"
                      >
                        {item.label}
                      </button>
                    ))}
                    {model.phrasalVerbs.map((item) => (
                      <button
                        aria-current={activeSectionId === item.anchor ? "location" : undefined}
                        className={activeSectionId === item.anchor ? "is-current" : ""}
                        key={item.anchor}
                        onClick={() => jump(item.anchor)}
                        type="button"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
