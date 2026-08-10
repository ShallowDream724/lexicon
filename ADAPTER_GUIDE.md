# Dictionary Adapter Guide

## Contract

An adapter converts one validated source envelope into `CanonicalEntry`:

```ts
interface DictionaryAdapter<TSource> {
  readonly id: string;
  parse(input: unknown): CanonicalEntry;
  adapt(source: TSource): CanonicalEntry;
}
```

`parse` owns runtime validation of an unknown boundary value and delegates to
`adapt`. `adapt` converts an already typed source object. The registry selects an
adapter by explicit id; it never guesses from content.

## Required Invariants

Every adapter must:

1. Validate its external envelope before reading fields.
2. Return a valid canonical entry at the current schema version.
3. Preserve the order of senses, examples, forms, subentries, boxes, and references.
4. Preserve source ids, token metadata, media keys, nested structures, and unknown
   fields through canonical fields or `raw`.
5. Generate deterministic fallback ids only when the source omits an id.
6. Keep headword normalization separate from displayed spelling.
7. Represent missing data as absent optional fields or empty ordered collections;
   never invent definitions or translations.
8. Avoid storage URLs and UI markup in canonical objects.
9. Normalize cross-reference labels into `CanonicalCrossReferenceKind` without
   leaking source labels into feature-level presentation logic.
10. Route source fields through explicit semantic allowlists; unknown tokens remain
    in `raw` and never become visible labels by fallback.
11. Preserve structured examples and media wherever a source box can contain them,
   including lists, paragraphs, and table cells.
12. Preserve the order of text and embedded examples in sense-level usage content.
13. Put searchable bilingual content in its visible canonical owner rather than leaving
    the only usable text inside `raw`.

## Adding A Source

For a substantial source, create a directory under
`packages/adapters/src/<source-id>/` with:

```text
schema.ts       runtime envelope schema
adapter.ts      recursive conversion
normalizers.ts  source-specific text and id helpers
fixtures/       compact representative source fragments
adapter.test.ts contract assertions
index.ts        public exports
```

Register the adapter in the central registry and add a dictionary configuration
that supplies stable `dictionaryId` and source-version data in its validated
envelope. Media resolution belongs to the client/API configuration and must not be
embedded in canonical objects.

## Reverse-Search Coverage

Adapters do not implement Chinese search. The shared projector in
`packages/dictionary-search` recursively reads canonical headword usage, senses,
subsenses, examples, phrases, forms, usage segments, and grammar or usage boxes. A new
source mapped to those existing fields is included in the next reverse-search build
without source-specific search code. The semantic builder consumes that generated document
stream, so the same visible Chinese content also enters the next semantic sidecar rebuild
without adapter or UI changes.

Every projected record carries a canonical section, part of speech, owner id when
available, and stable object path. The renderer uses the same traversal to attach DOM
anchors. This lets a result switch to the correct part of speech, open a registered box,
and locate the matching content without inspecting the source adapter.

When the canonical schema gains a genuinely new visible semantic type, extend three
adjacent contracts together:

1. Add its source-neutral canonical field and adapter fixtures.
2. Add one projector traversal and location rule in `packages/dictionary-search`.
3. Attach the shared location attributes in its renderer and add a navigation contract
   test.

Do this once at the canonical boundary. Do not add per-source branches to the API,
search result component, or entry workspace. Content preserved only in `raw` stays
unsearchable until it has a renderable canonical projection.

## Adding An Enhancement Source

Use an enhancement provider when a dataset supplements the primary entry instead of
supplying a complete competing dictionary. This keeps one reading flow and avoids
parallel full-entry renderers.

1. Add a versioned resource schema to `packages/enhancement-schema`.
2. Build a one-way importer and project-owned sidecar or remote provider.
3. Return only bounded summaries with primary entry responses; fetch full content on
   demand through a resource-specific API route.
4. Add the resource kind to `EntryResource`, then register its order, size, quick-find
   label, and opening action in `src/features/dictionary/resource-model.ts`.
5. Add one focused card and one full-content renderer. Render structured data rather
   than source HTML.
6. Define search merging explicitly. Primary dictionary exact matches remain primary;
   enhancement-only exact matches may open a dedicated resource view.
7. Add corpus audits for source ordering, internal links, orphaned content, malformed
   markup, size limits, and silent field loss.

Multiple resources may enrich one entry. Components receive an ordered resource union
and never inspect source tables, provider names, or storage paths.

## Fixture Coverage

Fixtures should be compact while exercising real structural cases:

- a normal bilingual entry with two regional pronunciations;
- multiple parts of speech and numbered senses;
- a root with no part of speech and nested subentries;
- guideword groups, subsenses, idioms, phrasal forms, group-level usage, regional
  alternatives, and group-level references;
- examples with grammatical patterns, translated text, and regional audio keys;
- flattened sense usage that interleaves help text, an example, its audio, and later text;
- resolvable and unresolved `see also` or `more at` targets;
- grammar or usage boxes with structured headings, paragraphs, lists, tables, nested
  examples, and example audio;
- wordfinder boxes with structured, navigable references and duplicated-body removal;
- split inflections, word families, and derivatives with pronunciation and examples;
- entry-level and sense-level construction patterns;
- illustrations attached below the root level;
- unknown fields that must survive in `raw`.
- Chinese-bearing senses, phrases, examples, usage, forms, and boxes whose projected
  evidence points back to the correct canonical owner and path.

Golden snapshots may cover canonical shape, but tests should also assert semantic
invariants directly so intentional additive fields do not cause noisy rewrites.

## Semantic Field Routing

The bundled bilingual adapter recognizes visible qualifier tags `gram`, `geo`, `reg`,
`subj`, and `or`. Proficiency, frequency, academic-register, and exam metadata are
parsed separately from bracketed source codes. No other source tag becomes a label by
default.

| Source structure | Canonical destination |
| --- | --- |
| `v` in entry or sense text outside a parenthetical `v-gs` group | `headwordPatterns` or sense `patterns` |
| `cf` in sense text | sense `patterns` |
| `if`, `if-g`, `ptl` | one `inflection` form |
| explicit `v-gs` groups in entry, sense, phrase, or derivative text, whether wrapped or unwrapped | one ordered `variant` form per source group, attached to its semantic owner |
| `wfg` with `wfw`, `wfp`, `wfo` | `word-family` form text, part of speech, and note |
| structured `dr_gs` | `derivative` form with labels, pronunciations, senses, and nested regional or spelling variants |
| `idm_gs` / `pv_gs` `un` | first phrase's `leadingUsage` |
| `idm_text` / `pv_text` `v-gs` | phrase `variants`, including introducer, regional labels, and relation |
| sense `sng_text` `use` or `dis-g` spans | ordered sense `inlineUsage` before the definition |
| pronunciation runs embedded in sense `def_eng` | ordered `definitionSegments` beside the term they pronounce |
| sense `un` flat `x-g` / `x-g_end` span | ordered sense `usageSegments`, including example translation and audio |
| sense-group `un` before sibling `sn_g` records | first sibling's `usageSegments`, once in source order |
| box-title navigation objects | box `references` |
| box `p`, `ul` / `ol`, and `table` content | ordered box segments and plain-text projection |
| `eng`, `simp`, `use`, `sub`, `sup` | rich text, usage, or semantic inline markup |
| unrecognized fields | the nearest object's `raw` value |

Inflection extraction treats each source token field as one ordered form group.
Deduplication may remove a repeated group only when its ordered form text,
introducers, and pronunciation metadata are identical. Forms with the same spelling
inside one group remain distinct so region, transcription, and audio data cannot be
discarded.

Structural separators belong to their enclosing source group. A bare comma in `if-g`
separates adjacent inflection forms; a bare comma in `v-g` separates adjacent
parenthetical variants. The adapter consumes these delimiters while grouping forms,
but keeps the original token arrays in `raw`. A delimiter never becomes a canonical
label, a form introducer, or a renderable cross-reference.

`CanonicalForm.presentation` is the ordered semantic projection of introducers, labels,
the form target, and pronunciation. Convenience fields `introducer` and `labels`
remain available, but rendering uses this sequence so neither a prefix such as
`also less frequent` nor a suffix such as `especially in BrE` can cross the target. A
label's `separatorBefore` records a source-owned comma or semicolon. Renderers add
grouping parentheses and separators between complete forms exactly once.

Phrase variants marked by a source `also` or `or` token, including regional labels
whose wording contains `also`, use the `alternative` relation. A phrase variant with
regional or register labels and no alternative marker uses `equivalent`, which lets a
renderer distinguish it without inspecting source tokens. Render primary-phrase labels
before variants, and preserve unintroduced regional equivalents as parenthetical forms;
do not synthesize punctuation that is absent from the source.

Run the complete source audit after changing any mapping rule:

```bash
npm run dictionary:audit -- \
  --source outputs/oalecd10/source/ciku.db \
  --source-version bundled-v1
```

The audit enumerates source token tags and fails on unexpected canonical label or form
kinds, empty forms, invalid source JSON, adapter failures, missing media keys across
forms, definitions, usage, and boxes, structure loss across lists, paragraphs, and
table cells, and navigation metadata
concatenated into box titles. It also recursively compares normalized cross-reference
target text from every source `xrg` with canonical references across entries, senses,
phrases, boxes, and subentries, preserving duplicate occurrences. Repeated semantic
projections of the same source box are checked once using its source id and raw body,
while genuinely distinct boxes remain independent audit subjects. Sense-level inline
usage and display-qualifier text is compared as an ordered-group multiset so a source
qualifier cannot survive only in `raw` without failing the audit.

The audit also rejects canonical labels with residual source wrapping, leading
structural separators, or punctuation-only text; it permits ordinary abbreviation
periods and other punctuation accompanying semantic text. Inflection and variant
introducers may not retain structural separators, and the internal `punctuation`
cross-reference kind may not reach the canonical rendering model. For balanced
parenthetical `v-gs` groups, including derivative `top_g.top_text`, source and
canonical variant targets are compared as normalized multisets in both directions.
The audit separately compares ordered presentation signatures, including introducers,
label kinds, targets, pronunciations, and source-owned separators. The source side is
limited to entry `top_data.top_text`, entry `top_data.v-gs`, derivative
`top_g.top_text`, sense `sng_text`, and phrase `idm_text` / `pv_text`, which are the
adapter's explicit variant inputs. This checks high-confidence bracketed form targets
without inferring variants from arbitrary free text or altering the preserved `raw`
payload.

## Cross-Reference Normalization

Cross-reference labels are normalized by removing a leading arrow marker, trimming,
and collapsing internal whitespace. The cleaned wording remains in `label`; the
source object remains in `raw`. The bundled bilingual adapter currently classifies
the following source labels:

| Source label | Canonical kind |
| --- | --- |
| `[SYN]` | `synonym` |
| `[OPP]` | `antonym` |
| `see also` | `see-also` |
| `compare` | `compare` |
| `more at` | `more-at` |
| `note at` | `note-at` |
| `WORDFINDER NOTE at`, `SYNONYMS at`, `LANGUAGE BANK at`, `WORD FAMILY at`, `HOMOPHONES at`, `EXPRESS YOURSELF at` | `topic-note` |
| `[IDM] see`, `related noun` | `related` |
| `past tense, past participle of`, `past tense of`, `pl. of`, `past part. of`, `third person of`, `pres. part. of`, `(comparative of`, `singular of` | `inflection` |
| `=` | `equivalent` |
| `,` | structural separator resolved during adaptation; absent from canonical output |
| an arrow with no label | `generic` |

Unknown future labels also map to `generic`. They are valid canonical data and must
not cause parsing failures; preserve their display wording and source data for later
classification.

For source fields that provide ordered alternatives for the same semantic value, skip
empty strings and retain the first non-empty candidate. This applies to media keys,
illustration keys, cross-reference target text and navigation ids, and subentry ids
before deterministic fallback generation.

## Rich Text Conversion

Parse structured source tokens with source-aware token mappers. Do not strip markup
with regular expressions when the source provides structured JSON. If a source
contains HTML, parse it with an HTML parser and map an allowlisted semantic subset
to rich-text tokens.

The adapter must retain a plain-text projection for searching, accessibility, and
copying. The projection follows visual token order and excludes purely decorative
markers.

## Compatibility Review

When a source revision arrives:

1. Run existing fixtures against the new adapter code.
2. Sample normal, very large, nested, boxed, and illustrated entries.
3. Compare discovered field paths with the previous revision.
4. Add fixtures for new structures before mapping them.
5. Increment `sourceVersion`; increment canonical `schemaVersion` only for a
   breaking domain change.

An unsupported structure should remain available in `raw` and emit one bounded
diagnostic. It must not silently reorder or discard adjacent known content.
