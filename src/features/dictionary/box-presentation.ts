import type {
  CanonicalBoxBlock,
  CanonicalCrossReference,
  CanonicalGrammarUsageBox,
  CanonicalText,
} from "../../../packages/dictionary-schema/src/index";

export type GrammarUsageBoxPresentation = {
  title?: CanonicalText;
  references: CanonicalCrossReference[];
  blocks: CanonicalBoxBlock[];
};

export type GrammarUsageBoxLabels = {
  primary: string;
  secondary: string;
};

function normalizedHeading(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function duplicatesReferences(
  block: CanonicalBoxBlock,
  references: CanonicalCrossReference[],
): boolean {
  if (block.kind !== "list" || block.items.length !== references.length || !references.length) {
    return false;
  }

  return block.items.every((item, index) => {
    if (item.segments.some((segment) => segment.kind !== "text")) {
      return false;
    }
    const itemText = item.segments
      .map((segment) => segment.kind === "text" ? segment.value.text : "")
      .join("");
    return normalizedHeading(itemText) === normalizedHeading(references[index]!.text);
  });
}

export function projectGrammarUsageBox(
  box: CanonicalGrammarUsageBox,
): GrammarUsageBoxPresentation {
  const title = box.title?.text.trim() ? box.title : undefined;
  const references = box.references ?? [];
  const blocks = box.blocks.filter((block) => !duplicatesReferences(block, references));
  const firstBlock = blocks[0];
  const duplicateFirstHeading = Boolean(
    title &&
    firstBlock?.kind === "heading" &&
    normalizedHeading(title.text) === normalizedHeading(firstBlock.value.text),
  );

  return {
    title,
    references,
    blocks: blocks.slice(duplicateFirstHeading ? 1 : 0),
  };
}

export function grammarUsageBoxLabels(
  box: CanonicalGrammarUsageBox,
): GrammarUsageBoxLabels {
  const type = box.type?.trim() || "LANGUAGE BANK";
  const localizedStart = type.search(/\p{Script=Han}/u);
  const secondary = localizedStart >= 0
    ? type.slice(0, localizedStart).trim()
    : type;
  const primary = localizedStart >= 0
    ? type.slice(localizedStart).trim()
    : box.title?.text.trim();
  return {
    primary: primary || "词典说明",
    secondary: secondary || "LANGUAGE BANK",
  };
}
