import type {
  CanonicalEntry,
  CanonicalForm,
  CanonicalGrammarUsageBox,
  CanonicalIllustration,
  CanonicalLabel,
  CanonicalPartOfSpeech,
  CanonicalPhrase,
  CanonicalSense,
} from "../../../packages/dictionary-schema/src/index";

export type PhraseCollection = "idioms" | "phrasalVerbs";

export type EntryNavigationItem = {
  id: "definitions" | "idioms" | "phrasal-verbs" | "derived-forms";
  label: string;
};

export type EntryPartProjection = {
  options: CanonicalPartOfSpeech[];
  activeIndex: number;
  selectedPart?: string;
  selectedOption?: CanonicalPartOfSpeech;
  headerLabels: CanonicalLabel[];
  senses: CanonicalSense[];
  subentries: CanonicalEntry[];
  idioms: CanonicalPhrase[];
  phrasalVerbs: CanonicalPhrase[];
  derivedForms: CanonicalForm[];
  inflectedForms: CanonicalForm[];
  variants: CanonicalForm[];
  illustrations: CanonicalIllustration[];
  grammarUsageBoxes: CanonicalGrammarUsageBox[];
  navigation: EntryNavigationItem[];
};

const partOfSpeechAbbreviations: Readonly<Record<string, string>> = {
  adjective: "adj.",
  adverb: "adv.",
  conjunction: "conj.",
  noun: "n.",
  preposition: "prep.",
  pronoun: "pron.",
  "phrasal verb": "phr. v.",
  verb: "v.",
};

function normalizedPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function partOfSpeechTabLabel(value: string): string {
  const normalized = normalizedPart(value);
  return partOfSpeechAbbreviations[normalized] ?? value.trim();
}

function senseParts(senses: CanonicalSense[]): string[] {
  return senses.flatMap((sense) => [
    ...(sense.partOfSpeech ? [normalizedPart(sense.partOfSpeech)] : []),
    ...senseParts(sense.subsenses),
  ]);
}

function entryOwnParts(entry: CanonicalEntry): string[] {
  return entry.partsOfSpeech.map((part) => normalizedPart(part.text)).filter(Boolean);
}

function subtreeMatchesPart(entry: CanonicalEntry, part: string): boolean {
  const ownParts = entryOwnParts(entry);
  if (ownParts.length) {
    return ownParts.includes(part);
  }
  if (senseParts(entry.senses).includes(part)) {
    return true;
  }
  return entry.subentries.some((subentry) => subtreeMatchesPart(subentry, part));
}

function visibleSensesForEntry(
  entry: CanonicalEntry,
  selectedPart: string | undefined,
  includeUnscoped: boolean,
): CanonicalSense[] {
  if (!selectedPart) {
    return entry.senses;
  }

  const ownParts = entryOwnParts(entry);
  if (ownParts.length) {
    return ownParts.includes(selectedPart) ? entry.senses : [];
  }

  const associatedParts = senseParts(entry.senses);
  if (!associatedParts.length) {
    return includeUnscoped ? entry.senses : [];
  }

  return entry.senses.filter((sense) => {
    const sensePart = sense.partOfSpeech
      ? normalizedPart(sense.partOfSpeech)
      : undefined;
    return sensePart === selectedPart || (includeUnscoped && !sensePart);
  });
}

function phraseMatchesPart(phrase: CanonicalPhrase, selectedPart: string): boolean {
  const parts = senseParts(phrase.senses);
  return !parts.length || parts.includes(selectedPart);
}

export function collectEntryPhrases(
  entry: CanonicalEntry,
  collection: PhraseCollection,
  partOfSpeech?: string,
): CanonicalPhrase[] {
  const selectedPart = partOfSpeech ? normalizedPart(partOfSpeech) : undefined;
  const ownParts = entryOwnParts(entry);
  const includeOwn =
    !selectedPart || !ownParts.length || ownParts.includes(selectedPart);
  const ownPhrases = includeOwn
    ? entry[collection].filter(
        (phrase) => !selectedPart || phraseMatchesPart(phrase, selectedPart),
      )
    : [];
  const nestedPhrases = entry.subentries.flatMap((subentry) =>
    selectedPart && !subtreeMatchesPart(subentry, selectedPart)
      ? []
      : collectEntryPhrases(subentry, collection, selectedPart),
  );

  return [...ownPhrases, ...nestedPhrases];
}

export function entryPartOptions(entry: CanonicalEntry): CanonicalPartOfSpeech[] {
  const candidates = entry.partsOfSpeech.length
    ? entry.partsOfSpeech
    : entry.subentries.flatMap(entryPartOptions);
  const seen = new Set<string>();

  return candidates.filter((part) => {
    const key = normalizedPart(part.text);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (!key || !seen.has(key)) {
      if (key) {
        seen.add(key);
      }
      return true;
    }
    return false;
  });
}

function collectScopedForms(
  entry: CanonicalEntry,
  field: "derivedForms" | "inflectedForms" | "variants",
  selectedPart?: string,
): CanonicalForm[] {
  const ownParts = entryOwnParts(entry);
  const own =
    !selectedPart || !ownParts.length || ownParts.includes(selectedPart)
      ? entry[field] ?? []
      : [];
  return [
    ...own,
    ...entry.subentries.flatMap((subentry) =>
      selectedPart && !subtreeMatchesPart(subentry, selectedPart)
        ? []
        : collectScopedForms(subentry, field, selectedPart),
    ),
  ];
}

const headerLabelKinds = new Set(["frequency", "level", "academic-register", "exam"]);

function collectHeaderLabels(
  entry: CanonicalEntry,
  selectedPart?: string,
): CanonicalLabel[] {
  const ownParts = entryOwnParts(entry);
  const own =
    !selectedPart || !ownParts.length || ownParts.includes(selectedPart)
      ? entry.labels.filter((label) => headerLabelKinds.has(label.kind ?? ""))
      : [];
  return [
    ...own,
    ...entry.subentries.flatMap((subentry) =>
      selectedPart && !subtreeMatchesPart(subentry, selectedPart)
        ? []
        : collectHeaderLabels(subentry, selectedPart),
    ),
  ];
}

function dedupeLabels(labels: CanonicalLabel[]): CanonicalLabel[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = `${label.kind ?? ""}\u0000${label.text.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function projectHeaderLabels(
  entry: CanonicalEntry,
  selectedPart?: string,
): CanonicalLabel[] {
  const root = entry.labels.filter((label) => headerLabelKinds.has(label.kind ?? ""));
  const scoped = entry.subentries.flatMap((subentry) =>
    selectedPart && !subtreeMatchesPart(subentry, selectedPart)
      ? []
      : collectHeaderLabels(subentry, selectedPart),
  );
  const preferred = (kind: string): CanonicalLabel[] => {
    const scopedKind = scoped.filter((label) => label.kind === kind);
    return scopedKind.length
      ? scopedKind
      : root.filter((label) => label.kind === kind);
  };

  return dedupeLabels([
    ...preferred("frequency"),
    ...preferred("level"),
    ...preferred("academic-register"),
    ...root.filter((label) => label.kind === "exam"),
    ...scoped.filter((label) => label.kind === "exam"),
  ]);
}

function collectSenseResources(senses: CanonicalSense[]): {
  illustrations: CanonicalIllustration[];
  boxes: CanonicalGrammarUsageBox[];
} {
  return senses.reduce(
    (result, sense) => {
      const nested = collectSenseResources(sense.subsenses);
      result.illustrations.push(...sense.illustrations, ...nested.illustrations);
      result.boxes.push(...sense.grammarUsageBoxes, ...nested.boxes);
      return result;
    },
    {
      illustrations: [] as CanonicalIllustration[],
      boxes: [] as CanonicalGrammarUsageBox[],
    },
  );
}

function collectScopedResources(
  entry: CanonicalEntry,
  selectedPart: string | undefined,
  includeUnscoped: boolean,
): {
  illustrations: CanonicalIllustration[];
  boxes: CanonicalGrammarUsageBox[];
} {
  const senses = visibleSensesForEntry(entry, selectedPart, includeUnscoped);
  const senseResources = collectSenseResources(senses);
  const nestedResources = entry.subentries.reduce(
    (result, subentry) => {
      if (selectedPart && !subtreeMatchesPart(subentry, selectedPart)) {
        return result;
      }
      const nested = collectScopedResources(subentry, selectedPart, false);
      result.illustrations.push(...nested.illustrations);
      result.boxes.push(...nested.boxes);
      return result;
    },
    {
      illustrations: [] as CanonicalIllustration[],
      boxes: [] as CanonicalGrammarUsageBox[],
    },
  );

  return {
    illustrations: [
      ...entry.illustrations,
      ...senseResources.illustrations,
      ...nestedResources.illustrations,
    ],
    boxes: [
      ...entry.grammarUsageBoxes,
      ...senseResources.boxes,
      ...nestedResources.boxes,
    ],
  };
}

function navigationFor(
  idioms: CanonicalPhrase[],
  phrasalVerbs: CanonicalPhrase[],
  derivedForms: CanonicalForm[],
): EntryNavigationItem[] {
  const items: EntryNavigationItem[] = [{ id: "definitions", label: "释义" }];
  if (idioms.length) {
    items.push({ id: "idioms", label: "习语" });
  }
  if (phrasalVerbs.length) {
    items.push({ id: "phrasal-verbs", label: "短语动词" });
  }
  if (derivedForms.length) {
    items.push({ id: "derived-forms", label: "派生词" });
  }
  return items;
}

export function projectEntryPart(
  entry: CanonicalEntry,
  requestedPartIndex: number,
): EntryPartProjection {
  const options = entryPartOptions(entry);
  const activeIndex = Math.min(Math.max(requestedPartIndex, 0), Math.max(options.length - 1, 0));
  const selectedOption = options[activeIndex];
  const selectedPart = selectedOption ? normalizedPart(selectedOption.text) : undefined;
  const senses = visibleSensesForEntry(entry, selectedPart, activeIndex === 0);
  const subentries = entry.subentries.filter(
    (subentry) => !selectedPart || subtreeMatchesPart(subentry, selectedPart),
  );
  const idioms = collectEntryPhrases(entry, "idioms", selectedPart);
  const phrasalVerbs = collectEntryPhrases(entry, "phrasalVerbs", selectedPart);
  const derivedForms = collectScopedForms(entry, "derivedForms", selectedPart);
  const inflectedForms = collectScopedForms(entry, "inflectedForms", selectedPart);
  const variants = collectScopedForms(entry, "variants", selectedPart);
  const resources = collectScopedResources(entry, selectedPart, activeIndex === 0);
  const illustrations = dedupeBy(
    resources.illustrations,
    (illustration) => illustration.key ?? illustration.text,
  );
  const grammarUsageBoxes = dedupeBy(
    resources.boxes,
    (box) => box.id ?? `${box.type ?? ""}:${box.title?.text ?? ""}`,
  );

  return {
    options,
    activeIndex,
    selectedPart,
    selectedOption,
    headerLabels: projectHeaderLabels(entry, selectedPart),
    senses,
    subentries,
    idioms,
    phrasalVerbs,
    derivedForms,
    inflectedForms,
    variants,
    illustrations,
    grammarUsageBoxes,
    navigation: navigationFor(idioms, phrasalVerbs, derivedForms),
  };
}

export function buildEntryNavigation(
  entry: CanonicalEntry,
  partIndex = 0,
): EntryNavigationItem[] {
  return projectEntryPart(entry, partIndex).navigation;
}
