import type {
  CanonicalEntry,
  CanonicalForm,
  CanonicalSense,
} from "../../dictionary-schema/src/index";

export const SEARCH_DOCUMENT_MAX_HEADWORD_FORMS = 64;
export const SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES = 256;

const utf8Encoder = new TextEncoder();
const lexicalSurfaceTokenPattern = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?(?:[-‐‑–—][\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?)*$/u;

export function normalizeHeadwordForm(value: string): string {
  return value.normalize("NFKC").replace(/\p{White_Space}+/gu, " ").replace(/^ | $/gu, "");
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCompatibleHeadwordSurface(value: string, headword: string): boolean {
  const valueTokens = normalizeHeadwordForm(value).split(" ");
  const headwordTokens = normalizeHeadwordForm(headword).split(" ");
  return valueTokens.length === headwordTokens.length
    && valueTokens.every((token) => lexicalSurfaceTokenPattern.test(token));
}

/** Collects declared entry-level forms while excluding constructions and derivatives. */
export function projectCanonicalEntryHeadwordForms(entry: CanonicalEntry): string[] {
  const forms: string[] = [];
  const seen = new Set<string>();
  const visitedEntries = new WeakSet<CanonicalEntry>();
  const visitedSenses = new WeakSet<CanonicalSense>();
  const visitedForms = new WeakSet<CanonicalForm>();
  const rootHeadword = normalizeHeadwordForm(entry.headword);

  const add = (value: string): boolean => {
    if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS) return false;
    const normalized = normalizeHeadwordForm(value);
    if (
      !normalized ||
      !isWellFormedUnicode(normalized) ||
      !isCompatibleHeadwordSurface(normalized, rootHeadword) ||
      utf8Encoder.encode(normalized).byteLength > SEARCH_DOCUMENT_MAX_HEADWORD_FORM_BYTES
    ) {
      return false;
    }
    const key = normalized.toLowerCase();
    if (key === rootHeadword.toLowerCase()) return false;
    if (!seen.has(key)) {
      seen.add(key);
      forms.push(normalized);
    }
    return true;
  };

  const visitInflectedForm = (form: CanonicalForm): boolean => {
    if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS || visitedForms.has(form)) return false;
    visitedForms.add(form);
    let hasInflection = form.kind === "inflection" && add(form.text);
    for (const variant of form.variants ?? []) add(variant.text);
    for (const inflectedForm of form.inflectedForms ?? []) {
      hasInflection = visitInflectedForm(inflectedForm) || hasInflection;
    }
    return hasInflection;
  };

  const visitSense = (sense: CanonicalSense): void => {
    if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS || visitedSenses.has(sense)) return;
    visitedSenses.add(sense);
    for (const inflectedForm of sense.inflectedForms ?? []) visitInflectedForm(inflectedForm);
    for (const subsense of sense.subsenses) visitSense(subsense);
  };

  const visitEntry = (current: CanonicalEntry): void => {
    if (forms.length >= SEARCH_DOCUMENT_MAX_HEADWORD_FORMS || visitedEntries.has(current)) return;
    visitedEntries.add(current);
    if (normalizeHeadwordForm(current.headword).toLowerCase() !== rootHeadword.toLowerCase()) return;
    for (const inflectedForm of current.inflectedForms) visitInflectedForm(inflectedForm);
    for (const sense of current.senses) visitSense(sense);
    for (const variant of current.variants ?? []) add(variant.text);
    for (const subentry of current.subentries) visitEntry(subentry);
  };

  visitEntry(entry);
  return forms;
}
