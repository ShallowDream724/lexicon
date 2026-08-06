import type {
  CanonicalGrammarUsageBox,
  CanonicalIllustration,
  CanonicalPhrase,
  CanonicalSense,
} from "../../../packages/dictionary-schema/src/index";
import { grammarUsageBoxLabels } from "./box-presentation";
import { type EntryPartProjection, partOfSpeechTabLabel } from "./entry-sections";

export type QuickFindSensePath = readonly (string | number)[];

export type QuickFindPart = {
  index: number;
  label: string;
  active: boolean;
};

export type QuickFindResource =
  | {
      kind: "illustration";
      label: string;
      illustration: CanonicalIllustration;
    }
  | {
      kind: "box";
      label: string;
      box: CanonicalGrammarUsageBox;
    };

export type QuickFindSenseGroup = {
  label: string;
  anchor: string;
  sense: CanonicalSense;
  path: QuickFindSensePath;
};

export type QuickFindPhrase = {
  label: string;
  anchor: string;
  phrase: CanonicalPhrase;
  index: number;
};

export type QuickFindSectionId =
  | "parts"
  | "resources"
  | "senses"
  | "idioms"
  | "phrasal-verbs";

export type QuickFindSection = {
  id: QuickFindSectionId;
  label: string;
};

export type QuickFindModel = {
  parts: QuickFindPart[];
  resources: QuickFindResource[];
  senseGroups: QuickFindSenseGroup[];
  idioms: QuickFindPhrase[];
  phrasalVerbs: QuickFindPhrase[];
  sections: QuickFindSection[];
};

function anchorPath(path: QuickFindSensePath): string {
  return path.map((segment) => String(segment).trim()).filter(Boolean).join("-");
}

export function senseQuickFindAnchor(sense: CanonicalSense, path: QuickFindSensePath): string {
  return sense.id ? `sense-${sense.id}` : `sense-${anchorPath(path)}`;
}

export function phraseQuickFindAnchor(
  collection: "idioms" | "phrasalVerbs",
  phrase: CanonicalPhrase,
  index: number,
): string {
  return phrase.id ? `phrase-${phrase.id}` : `phrase-${collection}-${index}`;
}

function textOr(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function collectSenseGroups(
  senses: CanonicalSense[],
  pathPrefix: QuickFindSensePath,
  seen: Set<string>,
  results: QuickFindSenseGroup[],
): void {
  senses.forEach((sense, index) => {
    const path = [...pathPrefix, index] as const;
    const label = sense.groupHeading?.text.trim();
    if (label && !seen.has(label)) {
      seen.add(label);
      results.push({
        label,
        anchor: senseQuickFindAnchor(sense, path),
        sense,
        path,
      });
    }
    collectSenseGroups(sense.subsenses, path, seen, results);
  });
}

function senseGroupsFor(projection: EntryPartProjection): QuickFindSenseGroup[] {
  const groups: QuickFindSenseGroup[] = [];
  const seen = new Set<string>();
  collectSenseGroups(projection.senses, ["root"], seen, groups);
  projection.subentries.forEach((subentry, subentryIndex) => {
    collectSenseGroups(subentry.senses, ["subentry", subentryIndex], seen, groups);
  });
  return groups;
}

function phraseItems(
  collection: "idioms" | "phrasalVerbs",
  phrases: CanonicalPhrase[],
): QuickFindPhrase[] {
  return phrases.map((phrase, index) => ({
    label: textOr(phrase.display.text, collection === "idioms" ? "习语" : "短语动词"),
    anchor: phraseQuickFindAnchor(collection, phrase, index),
    phrase,
    index,
  }));
}

function resourcesFor(projection: EntryPartProjection): QuickFindResource[] {
  return [
    ...projection.illustrations.map((illustration) => ({
      kind: "illustration" as const,
      label: "图解词汇",
      illustration,
    })),
    ...projection.grammarUsageBoxes.map((box) => ({
      kind: "box" as const,
      label: grammarUsageBoxLabels(box).primary,
      box,
    })),
  ];
}

export function projectQuickFind(projection: EntryPartProjection): QuickFindModel {
  const parts = projection.options.map((part, index) => ({
    index,
    label: partOfSpeechTabLabel(part.text),
    active: index === projection.activeIndex,
  }));
  const resources = resourcesFor(projection);
  const senseGroups = senseGroupsFor(projection);
  const idioms = phraseItems("idioms", projection.idioms);
  const phrasalVerbs = phraseItems("phrasalVerbs", projection.phrasalVerbs);
  const sections: QuickFindSection[] = [];

  if (parts.length) {
    sections.push({ id: "parts", label: "词性" });
  }
  if (resources.length) {
    sections.push({ id: "resources", label: "扩展内容" });
  }
  if (senseGroups.length) {
    sections.push({ id: "senses", label: "义项" });
  }
  if (idioms.length) {
    sections.push({ id: "idioms", label: "习语" });
  }
  if (phrasalVerbs.length) {
    sections.push({ id: "phrasal-verbs", label: "短语动词" });
  }

  return { parts, resources, senseGroups, idioms, phrasalVerbs, sections };
}
