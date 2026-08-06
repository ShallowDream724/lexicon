import type {
  CanonicalCrossReference,
  CanonicalSense,
} from "../../../packages/dictionary-schema/src/index";

export type SenseDefinitionFlow = "inline" | "stacked";

export function senseDefinitionFlow(sense: Pick<CanonicalSense, "patterns">): SenseDefinitionFlow {
  return (sense.patterns ?? []).some((pattern) => pattern.text.trim())
    ? "stacked"
    : "inline";
}

export type SenseReferencePlacement = {
  definition: CanonicalCrossReference[];
  trailing: CanonicalCrossReference[];
};

const definitionReferenceKinds = new Set<CanonicalCrossReference["kind"]>([
  "synonym",
  "antonym",
]);

export function senseReferencePlacement(
  sense: Pick<CanonicalSense, "crossReferences" | "definition" | "translation">,
): SenseReferencePlacement {
  const hasDefinition = Boolean(sense.definition?.text.trim() || sense.translation?.text.trim());
  if (!hasDefinition) {
    return { definition: [], trailing: sense.crossReferences };
  }

  return sense.crossReferences.reduce<SenseReferencePlacement>(
    (placement, reference) => {
      const destination = definitionReferenceKinds.has(reference.kind)
        ? placement.definition
        : placement.trailing;
      destination.push(reference);
      return placement;
    },
    { definition: [], trailing: [] },
  );
}
