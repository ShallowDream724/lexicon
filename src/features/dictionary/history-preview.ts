import type { HistoryRecord } from "../../lib/storage/learning-data";

export function historyPreviewRecords(
  history: HistoryRecord[],
  limit = 5,
): HistoryRecord[] {
  if (limit <= 0) {
    return [];
  }

  const byHeadword = new Map<string, HistoryRecord>();
  for (const record of history) {
    const normalizedHeadword = record.headword.trim().toLocaleLowerCase();
    if (!normalizedHeadword) {
      continue;
    }

    const existing = byHeadword.get(normalizedHeadword);
    if (existing) {
      existing.visitCount += record.visitCount;
      continue;
    }

    byHeadword.set(normalizedHeadword, { ...record });
  }

  return [...byHeadword.values()].slice(0, limit);
}
