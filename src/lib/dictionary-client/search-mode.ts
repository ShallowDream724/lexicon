export const dictionarySearchQueryLimit = 200;

export type DictionarySearchMode = "hybrid";

export function isHybridSearchEligible(query: string): boolean {
  const normalized = query.normalize("NFKC").trim();
  if (Array.from(normalized).length > dictionarySearchQueryLimit) {
    return false;
  }

  let hanCharacterCount = 0;
  for (const character of normalized) {
    if (/\p{Script=Han}/u.test(character)) {
      hanCharacterCount += 1;
      if (hanCharacterCount >= 2) {
        return true;
      }
    }
  }
  return false;
}
