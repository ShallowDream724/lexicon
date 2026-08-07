import { z } from "zod";

export const ENHANCEMENT_SCHEMA_VERSION = "1.0" as const;

export const etymologyTextMarkSchema = z.enum(["foreign", "strong"]);

export const etymologyLinkSchema = z.object({
  targetTerm: z.string().min(1),
  targetArticleId: z.string().min(1).optional(),
});

export const etymologyTextRunSchema = z.object({
  text: z.string(),
  marks: z.array(etymologyTextMarkSchema),
  link: etymologyLinkSchema.optional(),
});

export const etymologyBlockSchema = z.object({
  kind: z.enum(["paragraph", "quote"]),
  runs: z.array(etymologyTextRunSchema).min(1),
});

export const etymologyDocumentSchema = z.object({
  blocks: z.array(etymologyBlockSchema).min(1),
});

export const etymologyArticleSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  preview: z.string(),
  previewRuns: z.array(etymologyTextRunSchema).min(1),
});

export const etymologyResourceSummarySchema = z.object({
  schemaVersion: z.literal(ENHANCEMENT_SCHEMA_VERSION),
  kind: z.literal("etymology"),
  resourceId: z.string().min(1),
  sourceVersion: z.string().min(1),
  term: z.string().min(1),
  headword: z.string().min(1),
  articles: z.array(etymologyArticleSummarySchema).min(1),
});

export const etymologyArticleSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  preview: z.string(),
  document: etymologyDocumentSchema,
});

export const etymologyArticleResponseSchema = z.object({
  schemaVersion: z.literal(ENHANCEMENT_SCHEMA_VERSION),
  kind: z.literal("etymology"),
  resourceId: z.string().min(1),
  sourceVersion: z.string().min(1),
  term: z.string().min(1),
  headword: z.string().min(1),
  article: etymologyArticleSchema,
});

export const enhancementResourceSummarySchema = z.discriminatedUnion("kind", [
  etymologyResourceSummarySchema,
]);

export const enhancementResourceSummariesSchema = z.array(
  enhancementResourceSummarySchema,
);

export type EtymologyTextMark = z.infer<typeof etymologyTextMarkSchema>;
export type EtymologyLink = z.infer<typeof etymologyLinkSchema>;
export type EtymologyTextRun = z.infer<typeof etymologyTextRunSchema>;
export type EtymologyBlock = z.infer<typeof etymologyBlockSchema>;
export type EtymologyDocument = z.infer<typeof etymologyDocumentSchema>;
export type EtymologyArticleSummary = z.infer<
  typeof etymologyArticleSummarySchema
>;
export type EtymologyResourceSummary = z.infer<
  typeof etymologyResourceSummarySchema
>;
export type EtymologyArticle = z.infer<typeof etymologyArticleSchema>;
export type EtymologyArticleResponse = z.infer<
  typeof etymologyArticleResponseSchema
>;
export type EnhancementResourceSummary = z.infer<
  typeof enhancementResourceSummarySchema
>;
