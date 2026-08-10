"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  EtymologyArticleResponse,
  EtymologyResourceSummary,
} from "../../../../packages/enhancement-schema/src/index";
import { dictionaryClient } from "../../../lib/dictionary-client/client";
import { EtymologyDialog } from "./EtymologyDialog";
import { EtymologyResourceCard } from "./ResourceRail";
import type { EntryResource } from "../resource-model";

type EtymologyOnlyViewProps = {
  term: string;
  articleId?: string;
  autoOpen?: boolean;
  prefetchedArticle?: EtymologyArticleResponse;
  onArticleChange: (articleId?: string) => void;
  onNavigate: (term: string, articleId?: string) => void;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function EtymologyOnlyView({
  term,
  articleId,
  autoOpen = false,
  prefetchedArticle,
  onArticleChange,
  onNavigate,
}: EtymologyOnlyViewProps) {
  const [result, setResult] = useState<{
    term: string;
    resource?: EtymologyResourceSummary;
    error?: string;
  } | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const autoOpenedTermRef = useRef<string | null>(null);
  const resource = result?.term === term ? result.resource ?? null : null;
  const error = result?.term === term ? result.error ?? null : null;

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void dictionaryClient
      .etymologyTerm(term, controller.signal)
      .then((next) => {
        if (requestRef.current === controller && !controller.signal.aborted) {
          setResult({ term, resource: next });
        }
      })
      .catch((requestError) => {
        if (!isAbortError(requestError) && requestRef.current === controller) {
          setResult({ term, error: "词源内容暂不可用" });
        }
      });
    return () => controller.abort();
  }, [requestVersion, term]);

  useEffect(() => {
    if (!autoOpen || articleId || !resource || autoOpenedTermRef.current === term) {
      return;
    }
    autoOpenedTermRef.current = term;
    onArticleChange(resource.articles[0]?.id);
  }, [articleId, autoOpen, onArticleChange, resource, term]);

  if (!resource && !error) {
    return <div className="entry-loading-shell" role="status" aria-label="正在加载词源"><span /></div>;
  }

  return (
    <section className="etymology-only-view" aria-label="词源" data-inline-lookup-surface>
      {error ? (
        <div className="etymology-only-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)}>重试</button>
        </div>
      ) : resource ? (
        <>
          <header>
            <span>仅词源</span>
            <h1>{resource.headword}</h1>
          </header>
          <EtymologyResourceCard
            resource={{
              kind: "etymology",
              key: `etymology:${resource.resourceId}`,
              summary: resource,
            } satisfies Extract<EntryResource, { kind: "etymology" }>}
            onOpen={onArticleChange}
          />
          <EtymologyDialog
            articleId={articleId}
            initialArticle={prefetchedArticle}
            onArticleChange={onArticleChange}
            onClose={() => onArticleChange(undefined)}
            onNavigate={onNavigate}
            resource={articleId ? resource : null}
          />
        </>
      ) : <p className="etymology-status"><LoaderCircle aria-hidden="true" />正在加载</p>}
    </section>
  );
}
