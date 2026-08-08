import type { LearningPreferences } from "../../lib/storage/learning-data";

export type ReadingScale = LearningPreferences["fontScale"];

export const readingScaleOptions = [
  { value: "small", label: "小" },
  { value: "default", label: "标准" },
  { value: "large", label: "大" },
] as const satisfies readonly { value: ReadingScale; label: string }[];

export function readingScaleIndex(value: ReadingScale): number {
  const index = readingScaleOptions.findIndex((option) => option.value === value);
  return index < 0 ? 1 : index;
}

export function readingScaleFromIndex(index: number): ReadingScale {
  const boundedIndex = Math.max(0, Math.min(readingScaleOptions.length - 1, Math.round(index)));
  return readingScaleOptions[boundedIndex].value;
}
