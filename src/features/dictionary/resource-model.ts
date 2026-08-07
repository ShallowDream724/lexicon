import type {
  EtymologyArticleSummary,
  EtymologyResourceSummary,
} from "../../../packages/enhancement-schema/src/index";
import type {
  CanonicalGrammarUsageBox,
  CanonicalIllustration,
} from "../../../packages/dictionary-schema/src/index";
import { grammarUsageBoxLabels } from "./box-presentation";
import type { EntryPartProjection } from "./entry-sections";

export type EntryResource =
  | { kind: "etymology"; key: string; summary: EtymologyResourceSummary }
  | { kind: "illustration"; key: string; illustration: CanonicalIllustration }
  | { kind: "box"; key: string; box: CanonicalGrammarUsageBox };

export type EntryResourceKind = EntryResource["kind"];

type ResourceDefinition = {
  order: number;
  quickFindLabel: (resource: EntryResource) => string;
  quickFindAction: "open-resource";
  size: "feature" | "native";
};

export const entryResourceRegistry: Record<EntryResourceKind, ResourceDefinition> = {
  etymology: {
    order: 0,
    quickFindLabel: () => "词源",
    quickFindAction: "open-resource",
    size: "feature",
  },
  illustration: {
    order: 20,
    quickFindLabel: () => "图解词汇",
    quickFindAction: "open-resource",
    size: "native",
  },
  box: {
    order: 30,
    quickFindLabel: (resource) =>
      resource.kind === "box" ? grammarUsageBoxLabels(resource.box).primary : "词条资料",
    quickFindAction: "open-resource",
    size: "native",
  },
};

export function entryResourceLabel(resource: EntryResource): string {
  return entryResourceRegistry[resource.kind].quickFindLabel(resource);
}

export function entryResourceSize(resource: EntryResource): "feature" | "native" {
  return entryResourceRegistry[resource.kind].size;
}

export function entryResourceQuickFindAction(resource: EntryResource): "open-resource" {
  return entryResourceRegistry[resource.kind].quickFindAction;
}

export function etymologyArticleLabel(
  article: Pick<EtymologyArticleSummary, "label">,
  index: number,
): string {
  return article.label.trim() || `词源 ${index + 1}`;
}

export function buildEntryResources(
  projection: EntryPartProjection,
  enhancements: readonly EtymologyResourceSummary[],
): EntryResource[] {
  const resources: EntryResource[] = [
    ...enhancements.map((summary) => ({
      kind: "etymology" as const,
      key: `etymology:${summary.resourceId}`,
      summary,
    })),
    ...projection.illustrations.map((illustration, index) => ({
      kind: "illustration" as const,
      key: `illustration:${illustration.key ?? index}`,
      illustration,
    })),
    ...projection.grammarUsageBoxes.map((box, index) => ({
      kind: "box" as const,
      key: `box:${box.id ?? index}`,
      box,
    })),
  ];

  return resources.sort(
    (left, right) => entryResourceRegistry[left.kind].order - entryResourceRegistry[right.kind].order,
  );
}
