"use client";

import { BookOpenText, ChevronRight, Image as ImageIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import type { CanonicalIllustration } from "../../../../packages/dictionary-schema/src/index";
import type { EtymologyTextRun } from "../../../../packages/enhancement-schema/src/index";
import { adaptiveLineCount } from "../adaptive-line-clamp";
import {
  entryResourceLabel,
  entryResourceSize,
  etymologyArticleLabel,
  type EntryResource,
} from "../resource-model";
import { grammarUsageBoxLabels } from "../box-presentation";

type IllustrationResolver = (key: string, variant?: "full" | "thumbnail") => string;
type EtymologyResource = Extract<EntryResource, { kind: "etymology" }>;

export function IllustrationImage({
  illustration,
  resolveIllustration,
  className,
  variant = "full",
}: {
  illustration: CanonicalIllustration;
  resolveIllustration: IllustrationResolver;
  className: string;
  variant?: "full" | "thumbnail";
}) {
  const source = illustration.key ? resolveIllustration(illustration.key, variant) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!source || failedSource === source) {
    return <ImageIcon className={className} aria-hidden="true" />;
  }
  return (
    <Image
      alt={illustration.text ?? "词条配图"}
      className={className}
      height={480}
      onError={() => setFailedSource(source)}
      referrerPolicy="no-referrer"
      src={source}
      unoptimized
      width={640}
    />
  );
}

export function ResourceRail({
  resources,
  onOpen,
  resolveIllustration,
}: {
  resources: readonly EntryResource[];
  onOpen: (resource: EntryResource, articleId?: string) => void;
  resolveIllustration: IllustrationResolver;
}) {
  if (!resources.length) {
    return null;
  }

  return (
    <aside className="entry-resource-rail" aria-label="词条扩展内容">
      {resources.map((resource) => {
        const size = entryResourceSize(resource);
        const className = `resource-card${size === "feature" ? " is-featured" : ""} is-${resource.kind}`;
        if (resource.kind === "illustration") {
          return (
            <button className={className} key={resource.key} type="button" onClick={() => onOpen(resource)}>
              <IllustrationImage
                className="resource-card-thumbnail"
                illustration={resource.illustration}
                resolveIllustration={resolveIllustration}
                variant="thumbnail"
              />
              <strong>{entryResourceLabel(resource)}</strong>
              <span>VISUAL VOCABULARY</span>
            </button>
          );
        }
        if (resource.kind === "box") {
          const labels = grammarUsageBoxLabels(resource.box);
          return (
            <button className={className} key={resource.key} type="button" onClick={() => onOpen(resource)}>
              <BookOpenText className="resource-card-icon" aria-hidden="true" />
              <strong>{entryResourceLabel(resource)}</strong>
              <span>{labels?.secondary ?? resource.box.type ?? ""}</span>
            </button>
          );
        }
        return <EtymologyResourceCard key={resource.key} resource={resource} onOpen={(articleId) => onOpen(resource, articleId)} />;
      })}
    </aside>
  );
}

export function EtymologyResourceCard({
  resource,
  onOpen,
}: {
  resource: EtymologyResource;
  onOpen: (articleId: string) => void;
}) {
  const firstArticle = resource.summary.articles[0];
  if (!firstArticle) {
    return null;
  }

  return (
    <article className="resource-card is-featured is-etymology etymology-resource-card">
      <button
        aria-label={`打开 ${resource.summary.headword} 的词源`}
        className="etymology-card-hit-area"
        type="button"
        onClick={() => onOpen(firstArticle.id)}
      />
      <div className="etymology-card-spine" aria-hidden="true">
        <Image
          alt=""
          className="etymology-card-emblem"
          height={128}
          src="/etymology-griffin.png"
          unoptimized
          width={128}
        />
        <span className="etymology-card-spine-label">ETYMON</span>
      </div>
      <div className="etymology-card-paper">
        <header className="etymology-card-heading">
          <strong>词源</strong>
        </header>
        <div className="etymology-card-content">
          <h3>
            <span>{resource.summary.headword}</span>{" "}
            <small>({etymologyArticleLabel(firstArticle, 0)})</small>
          </h3>
          {resource.summary.articles.length > 1 ? (
            <div className="etymology-card-articles" role="group" aria-label="词源篇章">
              {resource.summary.articles.map((article, index) => (
                <button
                  key={article.id}
                  type="button"
                  title={article.preview}
                  onClick={() => onOpen(article.id)}
                >
                  {etymologyArticleLabel(article, index)}
                </button>
              ))}
            </div>
          ) : null}
          <EtymologyPreview runs={firstArticle.previewRuns} />
        </div>
        <div className="etymology-card-expand" aria-hidden="true">
          <span>{`展开 ${resource.summary.articles.length} 篇词源`}</span>
          <ChevronRight />
        </div>
      </div>
    </article>
  );
}

function EtymologyPreview({ runs }: { runs: readonly EtymologyTextRun[] }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const paragraphRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    const paragraph = paragraphRef.current;
    if (!frame || !paragraph) {
      return;
    }
    const updateLineCount = () => {
      const frameStyle = window.getComputedStyle(frame);
      const paragraphStyle = window.getComputedStyle(paragraph);
      const lines = adaptiveLineCount({
        availableBlockSize: frame.clientHeight,
        blockEndInset: Number.parseFloat(frameStyle.paddingBottom) || 0,
        blockStartInset: Number.parseFloat(frameStyle.paddingTop) || 0,
        lineHeight: Number.parseFloat(paragraphStyle.lineHeight),
      });
      frame.dataset.previewLines = String(lines);
      frame.style.setProperty("--etymology-preview-lines", String(lines));
    };
    updateLineCount();
    const observer = new ResizeObserver(updateLineCount);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [runs]);

  return (
    <div className="etymology-card-preview" ref={frameRef}>
      <p ref={paragraphRef}>
        {runs.map((run, index) => {
          const className = [
            "etymology-preview-run",
            run.marks.includes("foreign") ? "is-foreign" : "",
            run.marks.includes("strong") ? "is-strong" : "",
            run.link ? "is-link" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <span className={className} key={`${index}:${run.text}`}>
              {run.text}
            </span>
          );
        })}
      </p>
    </div>
  );
}
