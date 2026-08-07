"use client";

import { LoaderCircle, RotateCcw, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import type {
  EtymologyArticle,
  EtymologyArticleResponse,
  EtymologyResourceSummary,
  EtymologyTextRun,
} from "../../../../packages/enhancement-schema/src/index";
import { dictionaryClient } from "../../../lib/dictionary-client/client";
import { isArticleResponseForResource } from "../etymology-response";
import { etymologyArticleLabel } from "../resource-model";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { DialogPortal } from "./DialogPortal";

type EtymologyDialogProps = {
  resource: EtymologyResourceSummary | null;
  articleId?: string;
  initialArticle?: EtymologyArticleResponse;
  onClose: () => void;
  onArticleChange: (articleId: string) => void;
  onNavigate: (term: string, targetArticleId?: string) => void;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function EtymologyRun({
  run,
  onNavigate,
}: {
  run: EtymologyTextRun;
  onNavigate: EtymologyDialogProps["onNavigate"];
}) {
  let content: ReactNode = run.text;
  for (const mark of run.marks) {
    content = mark === "strong" ? <strong>{content}</strong> : <em>{content}</em>;
  }
  return run.link ? (
    <button
      className="etymology-inline-link"
      type="button"
      onClick={() => onNavigate(run.link!.targetTerm, run.link!.targetArticleId)}
    >
      {content}
    </button>
  ) : content;
}

function EtymologyArticleContent({
  article,
  onNavigate,
}: {
  article: EtymologyArticle;
  onNavigate: EtymologyDialogProps["onNavigate"];
}) {
  return (
    <div className="etymology-article-copy">
      {article.document.blocks.map((block, blockIndex) => {
        const content = block.runs.map((run, runIndex) => (
          <EtymologyRun key={`${blockIndex}-${runIndex}`} run={run} onNavigate={onNavigate} />
        ));
        return block.kind === "quote" ? <blockquote key={blockIndex}>{content}</blockquote> : <p key={blockIndex}>{content}</p>;
      })}
    </div>
  );
}

export function EtymologyDialog({
  resource,
  articleId,
  initialArticle,
  onClose,
  onArticleChange,
  onNavigate,
}: EtymologyDialogProps) {
  const scope = resource ? `${resource.resourceId}:${resource.sourceVersion}` : null;
  const selectedArticleId = resource
    ? resource.articles.some((article) => article.id === articleId)
      ? articleId!
      : resource.articles[0]!.id
    : null;
  const articleKey = scope && selectedArticleId ? `${scope}:${selectedArticleId}` : null;
  const [articles, setArticles] = useState<Record<string, EtymologyArticle>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retryVersion, setRetryVersion] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const tabPanelId = useId();
  useViewportScrollLock(Boolean(resource));

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const hasInitialArticle = isArticleResponseForResource(initialArticle, resource, selectedArticleId);
    if (!resource || !selectedArticleId || !articleKey || articles[articleKey] || hasInitialArticle) {
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void dictionaryClient
      .etymologyArticle(selectedArticleId, controller.signal)
      .then((response) => {
        if (
          requestRef.current !== controller ||
          controller.signal.aborted ||
          !isArticleResponseForResource(response, resource, selectedArticleId)
        ) {
          return;
        }
        setArticles((current) => ({ ...current, [articleKey]: response.article }));
      })
      .catch((requestError) => {
        if (!isAbortError(requestError) && requestRef.current === controller) {
          setErrors((current) => ({ ...current, [articleKey]: "词源内容暂不可用" }));
        }
      })
      .finally(() => {
        if (requestRef.current === controller) {
          requestRef.current = null;
        }
      });
    return () => controller.abort();
  }, [articleKey, articles, initialArticle, resource, retryVersion, selectedArticleId]);

  useEffect(() => {
    if (!resource) {
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      returnFocusRef.current?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    };
  }, [resource]);

  const keepFocusInside = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (!focusable?.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!resource || !selectedArticleId) {
    return null;
  }

  const selected = (articleKey ? articles[articleKey] : undefined) ?? (
    isArticleResponseForResource(initialArticle, resource, selectedArticleId)
      ? initialArticle.article
      : undefined
  );
  const error = articleKey ? errors[articleKey] : undefined;
  const pending = !selected && !error;
  const chooseArticle = (nextArticleId: string) => {
    onArticleChange(nextArticleId);
  };
  const moveArticleFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % resource.articles.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + resource.articles.length) % resource.articles.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = resource.articles.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextArticle = resource.articles[nextIndex]!;
    chooseArticle(nextArticle.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
      ?.focus();
  };

  return (
    <DialogPortal>
      <div className="resource-dialog-layer etymology-dialog-layer" role="presentation" onMouseDown={onClose}>
        <section
          className="resource-dialog etymology-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="词源"
          onKeyDown={keepFocusInside}
          onMouseDown={(event) => event.stopPropagation()}
          ref={dialogRef}
          tabIndex={-1}
        >
          <header>
            <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
            <strong>词源</strong>
            <span aria-hidden="true" />
          </header>
          <div className="etymology-dialog-body">
            <div className="etymology-gilt-edge" aria-hidden="true" />
            <div className="etymology-paper">
              <div className="etymology-watermark" aria-hidden="true" />
              <h1>{resource.headword}</h1>
              <div className="etymology-article-tabs" role="tablist" aria-label="词源篇章">
                {resource.articles.map((article, index) => (
                  <button
                    aria-selected={article.id === selectedArticleId}
                    aria-controls={tabPanelId}
                    className={article.id === selectedArticleId ? "is-active" : ""}
                    id={`${tabPanelId}-tab-${index}`}
                    key={article.id}
                    onClick={() => chooseArticle(article.id)}
                    onKeyDown={(event) => moveArticleFocus(event, index)}
                    role="tab"
                    tabIndex={article.id === selectedArticleId ? 0 : -1}
                    type="button"
                  >
                    {etymologyArticleLabel(article, index)}
                  </button>
                ))}
              </div>
              {pending ? (
                <p className="etymology-status" role="status"><LoaderCircle aria-hidden="true" />正在加载</p>
              ) : null}
              {error ? (
                <div className="etymology-status is-error" role="alert">
                  <p>{error}</p>
                  <button type="button" onClick={() => {
                    setErrors((current) => {
                      const next = { ...current };
                      if (articleKey) {
                        delete next[articleKey];
                      }
                      return next;
                    });
                    setRetryVersion((version) => version + 1);
                  }}>
                    <RotateCcw aria-hidden="true" />重试
                  </button>
                </div>
              ) : null}
              {selected ? (
                <div
                  aria-labelledby={`${tabPanelId}-tab-${resource.articles.findIndex((article) => article.id === selectedArticleId)}`}
                  id={tabPanelId}
                  role="tabpanel"
                >
                  <EtymologyArticleContent article={selected} onNavigate={onNavigate} />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </DialogPortal>
  );
}
