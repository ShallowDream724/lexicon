"use client";

import {
  ArrowRight,
  Image as ImageIcon,
  KeyRound,
  NotebookPen,
  Star,
  Volume2,
  X,
} from "lucide-react";
import Image from "next/image";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import type {
  CanonicalBoxBlock,
  CanonicalBoxSegment,
  CanonicalCrossReference,
  CanonicalEntry,
  CanonicalExample,
  CanonicalForm,
  CanonicalFormPresentationItem,
  CanonicalGrammarUsageBox,
  CanonicalIllustration,
  CanonicalLabel,
  CanonicalPhrase,
  CanonicalPronunciation,
  CanonicalSense,
} from "../../../../packages/dictionary-schema/src/index";
import type {
  EtymologyArticleResponse,
  EtymologyResourceSummary,
} from "../../../../packages/enhancement-schema/src/index";
import {
  indexCanonicalEntrySearchLocations,
  type CanonicalSearchLocationIndex,
  type SearchDocumentLocation,
} from "../../../../packages/dictionary-search/src/index";
import type { EntryPartProjection } from "../entry-sections";
import { partOfSpeechTabLabel } from "../entry-sections";
import { grammarUsageBoxLabels, projectGrammarUsageBox } from "../box-presentation";
import { crossReferenceMarker } from "../cross-reference-presentation";
import {
  phraseQuickFindAnchor,
  senseQuickFindAnchor,
  type QuickFindSensePath,
} from "../quick-find-model";
import {
  senseDefinitionFlow,
  senseReferencePlacement,
} from "../sense-presentation";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import {
  buildEntryResources,
  entryResourceSearchLocationTarget,
  type EntryResource,
} from "../resource-model";
import {
  revealSearchLocation,
  searchLocationAttributes,
  searchLocationContains,
  searchLocationPathAttributes,
} from "../search-location";
import type { EtymologyRoute } from "../workspace-route";
import { CanonicalTextContent } from "./CanonicalTextContent";
import { DialogPortal } from "./DialogPortal";
import { EtymologyDialog } from "./EtymologyDialog";
import { MobileQuickFind } from "./MobileQuickFind";
import { ResourceRail as EntryResourceRail } from "./ResourceRail";

type EntryViewProps = {
  entry: CanonicalEntry;
  enhancements?: EtymologyResourceSummary[];
  projection: EntryPartProjection;
  favorite: boolean;
  entryPending: boolean;
  activeSectionId: string;
  onPartChange: (index: number) => void;
  onJump: (anchor: string) => void;
  onToggleFavorite: () => void;
  onOpenNote: () => void;
  onSelectEntry: (entryId: string) => void;
  audioError: string | null;
  onPlayAudio: (key: string, kind: "headword" | "example") => void;
  resolveIllustration: (key: string, variant?: "full" | "thumbnail") => string;
  etymology?: EtymologyRoute;
  prefetchedEtymologyArticle?: EtymologyArticleResponse;
  onEtymologyChange?: (etymology: EtymologyRoute | null) => void;
  onNavigateEtymology?: (term: string, articleId?: string) => void;
  searchLocation?: SearchDocumentLocation;
  onSearchLocationSettled?: (location: SearchDocumentLocation) => void;
};

type LocationIndex = CanonicalSearchLocationIndex;

function audioRegionClass(region: string | undefined): string {
  return region?.toLocaleLowerCase().includes("am") ||
    region?.toLocaleLowerCase().includes("us") ||
    region?.toLocaleLowerCase().includes("na")
    ? "voice-american"
    : "voice-british";
}

function EntryLabel({ label, index }: { label: CanonicalLabel; index: number }) {
  if (label.kind === "frequency") {
    return (
      <span
        className="entry-frequency-key"
        key={`${label.text}-${index}`}
        title={`${label.text} 核心词汇`}
        aria-label={`${label.text} 核心词汇`}
      >
        <KeyRound aria-hidden="true" />
      </span>
    );
  }

  if (label.kind === "academic-register") {
    const title = {
      O: "学术词汇：书面语与口语",
      S: "学术词汇：口语",
      W: "学术词汇：书面语",
    }[label.text.toLocaleUpperCase()] ?? "学术词汇";
    return (
      <span
        className="entry-label entry-label-academic-register"
        key={`${label.text}-${index}`}
        title={title}
        aria-label={title}
      >
        {label.text}
      </span>
    );
  }

  return (
    <span
      className={`entry-label entry-label-${label.kind ?? "general"}`}
      key={`${label.text}-${index}`}
    >
      {label.text}
    </span>
  );
}

function SenseLabels({ labels }: { labels: CanonicalLabel[] }) {
  const content: ReactNode[] = [];

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    if (label.kind === "gram") {
      const grammar = [label];
      while (labels[index + 1]?.kind === "gram") {
        grammar.push(labels[index + 1]!);
        index += 1;
      }
      content.push(
        <span className="sense-label-grammar" key={`gram-${index}`}>
          [{labelListText(grammar)}]
        </span>,
      );
      continue;
    }

    if (label.kind === "frequency") {
      content.push(
        <span
          className="sense-label-frequency"
          key={`${label.kind}-${label.text}-${index}`}
          title="核心词汇"
          aria-label={`${label.text} 核心词汇`}
        >
          <KeyRound aria-hidden="true" />
        </span>,
      );
      continue;
    }

    if (label.kind === "level") {
      content.push(
        <span
          className="sense-label-level"
          key={`${label.kind}-${label.text}-${index}`}
        >
          {label.text}
        </span>,
      );
      continue;
    }

    const text = label.kind === "geo" ? `(${label.text})` : label.text;
    content.push(
      <span
        className={`sense-label-${label.kind ?? "general"}`}
        key={`${label.kind ?? "general"}-${label.text}-${index}`}
      >
        {text}
      </span>,
    );
  }

  return <span className="sense-labels">{content}</span>;
}

function labelListText(
  labels: CanonicalLabel[],
  defaultSeparator: ", " | " " = ", ",
): string {
  return labels.map((label, index) => {
    return `${labelSeparatorBefore(labels, index, defaultSeparator)}${label.text.trim()}`;
  }).join("");
}

function labelSeparatorBefore(
  labels: CanonicalLabel[],
  index: number,
  defaultSeparator: ", " | " " = ", ",
): string {
  if (index === 0) {
    return "";
  }
  const label = labels[index]!;
  const previous = labels[index - 1];
  if (label.separatorBefore) {
    return `${label.separatorBefore} `;
  }
  return label.kind === "or" || previous?.kind === "or" ? " " : defaultSeparator;
}

function EntryQualifierLine({ labels }: { labels: CanonicalLabel[] }) {
  const qualifiers = labels
    .filter((label) => !["frequency", "level", "academic-register", "exam"].includes(label.kind ?? ""))
    .filter((label) => label.text.trim());

  return qualifiers.length ? (
    <p className="entry-qualifier-line">({labelListText(qualifiers)})</p>
  ) : null;
}

function EntryPatterns({
  patterns,
  className,
}: {
  patterns: CanonicalEntry["headwordPatterns"] | CanonicalSense["patterns"];
  className: string;
}) {
  const visible = (patterns ?? []).filter((pattern) => pattern.text.trim());
  if (!visible.length) {
    return null;
  }
  return (
    <div className={className}>
      {visible.map((pattern, index) => (
        <span key={`${pattern.text}-${index}`}>
          <CanonicalTextContent value={pattern} />
        </span>
      ))}
    </div>
  );
}

function CrossReferenceList({
  references,
  onSelectEntry,
  inline = false,
}: {
  references: CanonicalCrossReference[];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  inline?: boolean;
}) {
  const visible = references.filter((reference) => reference.text.trim());
  if (!visible.length) {
    return null;
  }

  const groups = visible.reduce<
    Array<{
      kind: NonNullable<CanonicalCrossReference["kind"]>;
      label: string;
      references: CanonicalCrossReference[];
    }>
  >((result, reference) => {
    const kind = reference.kind ?? "generic";
    const label = reference.label?.trim() || (kind === "see-also" ? "see also" : "");
    const current = result.at(-1);
    if (current?.label === label && current.kind === kind) {
      current.references.push(reference);
    } else {
      result.push({ kind, label, references: [reference] });
    }
    return result;
  }, []);

  const Container = inline ? "span" : "div";
  const Row = inline ? "span" : "div";

  return (
    <Container className={`cross-references${inline ? " is-inline" : ""}`}>
      {groups.map((group, groupIndex) => {
        const marker = crossReferenceMarker(group.kind);
        return (
          <Row
            className={`cross-reference-row is-${group.kind}`}
            key={`${group.kind}-${group.label}-${groupIndex}`}
          >
            <span className={`cross-reference-label is-${group.kind}`}>
              {marker.kind === "badge" ? (
                <span className="cross-reference-badge">{marker.text}</span>
              ) : marker.kind === "arrow" ? (
                <span className="cross-reference-icon" aria-hidden="true">
                  <ArrowRight />
                </span>
              ) : null}
              {marker.kind !== "badge" && group.label ? <em>{group.label}</em> : null}
            </span>
            {group.references.map((reference, index) => (
              <span className="cross-reference-target" key={reference.id ?? `${reference.text}-${index}`}>
                {index > 0 ? <span className="cross-reference-separator">,</span> : null}
                <button
                  type="button"
                  disabled={!reference.entryId}
                  onClick={() => reference.entryId && onSelectEntry(reference.entryId)}
                >
                  {reference.text}
                  {reference.qualifier ? <small>{reference.qualifier}</small> : null}
                </button>
              </span>
            ))}
          </Row>
        );
      })}
    </Container>
  );
}

function ExampleView({
  example,
  onPlayAudio,
  locationIndex,
  compact = false,
}: {
  example: CanonicalExample;
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
  compact?: boolean;
}) {
  return (
    <div
      className={`example${compact ? " is-compact" : ""}`}
      {...searchLocationAttributes(locationIndex.get(example), example.id)}
    >
      {example.pattern?.text.trim() ? (
        <p className="example-pattern">
          <CanonicalTextContent value={example.pattern} />
        </p>
      ) : null}
      <div className="example-english-row">
        <span className="example-diamond" aria-hidden="true">◆</span>
        <p className="example-english">
          <CanonicalTextContent value={example.text} />
          {example.audio.length ? (
            <span className="example-audio-list">
              {example.audio.slice(0, 2).map((audio, index) => (
                <button
                  className={`example-audio ${audioRegionClass(audio.region)}`}
                  key={`${audio.key}-${index}`}
                  type="button"
                  title="播放例句发音"
                  aria-label="播放例句发音"
                  onClick={() => onPlayAudio(audio.key, "example")}
                >
                  <Volume2 />
                </button>
              ))}
            </span>
          ) : null}
        </p>
      </div>
      {example.translation?.text ? (
        <p className="example-chinese">
          <CanonicalTextContent value={example.translation} />
        </p>
      ) : null}
    </div>
  );
}

function ContentSegmentsView({
  segments,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
  textClassName = "box-text",
  flow = false,
}: {
  segments: CanonicalBoxSegment[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
  textClassName?: string;
  flow?: boolean;
}) {
  return segments.map((segment, segmentIndex) => {
    if (segment.kind === "example") {
      return (
        <ExampleView
          compact
          example={segment.value}
          key={`example-${segmentIndex}`}
          locationIndex={locationIndex}
          onPlayAudio={onPlayAudio}
        />
      );
    }
    if (segment.kind === "term") {
      return (
        <div
          className="box-term"
          key={`term-${segmentIndex}`}
          {...searchLocationPathAttributes(locationIndex.get(segment))}
        >
          <span className="box-term-headword">
            <CanonicalTextContent value={segment.headword} />
          </span>
          {segment.partOfSpeech ? (
            <span className="box-term-pos">
              <CanonicalTextContent value={segment.partOfSpeech} />
            </span>
          ) : null}
        </div>
      );
    }
    if (segment.kind === "cross-references") {
      return (
        <div className="box-cross-references" key={`references-${segmentIndex}`}>
          <CrossReferenceList
            inline
            references={segment.references}
            onSelectEntry={onSelectEntry}
          />
        </div>
      );
    }
    if (segment.kind === "pronunciations") {
      const className = `box-pronunciations${flow ? " is-inline" : ""}`;
      return flow ? (
        <span className={className} key={`pronunciations-${segmentIndex}`} aria-label="发音">
          <InlinePronunciations
            className="box-pronunciation"
            pronunciations={segment.items}
            spokenText="说明中的词语"
            onPlayAudio={onPlayAudio}
          />
        </span>
      ) : (
        <div className={className} key={`pronunciations-${segmentIndex}`} aria-label="发音">
          <InlinePronunciations
            className="box-pronunciation"
            pronunciations={segment.items}
            spokenText="说明中的词语"
            onPlayAudio={onPlayAudio}
          />
        </div>
      );
    }
    return flow ? (
      <span
        className={`${textClassName} is-inline`}
        key={`text-${segmentIndex}`}
        {...searchLocationPathAttributes(locationIndex.get(segment))}
      >
        <CanonicalTextContent value={segment.value} />
      </span>
    ) : (
      <div
        className={textClassName}
        key={`text-${segmentIndex}`}
        {...searchLocationPathAttributes(locationIndex.get(segment))}
      >
        <CanonicalTextContent value={segment.value} />
      </div>
    );
  });
}

function BoxBlockView({
  block,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
}: {
  block: CanonicalBoxBlock;
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
}) {
  if (block.kind === "heading") {
    if (block.level === 1) {
      return (
        <h2 {...searchLocationPathAttributes(locationIndex.get(block))}>
          <CanonicalTextContent value={block.value} />
        </h2>
      );
    }
    return (
      <h3 {...searchLocationPathAttributes(locationIndex.get(block))}>
        <CanonicalTextContent value={block.value} />
      </h3>
    );
  }
  if (block.kind === "paragraph") {
    return block.segments.length ? (
      <div
        className="box-paragraph"
        {...searchLocationPathAttributes(locationIndex.get(block))}
      >
        <ContentSegmentsView
          segments={block.segments}
          locationIndex={locationIndex}
          onPlayAudio={onPlayAudio}
          onSelectEntry={onSelectEntry}
          flow={block.layout === "flow"}
        />
      </div>
    ) : (
      <p {...searchLocationPathAttributes(locationIndex.get(block))}>
        <CanonicalTextContent value={block.value} />
      </p>
    );
  }
  if (block.kind === "unknown") {
    return (
      <p {...searchLocationPathAttributes(locationIndex.get(block))}>
        <CanonicalTextContent value={block.value} />
      </p>
    );
  }

  if (block.kind === "pronunciations") {
    return (
      <div className="box-pronunciations" aria-label="发音">
        <InlinePronunciations
          className="box-pronunciation"
          pronunciations={block.items}
          spokenText="说明中的词语"
          onPlayAudio={onPlayAudio}
        />
      </div>
    );
  }

  if (block.kind === "cross-references") {
    return (
      <div className="box-cross-references">
        <CrossReferenceList inline references={block.references} onSelectEntry={onSelectEntry} />
      </div>
    );
  }

  if (block.kind === "table") {
    return (
      <div className="box-table-scroll">
        <table className="box-table">
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.cells.map((cell, cellIndex) => {
                  const content = cell.segments.length ? (
                    <ContentSegmentsView
                      segments={cell.segments}
                      locationIndex={locationIndex}
                      onPlayAudio={onPlayAudio}
                      onSelectEntry={onSelectEntry}
                    />
                  ) : (
                    <CanonicalTextContent value={cell.value} />
                  );
                  return cell.header ? (
                    <th key={cellIndex} scope="col">{content}</th>
                  ) : (
                    <td key={cellIndex}>{content}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const compact = block.items.every(
    (item) =>
      item.segments.every((segment) => segment.kind === "text") &&
      item.segments.reduce(
        (length, segment) => length + (segment.kind === "text" ? segment.value.text.length : 0),
        0,
      ) < 36,
  );

  return (
    <ul className={compact ? "box-list is-compact" : "box-list"}>
      {block.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          <ContentSegmentsView
            segments={item.segments}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
          />
        </li>
      ))}
    </ul>
  );
}

function IllustrationImage({
  illustration,
  resolveIllustration,
  className,
  variant = "full",
}: {
  illustration: CanonicalIllustration;
  resolveIllustration: EntryViewProps["resolveIllustration"];
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

function ResourceDialog({
  box,
  illustration,
  onClose,
  onPlayAudio,
  onSelectEntry,
  resolveIllustration,
  locationIndex,
}: {
  box: CanonicalGrammarUsageBox | null;
  illustration: CanonicalIllustration | null;
  onClose: () => void;
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  resolveIllustration: EntryViewProps["resolveIllustration"];
  locationIndex: LocationIndex;
}) {
  const open = Boolean(box || illustration);
  useViewportScrollLock(open);
  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const labels = box ? grammarUsageBoxLabels(box) : null;
  const boxPresentation = box ? projectGrammarUsageBox(box) : null;
  return (
    <DialogPortal>
      <div className="resource-dialog-layer" role="presentation" onMouseDown={onClose}>
        <section
          className="resource-dialog"
          data-inline-lookup-surface
          {...(box ? searchLocationAttributes(locationIndex.get(box), box.id) : {})}
          role="dialog"
          aria-modal="true"
          aria-label={labels?.primary ?? "图解词汇"}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header>
            <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
            <strong>{labels ? `${labels.secondary} ${labels.primary}` : "图解词汇"}</strong>
            <span aria-hidden="true" />
          </header>
          <div className="resource-dialog-body">
            {box ? (
              <>
                {boxPresentation?.title ? (
                  <h1>{boxPresentation.title.text.trim()}</h1>
                ) : null}
                {boxPresentation?.references.length ? (
                  <div className="box-reference-grid" role="list">
                    {boxPresentation.references.map((reference, index) => (
                      <button
                        disabled={!reference.entryId}
                        key={reference.id ?? `${reference.text}-${index}`}
                        onClick={() => {
                          if (reference.entryId) {
                            onClose();
                            onSelectEntry(reference.entryId);
                          }
                        }}
                        role="listitem"
                        type="button"
                      >
                        {reference.text}
                      </button>
                    ))}
                  </div>
                ) : null}
                {boxPresentation?.blocks.map((block, index) => (
                  <BoxBlockView
                    block={block}
                    key={index}
                    locationIndex={locationIndex}
                    onPlayAudio={onPlayAudio}
                    onSelectEntry={onSelectEntry}
                  />
                ))}
              </>
            ) : illustration ? (
              <figure>
                <IllustrationImage
                  className="resource-dialog-image"
                  illustration={illustration}
                  resolveIllustration={resolveIllustration}
                />
                {illustration.text ? <figcaption>{illustration.text}</figcaption> : null}
              </figure>
            ) : null}
          </div>
        </section>
      </div>
    </DialogPortal>
  );
}

function SenseVariantsView({
  forms,
  onPlayAudio,
  locationIndex,
}: {
  forms: CanonicalForm[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
}) {
  if (!forms.length) {
    return null;
  }
  return (
    <span className="sense-variants">
      {forms.map((form, index) => (
        <span
          className="sense-variant"
          key={`${form.text}-${index}`}
          {...searchLocationAttributes(locationIndex.get(form), form.id)}
        >
          {index > 0 ? <span className="sense-variant-separator">, </span> : null}
          <span aria-hidden="true">(</span>
          <VariantFormContent classPrefix="sense" form={form} onPlayAudio={onPlayAudio} />
          <span aria-hidden="true">)</span>
        </span>
      ))}
    </span>
  );
}

function SenseView({
  sense,
  path,
  anchorPath,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
  showGroupHeading,
  showNumber = true,
}: {
  sense: CanonicalSense;
  path: number[];
  anchorPath: QuickFindSensePath;
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
  showGroupHeading: boolean;
  showNumber?: boolean;
}) {
  const displayNumber = path.join(".");
  const definitionFlow = senseDefinitionFlow(sense);
  const referencePlacement = senseReferencePlacement(sense);
  const definitionSegments = sense.definitionSegments ?? [];
  const hasStructuredDefinition =
    definitionSegments.some((segment) => segment.kind === "pronunciations") &&
    definitionSegments.every(
      (segment) => segment.kind === "text" || segment.kind === "pronunciations",
    );
  const inlineEquivalentReferences =
    referencePlacement.trailing.length > 0 &&
    referencePlacement.trailing.every(
      (reference) => reference.kind === "equivalent" || reference.kind === "punctuation",
    ) &&
    !(sense.pronunciations ?? []).length &&
    !(sense.variants ?? []).length &&
    !(sense.inflectedForms ?? []).length &&
    !(sense.patterns ?? []).some((pattern) => pattern.text.trim()) &&
    !(sense.inlineUsage ?? []).some((usage) => usage.text.trim()) &&
    !sense.definition?.text.trim() &&
    !sense.translation?.text.trim() &&
    sense.examples.length === 0 &&
    sense.usage.length === 0 &&
    sense.subsenses.length === 0;
  return (
    <li
      className="sense"
      id={senseQuickFindAnchor(sense, anchorPath)}
      {...searchLocationAttributes(locationIndex.get(sense), sense.id)}
    >
      {showGroupHeading && sense.groupHeading?.text.trim() ? (
        <h3 className="sense-group-heading">
          <span className="sense-group-marker" aria-hidden="true" />
          <span className="sense-group-copy">
            <CanonicalTextContent value={sense.groupHeading} />
          </span>
        </h3>
      ) : null}
      <div className="sense-row">
        {showNumber ? (
          <span className="sense-number" aria-label={`释义 ${displayNumber}`}>
            {`${displayNumber}.`}
          </span>
        ) : null}
        <div className="sense-content">
          <InlinePronunciations
            className="sense-pronunciation"
            pronunciations={sense.pronunciations ?? []}
            spokenText="该词义"
            onPlayAudio={onPlayAudio}
          />
          <InflectedFormsView
            classPrefix="sense"
            forms={sense.inflectedForms ?? []}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
          />
          {sense.labels.length ? <SenseLabels labels={sense.labels} /> : null}
          <SenseVariantsView
            forms={sense.variants ?? []}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
          />
          <EntryPatterns className="sense-patterns" patterns={sense.patterns} />
          {sense.inlineUsage?.map((usage, index) => (
            <span
              className="sense-inline-usage"
              key={`${usage.text}-${index}`}
              {...searchLocationPathAttributes(locationIndex.get(usage))}
            >
              <CanonicalTextContent value={usage} />{" "}
            </span>
          ))}
          {sense.definition?.text || sense.translation?.text ? (
            <p className={`sense-definition is-${definitionFlow}`}>
              {sense.definition?.text ? (
                <span className="definition-english">
                  {hasStructuredDefinition ? (
                    <ContentSegmentsView
                      flow
                      locationIndex={locationIndex}
                      onPlayAudio={onPlayAudio}
                      onSelectEntry={onSelectEntry}
                      segments={definitionSegments}
                      textClassName="definition-english"
                    />
                  ) : (
                    <CanonicalTextContent value={sense.definition} />
                  )}
                </span>
              ) : null}
              {sense.translation?.text ? (
                <span className="definition-chinese">
                  <CanonicalTextContent value={sense.translation} />
                </span>
              ) : null}
              <CrossReferenceList
                inline
                references={referencePlacement.definition}
                onSelectEntry={onSelectEntry}
              />
            </p>
          ) : null}

          {sense.examples.length ? (
            <ul className="example-list">
              {sense.examples.map((example, index) => (
                <li key={example.id ?? `${example.text.text}-${index}`}>
                  <ExampleView
                    example={example}
                    locationIndex={locationIndex}
                    onPlayAudio={onPlayAudio}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          {sense.usageSegments.length ? (
            <div className="sense-usage-segments">
              <ContentSegmentsView
                onPlayAudio={onPlayAudio}
                onSelectEntry={onSelectEntry}
                locationIndex={locationIndex}
                segments={sense.usageSegments}
                textClassName="sense-usage"
              />
            </div>
          ) : (
            sense.usage.map((usage, index) => (
              <p
                className="sense-usage"
                key={`${usage.text}-${index}`}
                {...searchLocationPathAttributes(locationIndex.get(usage))}
              >
                <CanonicalTextContent value={usage} />
              </p>
            ))
          )}

          <CrossReferenceList
            inline={inlineEquivalentReferences}
            references={referencePlacement.trailing}
            onSelectEntry={onSelectEntry}
          />

          {sense.subsenses.length ? (
            <SenseList
              className="subsense-list"
              onPlayAudio={onPlayAudio}
              onSelectEntry={onSelectEntry}
              locationIndex={locationIndex}
              pathPrefix={path}
              anchorPathPrefix={anchorPath}
              senses={sense.subsenses}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SenseList({
  senses,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
  pathPrefix = [],
  anchorPathPrefix = ["root"],
  showNumbers = true,
  className = "",
}: {
  senses: CanonicalSense[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
  pathPrefix?: number[];
  anchorPathPrefix?: QuickFindSensePath;
  showNumbers?: boolean;
  className?: string;
}) {
  return (
    <ol className={`sense-list${className ? ` ${className}` : ""}`}>
      {senses.map((sense, index) => {
        const previousHeading = senses[index - 1]?.groupHeading?.text.trim();
        const currentHeading = sense.groupHeading?.text.trim();
        return (
          <SenseView
            key={sense.id ?? `${pathPrefix.join("-")}-${index}`}
            sense={sense}
            path={[...pathPrefix, index + 1]}
            anchorPath={[...anchorPathPrefix, index]}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
            locationIndex={locationIndex}
            showGroupHeading={Boolean(currentHeading && currentHeading !== previousHeading)}
            showNumber={showNumbers}
          />
        );
      })}
    </ol>
  );
}

function PhraseSection({
  id,
  collection,
  label,
  phrases,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
}: {
  id: string;
  collection: "idioms" | "phrasalVerbs";
  label: string;
  phrases: CanonicalPhrase[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
}) {
  if (!phrases.length) {
    return null;
  }

  return (
    <section className="phrase-section" id={id}>
      <h2 className="phrase-section-heading" aria-label={label}>
        {id === "idioms" ? "IDIOMS" : "PHRASAL VERBS"}
      </h2>
      {phrases.map((phrase, phraseIndex) => (
        <article
          className="phrase-entry"
          id={phraseQuickFindAnchor(collection, phrase, phraseIndex)}
          key={phrase.id ?? `${phrase.display.text}-${phraseIndex}`}
          {...searchLocationAttributes(locationIndex.get(phrase), phrase.id)}
        >
          {phrase.leadingUsage.map((usage, usageIndex) => (
            <p
              className="phrase-leading-usage"
              key={`${usage.text}-${usageIndex}`}
              {...searchLocationPathAttributes(locationIndex.get(usage))}
            >
              <CanonicalTextContent value={usage} />
            </p>
          ))}
          <h3><CanonicalTextContent value={phrase.display} /></h3>
          <PhraseVariantsView
            forms={phrase.variants}
            primaryLabels={phrase.labels}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
          />
          <SenseList
            senses={phrase.senses}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
            locationIndex={locationIndex}
            showNumbers={phrase.senses.length > 1}
            anchorPathPrefix={["phrase", collection, phraseIndex]}
          />
          <CrossReferenceList
            references={phrase.trailingCrossReferences}
            onSelectEntry={onSelectEntry}
          />
        </article>
      ))}
    </section>
  );
}

function normalizedDisplayHeadword(value: string): string {
  return value.replace(/[\u00b7\u2027]/g, "").trim().toLocaleLowerCase();
}

function displayTranscription(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("/") && normalized.endsWith("/")
    ? normalized
    : `/${normalized.replace(/^\/+|\/+$/g, "")}/`;
}

function InlinePronunciations({
  pronunciations,
  spokenText,
  className,
  onPlayAudio,
}: {
  pronunciations: CanonicalPronunciation[];
  spokenText: string;
  className: string;
  onPlayAudio: EntryViewProps["onPlayAudio"];
}) {
  return pronunciations.map((pronunciation, pronunciationIndex) => (
    <span
      className={`${className} ${audioRegionClass(pronunciation.region)}`}
      key={`${pronunciation.region}-${pronunciation.transcription}-${pronunciationIndex}`}
    >
      {pronunciation.region ? <em>{pronunciation.region}</em> : null}
      {pronunciation.form ? <span>{pronunciation.form}</span> : null}
      {pronunciation.transcription ? (
        <span className="phonetic">{displayTranscription(pronunciation.transcription)}</span>
      ) : null}
      {pronunciation.audioKey ? (
        <button
          className={`voice-button ${audioRegionClass(pronunciation.region)}`}
          type="button"
          title={`播放${spokenText}${pronunciation.region ?? ""}发音`}
          aria-label={`播放${spokenText}${pronunciation.region ?? ""}发音`}
          onClick={() => onPlayAudio(pronunciation.audioKey!, "headword")}
        >
          <Volume2 />
        </button>
      ) : null}
    </span>
  ));
}

function InflectedFormsView({
  classPrefix,
  forms,
  onPlayAudio,
  locationIndex,
}: {
  classPrefix: "derived-form" | "entry" | "sense";
  forms: CanonicalForm[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
}) {
  const visible = forms.filter((form) => form.text.trim());
  if (!visible.length) {
    return null;
  }

  return (
    <span className={`${classPrefix}-inflected-forms`}>
      <span aria-hidden="true">(</span>
      {visible.map((form, formIndex) => (
        <span
          className={`${classPrefix}-inflected-form`}
          key={`${form.kind}-${form.text}-${formIndex}`}
          {...searchLocationAttributes(locationIndex.get(form), form.id)}
        >
          {formIndex > 0 ? <span className={`${classPrefix}-inflected-separator`}>, </span> : null}
          {form.kind === "inflection-constraint" ? (
            <em className={`${classPrefix}-inflection-constraint`}>{form.text}</em>
          ) : (
            <>
              {form.introducer?.text.trim() ? <em>{form.introducer.text.trim()} </em> : null}
              <strong>{form.text}</strong>
              <InlinePronunciations
                className={`${classPrefix}-inflected-pronunciation`}
                pronunciations={form.pronunciations ?? []}
                spokenText={form.text}
                onPlayAudio={onPlayAudio}
              />
            </>
          )}
        </span>
      ))}
      <span aria-hidden="true">)</span>
    </span>
  );
}

function formPresentationItems(form: CanonicalForm): CanonicalFormPresentationItem[] {
  if (form.presentation?.length) {
    return form.presentation;
  }
  return [
    ...(form.introducer
      ? [{ kind: "introducer" as const, value: form.introducer }]
      : []),
    ...(form.labels ?? []).map((label) => ({
      kind: "label" as const,
      value: label,
    })),
    { kind: "target" as const },
    ...((form.pronunciations ?? []).length
      ? [{ kind: "pronunciation" as const }]
      : []),
  ];
}

function FormPresentationContent({
  classPrefix,
  form,
  items,
  onPlayAudio,
}: {
  classPrefix: "derived-form" | "entry" | "phrase" | "sense";
  form: CanonicalForm;
  items: CanonicalFormPresentationItem[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
}) {
  return items.map((item, index) => {
    const separator = index === 0 || item.kind === "pronunciation"
      ? ""
      : item.kind === "label" && item.value.separatorBefore
        ? `${item.value.separatorBefore} `
        : " ";
    if (item.kind === "target") {
      return (
        <Fragment key={`target-${index}`}>
          {separator}<strong className={`${classPrefix}-variant-target`}>{form.text}</strong>
        </Fragment>
      );
    }
    if (item.kind === "pronunciation") {
      return (
        <InlinePronunciations
          className={`${classPrefix}-variant-pronunciation`}
          pronunciations={form.pronunciations ?? []}
          spokenText={form.text}
          key={`pronunciation-${index}`}
          onPlayAudio={onPlayAudio}
        />
      );
    }
    if (item.kind === "introducer") {
      return (
        <em className={`${classPrefix}-variant-introducer`} key={`introducer-${index}`}>
          {separator}<CanonicalTextContent value={item.value} />
        </em>
      );
    }
    return (
      <em
        className={`${classPrefix}-variant-label`}
        key={`${item.value.kind}-${item.value.text}-${index}`}
      >
        {separator}{item.value.text}
      </em>
    );
  });
}

function VariantFormContent({
  classPrefix,
  form,
  onPlayAudio,
}: {
  classPrefix: "derived-form" | "entry" | "phrase" | "sense";
  form: CanonicalForm;
  onPlayAudio: EntryViewProps["onPlayAudio"];
}) {
  const presentation = formPresentationItems(form);
  return (
    <FormPresentationContent
      classPrefix={classPrefix}
      form={form}
      items={presentation}
      onPlayAudio={onPlayAudio}
    />
  );
}

function PhraseVariantsView({
  forms,
  primaryLabels,
  onPlayAudio,
  locationIndex,
}: {
  forms: CanonicalForm[];
  primaryLabels: CanonicalLabel[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
}) {
  const labels = primaryLabels.filter((label) => label.text.trim());
  if (!forms.length && !labels.length) {
    return null;
  }

  return (
    <div className="phrase-variants">
      {labels.length ? (
        <span className="phrase-labels">({labelListText(labels)})</span>
      ) : null}
      {forms.map((form, formIndex) => (
        <span
          className={`phrase-variant is-${form.relation === "equivalent" ? "equivalent" : "alternative"}`}
          key={`${form.text}-${formIndex}`}
          {...searchLocationAttributes(locationIndex.get(form), form.id)}
        >
          <span aria-hidden="true">(</span>
          <VariantFormContent
            classPrefix="phrase"
            form={form}
            onPlayAudio={onPlayAudio}
          />
          <span aria-hidden="true">)</span>
        </span>
      ))}
    </div>
  );
}

function VariantFormsView({
  forms,
  onPlayAudio,
  locationIndex,
}: {
  forms: CanonicalForm[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
}) {
  if (!forms.length) {
    return null;
  }

  return (
    <p className="entry-variants">
      <span aria-hidden="true">(</span>
      {forms.map((form, formIndex) => (
        <span
          className="entry-variant"
          key={`${form.text}-${formIndex}`}
          {...searchLocationAttributes(locationIndex.get(form), form.id)}
        >
          {formIndex > 0 ? <span className="entry-variant-separator">, </span> : null}
          <VariantFormContent
            classPrefix="entry"
            form={form}
            onPlayAudio={onPlayAudio}
          />
        </span>
      ))}
      <span aria-hidden="true">)</span>
    </p>
  );
}

function HeadwordFormsView({
  usage,
  patterns,
  forms,
  onPlayAudio,
  locationIndex,
}: {
  usage: CanonicalEntry["headwordUsage"];
  patterns: CanonicalEntry["headwordPatterns"];
  forms: CanonicalForm[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  locationIndex: LocationIndex;
}) {
  const visibleUsage = (usage ?? []).filter((item) => item.text.trim());
  const visiblePatterns = (patterns ?? []).filter((pattern) => pattern.text.trim());
  if (!visibleUsage.length && !visiblePatterns.length && !forms.length) {
    return null;
  }

  return (
    <p className="entry-headword-forms">
      {visibleUsage.map((item, index) => (
        <span
          className="entry-headword-usage"
          key={`${item.text}-${index}`}
          {...searchLocationPathAttributes(locationIndex.get(item))}
        >
          {index > 0 ? " " : null}
          <CanonicalTextContent value={item} />
        </span>
      ))}
      {visibleUsage.length && visiblePatterns.length ? " " : null}
      {visiblePatterns.map((pattern, index) => (
        <span className="entry-headword-form-pattern" key={`${pattern.text}-${index}`}>
          {index > 0 ? " " : null}
          <CanonicalTextContent value={pattern} />
        </span>
      ))}
      {(visibleUsage.length || visiblePatterns.length) && forms.length ? " " : null}
      <InflectedFormsView
        classPrefix="entry"
        forms={forms}
        locationIndex={locationIndex}
        onPlayAudio={onPlayAudio}
      />
    </p>
  );
}

function DerivedFormsView({
  forms,
  onPlayAudio,
  onSelectEntry,
  locationIndex,
}: {
  forms: CanonicalForm[];
  onPlayAudio: EntryViewProps["onPlayAudio"];
  onSelectEntry: EntryViewProps["onSelectEntry"];
  locationIndex: LocationIndex;
}) {
  if (!forms.length) {
    return null;
  }

  return (
    <section className="derived-forms" id="derived-forms">
      <h2 className="derived-section-heading">
        <span className="sense-group-marker" aria-hidden="true" />
        <span>派生词</span>
      </h2>
      <div className="derived-form-list">
        {forms.map((form, index) => (
          <article
            className="derived-form"
            key={form.id ?? `${form.kind}-${form.text}-${index}`}
            {...searchLocationAttributes(locationIndex.get(form), form.id)}
          >
            <div className="derived-form-heading">
              <h3>
                <CanonicalTextContent
                  value={{ text: form.text, tokens: form.tokens, raw: form.raw }}
                />
                {(form.variants ?? []).length ? (
                  <span className="derived-form-variants">
                    {" "}<span aria-hidden="true">(</span>
                    {(form.variants ?? []).map((variant, variantIndex) => (
                      <span
                        className="derived-form-variant"
                        key={`${variant.text}-${variantIndex}`}
                        {...searchLocationAttributes(locationIndex.get(variant), variant.id)}
                      >
                        {variantIndex > 0 ? (
                          <span className="derived-form-variant-separator">, </span>
                        ) : null}
                        <VariantFormContent
                          classPrefix="derived-form"
                          form={variant}
                          onPlayAudio={onPlayAudio}
                        />
                      </span>
                    ))}
                    <span aria-hidden="true">)</span>
                  </span>
                ) : null}
                {(form.inflectedForms ?? []).length ? (
                  <>
                    {" "}
                    <InflectedFormsView
                      classPrefix="derived-form"
                      forms={form.inflectedForms ?? []}
                      locationIndex={locationIndex}
                      onPlayAudio={onPlayAudio}
                    />
                  </>
                ) : null}
              </h3>
              {form.partOfSpeech ? (
                <span className="derived-form-pos">
                  {partOfSpeechTabLabel(form.partOfSpeech)}
                </span>
              ) : null}
            </div>
            {(form.usage ?? []).map((usage, usageIndex) => (
              <p
                className="derived-form-usage"
                key={`${usage.text}-${usageIndex}`}
                {...searchLocationPathAttributes(locationIndex.get(usage))}
              >
                <CanonicalTextContent value={usage} />
              </p>
            ))}
            {(form.pronunciations ?? []).length ? (
              <div className="derived-form-pronunciations">
                <InlinePronunciations
                  className="derived-form-pronunciation"
                  pronunciations={form.pronunciations ?? []}
                  spokenText={form.text}
                  onPlayAudio={onPlayAudio}
                />
              </div>
            ) : null}
            {(form.labels ?? []).length ? (
              <div className="derived-form-metadata">
                <SenseLabels labels={form.labels ?? []} />
              </div>
            ) : null}
            {form.note?.text.trim() ? (
              <p className="derived-form-note">
                <CanonicalTextContent value={form.note} />
              </p>
            ) : null}
            {(form.senses ?? []).length ? (
              <SenseList
                anchorPathPrefix={["derived", index]}
                onPlayAudio={onPlayAudio}
                onSelectEntry={onSelectEntry}
                locationIndex={locationIndex}
                senses={form.senses ?? []}
                showNumbers={(form.senses ?? []).length > 1}
              />
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export function EntryView({
  entry,
  enhancements,
  projection,
  favorite,
  entryPending,
  activeSectionId,
  audioError,
  resolveIllustration,
  onPartChange,
  onJump,
  onToggleFavorite,
  onOpenNote,
  onSelectEntry,
  onPlayAudio,
  etymology,
  prefetchedEtymologyArticle,
  onEtymologyChange,
  onNavigateEtymology,
  searchLocation,
  onSearchLocationSettled,
}: EntryViewProps) {
  const resourceScope = `${entry.id}:${projection.activeIndex}`;
  const locationIndex = useMemo(
    () => indexCanonicalEntrySearchLocations(entry),
    [entry],
  );
  const resources = useMemo(
    () => buildEntryResources(projection, enhancements ?? []),
    [enhancements, projection],
  );
  const hasResources = resources.length > 0;
  const [activeResource, setActiveResource] = useState<{
    scope: string;
    box?: CanonicalGrammarUsageBox;
    illustration?: CanonicalIllustration;
  } | null>(null);
  const activeBox = activeResource?.scope === resourceScope
    ? activeResource.box ?? null
    : null;
  const activeIllustration = activeResource?.scope === resourceScope
    ? activeResource.illustration ?? null
    : null;
  const activeEtymology = etymology
    ? resources.find(
        (resource): resource is Extract<EntryResource, { kind: "etymology" }> =>
          resource.kind === "etymology" &&
          (etymology.articleId
            ? resource.summary.articles.some((article) => article.id === etymology.articleId)
            : resource.summary.term === etymology.term),
      )?.summary ?? null
    : null;

  const closeResource = useCallback(() => {
    setActiveResource(null);
  }, []);
  const openResource = useCallback((resource: EntryResource, articleId?: string) => {
    if (resource.kind === "etymology") {
      onEtymologyChange?.({
        term: resource.summary.term,
        articleId: articleId ?? resource.summary.articles[0]?.id,
      });
      return;
    }
    setActiveResource(
      resource.kind === "box"
        ? { scope: resourceScope, box: resource.box }
        : { scope: resourceScope, illustration: resource.illustration },
    );
  }, [onEtymologyChange, resourceScope]);

  useEffect(() => {
    if (!searchLocation) {
      return;
    }
    const targetResource = resources.find((resource) => {
      const target = entryResourceSearchLocationTarget(resource);
      if (!target) {
        return false;
      }
      const location = locationIndex.get(target);
      return Boolean(
        location &&
        location.section === searchLocation.section &&
        ((searchLocation.ownerId && location.ownerId === searchLocation.ownerId) ||
          searchLocationContains(location, searchLocation)),
      );
    });
    if (targetResource) {
      const target = entryResourceSearchLocationTarget(targetResource);
      const activeTarget = activeBox ?? activeIllustration;
      if (target && target !== activeTarget) {
        const frame = window.requestAnimationFrame(() => openResource(targetResource));
        return () => window.cancelAnimationFrame(frame);
      }
    }

    const frame = window.requestAnimationFrame(() => {
      revealSearchLocation(searchLocation);
      onSearchLocationSettled?.(searchLocation);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeBox,
    activeIllustration,
    locationIndex,
    onSearchLocationSettled,
    openResource,
    resources,
    searchLocation,
  ]);

  return (
    <article className={`entry-view${entryPending ? " is-pending" : ""}`}>
      <header className="entry-header">
        <div className="headword-row">
          <div className="headword-block">
            <div className="headword-line">
              <h1>{entry.displayHeadword || entry.headword}</h1>
              {projection.headerLabels.map((label, index) => (
                <EntryLabel label={label} index={index} key={`${label.text}-${index}`} />
              ))}
            </div>

            {entry.pronunciations.length ? (
              <div className="pronunciation-list" aria-label="发音">
                {entry.pronunciations.map((pronunciation, index) => (
                  <div
                    className={`pronunciation ${audioRegionClass(pronunciation.region)}`}
                    key={`${pronunciation.region}-${pronunciation.transcription}-${index}`}
                  >
                    {pronunciation.region ? <span className="pronunciation-region">{pronunciation.region}</span> : null}
                    {pronunciation.form ? <span className="pronunciation-form">{pronunciation.form}</span> : null}
                    {pronunciation.transcription ? (
                      <span className="phonetic">{displayTranscription(pronunciation.transcription)}</span>
                    ) : null}
                    {pronunciation.audioKey ? (
                      <button
                        className={`voice-button ${audioRegionClass(pronunciation.region)}`}
                        type="button"
                        title={`播放${pronunciation.region ?? ""}发音`}
                        aria-label={`播放${pronunciation.region ?? ""}发音`}
                        onClick={() => onPlayAudio(pronunciation.audioKey!, "headword")}
                      >
                        <Volume2 />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <VariantFormsView
              forms={projection.variants}
              locationIndex={locationIndex}
              onPlayAudio={onPlayAudio}
            />
            {audioError ? <p className="media-error" role="status">{audioError}</p> : null}
          </div>

          <div className="entry-actions">
            <button
              type="button"
              className={favorite ? "is-active" : ""}
              title={favorite ? "取消收藏" : "收藏词条"}
              aria-label={favorite ? "取消收藏" : "收藏词条"}
              aria-pressed={favorite}
              onClick={onToggleFavorite}
            >
              <Star fill={favorite ? "currentColor" : "none"} />
            </button>
          </div>
        </div>
      </header>

      {projection.options.length ? (
        <div className="part-of-speech-tabs" role="tablist" aria-label="词性">
          {projection.options.map((part, index) => (
            <button
              className={projection.activeIndex === index ? "is-active" : ""}
              id={`part-tab-${index}`}
              key={`${part.text}-${index}`}
              type="button"
              role="tab"
              aria-controls={`part-${index}`}
              aria-selected={projection.activeIndex === index}
              onClick={() => onPartChange(index)}
            >
              {partOfSpeechTabLabel(part.text)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="entry-part-heading-row">
        {projection.selectedOption ? (
          <h2 className="entry-part-marker">{projection.selectedOption.text}</h2>
        ) : null}
        <button className="entry-note-action" type="button" onClick={onOpenNote}>
          <NotebookPen aria-hidden="true" />
          <span>添加笔记</span>
        </button>
      </div>

      <div className={`entry-content-layout${hasResources ? " has-resources" : ""}`}>
        <div className="entry-main-column">
          <section className="entry-body" id="definitions">
            <div
              id={`part-${projection.activeIndex}`}
              role={projection.options.length ? "tabpanel" : undefined}
              aria-labelledby={projection.options.length ? `part-tab-${projection.activeIndex}` : undefined}
            >
              <EntryQualifierLine labels={entry.labels} />

              <HeadwordFormsView
                forms={projection.inflectedForms}
                locationIndex={locationIndex}
                onPlayAudio={onPlayAudio}
                patterns={entry.headwordPatterns}
                usage={entry.headwordUsage}
              />

              {projection.headwordFamilyNotes.length ? (
                <div className="entry-headword-family-notes">
                  {projection.headwordFamilyNotes.map((note, index) => (
                    <p key={`${note.text}-${index}`}>
                      <CanonicalTextContent value={note} />
                    </p>
                  ))}
                </div>
              ) : null}

              <SenseList
                locationIndex={locationIndex}
                senses={projection.senses}
                onPlayAudio={onPlayAudio}
                onSelectEntry={onSelectEntry}
              />

              {projection.subentries.map((subentry, subentryIndex) => {
                const repeatedHeadword =
                  normalizedDisplayHeadword(subentry.displayHeadword || subentry.headword) ===
                  normalizedDisplayHeadword(entry.displayHeadword || entry.headword);
                return (
                  <section
                    className={`subentry${repeatedHeadword ? " is-continuation" : ""}`}
                    id={`subentry-${subentry.id}`}
                    key={subentry.id}
                  >
                    {!repeatedHeadword ? (
                      <>
                        <h2>{subentry.displayHeadword || subentry.headword}</h2>
                        {subentry.partsOfSpeech.map((part, index) => (
                          <span className="subentry-pos" key={`${part.text}-${index}`}>{part.text}</span>
                        ))}
                      </>
                    ) : null}
                    <EntryQualifierLine labels={subentry.labels} />
                    {(subentry.headwordUsage ?? []).map((usage, usageIndex) => (
                      <p className="entry-headword-forms" key={`${usage.text}-${usageIndex}`}>
                        <span
                          className="entry-headword-usage"
                          {...searchLocationPathAttributes(locationIndex.get(usage))}
                        >
                          <CanonicalTextContent value={usage} />
                        </span>
                      </p>
                    ))}
                    <EntryPatterns
                      className="entry-headword-patterns"
                      patterns={subentry.headwordPatterns}
                    />
                    <SenseList
                      anchorPathPrefix={["subentry", subentryIndex]}
                      senses={subentry.senses}
                      locationIndex={locationIndex}
                      onPlayAudio={onPlayAudio}
                      onSelectEntry={onSelectEntry}
                    />
                  </section>
                );
              })}
            </div>
          </section>

          <PhraseSection
            collection="idioms"
            id="idioms"
            label="习语"
            phrases={projection.idioms}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
          />
          <PhraseSection
            collection="phrasalVerbs"
            id="phrasal-verbs"
            label="短语动词"
            phrases={projection.phrasalVerbs}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
          />

          <DerivedFormsView
            forms={projection.derivedForms}
            locationIndex={locationIndex}
            onPlayAudio={onPlayAudio}
            onSelectEntry={onSelectEntry}
          />
        </div>

        <EntryResourceRail
          resources={resources}
          onOpen={openResource}
          resolveIllustration={resolveIllustration}
        />
      </div>

      <ResourceDialog
        box={activeBox}
        illustration={activeIllustration}
        locationIndex={locationIndex}
        onClose={closeResource}
        onPlayAudio={onPlayAudio}
        onSelectEntry={onSelectEntry}
        resolveIllustration={resolveIllustration}
      />
      <EtymologyDialog
        articleId={etymology?.articleId}
        initialArticle={prefetchedEtymologyArticle}
        onArticleChange={(articleId) => {
          if (etymology) {
            onEtymologyChange?.({ ...etymology, articleId });
          }
        }}
        onClose={() => onEtymologyChange?.(null)}
        onNavigate={onNavigateEtymology ?? (() => undefined)}
        resource={activeEtymology}
      />
      <MobileQuickFind
        activeSectionId={activeSectionId}
        onJump={onJump}
        onOpenResource={openResource}
        onPartChange={onPartChange}
        projection={projection}
        resources={resources}
        scopeKey={entry.id}
      />
    </article>
  );
}
