"use client";

import { ArrowUp, BookOpenText, ChevronLeft, Image as ImageIcon, ListFilter } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  CanonicalGrammarUsageBox,
  CanonicalIllustration,
} from "../../../../packages/dictionary-schema/src/index";
import type { EntryPartProjection } from "../entry-sections";
import { projectQuickFind } from "../quick-find-model";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";

type MobileQuickFindProps = {
  projection: EntryPartProjection;
  activeSectionId?: string;
  onPartChange: (index: number) => void;
  onJump: (anchor: string) => void;
  onOpenBox: (box: CanonicalGrammarUsageBox) => void;
  onOpenIllustration: (illustration: CanonicalIllustration) => void;
};

export function MobileQuickFind({
  projection,
  activeSectionId,
  onPartChange,
  onJump,
  onOpenBox,
  onOpenIllustration,
}: MobileQuickFindProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);
  const pendingJumpRef = useRef<string | undefined>(undefined);
  const model = projectQuickFind(projection);
  useViewportScrollLock(open);

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
      <nav className="mobile-quick-find-dock" aria-label="词条快捷操作">
        {model.parts.length ? (
          <div className="mobile-quick-find-part-tabs" role="tablist" aria-label="词性">
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
                          if (resource.kind === "illustration") {
                            onOpenIllustration(resource.illustration);
                          } else {
                            onOpenBox(resource.box);
                          }
                        }}
                        type="button"
                      >
                        {resource.kind === "illustration" ? <ImageIcon aria-hidden="true" /> : <BookOpenText aria-hidden="true" />}
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
