export type AdaptiveLineClampMetrics = {
  availableBlockSize: number;
  blockEndInset: number;
  blockStartInset: number;
  lineHeight: number;
};

export function adaptiveLineCount({
  availableBlockSize,
  blockEndInset,
  blockStartInset,
  lineHeight,
}: AdaptiveLineClampMetrics): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return 0;
  }
  const usableBlockSize = Math.max(
    0,
    availableBlockSize - Math.max(0, blockStartInset) - Math.max(0, blockEndInset),
  );
  return Math.max(0, Math.floor((usableBlockSize + 0.5) / lineHeight));
}
