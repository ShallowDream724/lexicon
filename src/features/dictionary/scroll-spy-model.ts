export type ScrollSpySection = {
  id: string;
  top: number;
};

export type ScrollSpyMetrics = {
  anchor: number;
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
  bottomTolerance?: number;
};

export function activeSectionForScroll(
  sections: ScrollSpySection[],
  metrics: ScrollSpyMetrics,
  fallback = "definitions",
): string {
  const available = sections.filter((section) => Number.isFinite(section.top));
  if (!available.length) {
    return fallback;
  }

  const atDocumentEnd =
    metrics.scrollY + metrics.viewportHeight >=
    metrics.documentHeight - (metrics.bottomTolerance ?? 2);
  if (atDocumentEnd) {
    return available.at(-1)!.id;
  }

  let current = available[0]!.id;
  for (const section of available) {
    if (section.top <= metrics.anchor) {
      current = section.id;
    }
  }
  return current;
}
