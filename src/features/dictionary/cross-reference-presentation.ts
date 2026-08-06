import type { CanonicalCrossReferenceKind } from "../../../packages/dictionary-schema/src/index";

export type CrossReferenceMarker =
  | { kind: "arrow" }
  | { kind: "badge"; text: "SYN" | "OPP" }
  | { kind: "none" };

const markerByKind = {
  synonym: { kind: "badge", text: "SYN" },
  antonym: { kind: "badge", text: "OPP" },
  compare: { kind: "arrow" },
  "see-also": { kind: "arrow" },
  "more-at": { kind: "arrow" },
  "note-at": { kind: "arrow" },
  "topic-note": { kind: "arrow" },
  related: { kind: "arrow" },
  inflection: { kind: "none" },
  equivalent: { kind: "none" },
  punctuation: { kind: "none" },
  generic: { kind: "arrow" },
} as const satisfies Record<CanonicalCrossReferenceKind, CrossReferenceMarker>;

export function crossReferenceMarker(
  kind: CanonicalCrossReferenceKind,
): CrossReferenceMarker {
  return markerByKind[kind];
}
