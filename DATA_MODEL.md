# Dictionary Data Model

## Identity

Every entry is addressed by the pair `(dictionaryId, id)`.

- `dictionaryId` identifies an installed dictionary source.
- `id` is the source's stable entry id and remains opaque to the UI.
- `sourceVersion` identifies the imported source revision.
- `schemaVersion` identifies the canonical contract revision.

Headwords are display and search values. They are not identifiers: several entries
may share one spelling, and a spelling may change between source releases.

## Canonical Entry

`CanonicalEntry` is the only entry model consumed by feature components. Its main
shape is:

```ts
interface CanonicalEntry {
  schemaVersion: "1.0";
  dictionaryId: string;
  sourceVersion: string;
  id: string;
  headword: string;
  displayHeadword: string;
  searchKey: string;
  labels: CanonicalLabel[];
  pronunciations: CanonicalPronunciation[];
  partsOfSpeech: CanonicalPartOfSpeech[];
  headwordPatterns?: CanonicalText[];
  senses: CanonicalSense[];
  subentries: CanonicalEntry[];
  idioms: CanonicalPhrase[];
  phrasalVerbs: CanonicalPhrase[];
  derivedForms: CanonicalForm[];
  inflectedForms: CanonicalForm[];
  crossReferences: CanonicalCrossReference[];
  illustrations: CanonicalIllustration[];
  grammarUsageBoxes: CanonicalGrammarUsageBox[];
  raw: JsonObject;
}
```

Supporting objects are recursive where the source is recursive. A sense can contain
subsenses, examples, cross references, illustrations, and boxes. A subentry can
contain the same semantic sections as a root entry.

## Reverse-Search Documents

Chinese lookup consumes a derived `SearchDocument` contract from
`packages/dictionary-search`; it does not inspect adapter-specific fields or persisted
entry JSON:

```ts
interface SearchDocument {
  dictionaryId: string;
  entryId: string;
  scope: "sense" | "phrase" | "form" | "example" | "resource";
  headword: string;
  headwordForms?: string[];
  englishText: string;
  candidateText?: string;
  definitionText?: string;
  chineseText: string;
  semanticRole: "definition" | "qualifier" | "guidance" | "expression" | "example" | "heading" | "context";
  resourceCategory?: string;
  location: {
    section: "definitions" | "idioms" | "phrasal-verbs" | "derived-forms" | "grammar-usage";
    part?: string;
    ownerId?: string;
    path: string[];
  };
  weight: number;
}
```

The projector recursively traverses canonical entries and emits a document only when the
visible projection contains Chinese text. It covers headword usage, senses and subsenses,
examples, phrase groups, forms, structured usage segments, and grammar or usage boxes.
Canonical object order becomes a stable path, while `ownerId` retains a source identity
when one exists. The browser builds its rendered-location index with the same traversal.

Language-tagged canonical tokens are projected without flattening their boundaries.
Simplified, traditional, and standard Chinese tags feed `chineseText`; English tags feed
`englishText`; unlabelled presentation tokens use script-aware fallback splitting. When a
rich paragraph or table cell has ordered segments, those segments are indexed and its
aggregate compatibility value is not emitted a second time. Repeated references to the same
box id retain the deepest canonical owner, while identical text under different owners is
preserved.

An adapter that maps a new source into existing canonical fields receives reverse-search
coverage without additional search code. A new canonical semantic type extends the
projector and rendered-anchor contract once for every source. Opaque `raw` fields remain
outside the index until they acquire a visible canonical meaning; this prevents transport
metadata and currently hidden content from producing results the UI cannot display.

Search documents are build artifacts. They are validated and imported into an immutable
sidecar, never attached to `CanonicalEntry` responses or retained in browser state.
The request-time scope filter selects any non-empty subset in canonical order
`sense,phrase,form,example,resource`. The interface presents four choices: 词义 maps to
`sense,form`, 短语 to `phrase`, 例句 to `example`, and 扩展资料 to `resource`. The default is
词义 plus 短语. Guidance and qualifiers inherit the scope of their canonical owner instead
of forming another user-facing content category.

## Semantic Search Projection

Semantic Chinese search consumes the same `SearchDocument` stream and introduces no
adapter-facing fields. The build boundary groups documents by exact visible `chineseText`,
embeds each unique text once, and stores a scope bit mask beside the vector. Every original
document remains attached to that text id so a semantic hit can recover its English evidence,
entry id, headword, weight, and canonical location without reconstructing paths.

The semantic sidecar is an immutable derived model with its own schema version. Its metadata
pins the exact primary and reverse-search database fingerprints, canonical source projection,
semantic projection, corpus fingerprint, model key, dimensions, normalization,
quantization, query template, and provider-specific document/query options. The runtime
accepts only a query embedder whose model key and dimensions match that contract.

The current projection embeds only visible Chinese text. English headwords remain grouping
and display metadata, while English spelling and typo lookup stay in their purpose-built
indexes. Other similarity products, including English concept search, example recommendation,
and study scheduling, require independent projections because their retrieval unit and
quality contract differ.

## Enhancement Resources

Optional sources that enrich an entry without redefining it use the independent
`packages/enhancement-schema` contract. They do not add source-specific fields to
`CanonicalEntry`. A summary is small enough to accompany an entry response and contains
stable resource identity, source version, display term, and ordered article summaries:

```ts
interface EtymologyResourceSummary {
  schemaVersion: "1.0";
  kind: "etymology";
  resourceId: string;
  sourceVersion: string;
  term: string;
  headword: string;
  articles: Array<{
    id: string;
    label: string;
    preview: string;
    previewRuns: EtymologyTextRun[];
  }>;
}
```

The bounded preview runs retain emphasis and internal-link identity without loading the
article payload. Complete articles are fetched by article id. Their documents contain
ordered paragraph or quotation blocks, and each block contains ordered text runs with
semantic `strong` or `foreign` marks and an optional internal dictionary link. Browsers
render those structures as React nodes; enhancement HTML never crosses the API boundary.

The resource discriminant is the extension point for future supplementary sources.
Each new kind adds one schema member, one importer/provider, and one resource-registry
definition. The primary dictionary remains the owner of senses, learning identity, and
entry navigation.

## Rich Text

Dictionary text can carry emphasis, labels, references, and source tokens. Plain
strings lose this information, so semantic text keeps both its projection and the
ordered source tokens:

```ts
interface CanonicalText {
  text: string;
  tokens: SourceToken[];
  raw: JsonValue;
}

interface SourceToken {
  tag?: string;
  value?: JsonValue;
  text: string;
  raw: JsonObject;
}
```

Token metadata remains source-neutral. Source-specific attributes that have no
canonical meaning stay attached to the corresponding object's `raw` value.

## Pronunciation And Media

A pronunciation records region, phonetic text, written form, and an optional opaque
`audioKey`. Examples keep ordered audio references, and illustrations keep an opaque
image key:

```ts
interface CanonicalAudioReference {
  key: string;
  region?: string;
  raw: JsonObject;
}
```

The renderer never constructs storage paths or provider URLs. The dictionary client
resolves headword audio, example audio, and illustrations through API media routes,
allowing a local archive and configured remote object stores to coexist.
Illustration captions are populated only from an explicit source caption field; opaque
resource keys are never presented as user-facing text.

When a source provides ordered alternatives for the same media value, adapters select
the first non-empty value in source priority order. Empty optional media values are
absent from canonical objects rather than retained as empty keys.

## Senses And Examples

Sense order is semantically significant and always follows source order. Explicit
source numbering is preserved separately from array position.

```ts
interface CanonicalSense {
  id?: string;
  order: number;
  partOfSpeech?: string;
  groupHeading?: CanonicalText;
  patterns?: CanonicalText[];
  labels: CanonicalLabel[];
  definition?: CanonicalText;
  translation?: CanonicalText;
  examples: CanonicalExample[];
  inlineUsage?: CanonicalText[];
  usage: CanonicalText[];
  usageSegments: CanonicalBoxSegment[];
  crossReferences: CanonicalCrossReference[];
  illustrations: CanonicalIllustration[];
  grammarUsageBoxes: CanonicalGrammarUsageBox[];
  subsenses: CanonicalSense[];
  raw: JsonObject;
}
```

`partOfSpeech` is the nearest unambiguous semantic owner, while `groupHeading`
preserves a guideword shared by adjacent senses. Renderers derive visible numbering
from the projected sense list instead of carrying source array indexes across a
part-of-speech switch.

`headwordPatterns` and sense-level `patterns` preserve constructions such as fixed
headword wording or complementation patterns. They render as dictionary content,
without qualifier parentheses, and remain distinct from register, region, subject,
grammar, and proficiency labels.

An example keeps an optional grammatical `pattern`, its display text, optional
translation, ordered regional audio, and raw source object as one unit. Audio is not
inferred from the example string, and a pattern remains a separate line from its
example sentence.

`inlineUsage` preserves ordered parenthetical or bilingual scope qualifiers that
precede a definition, such as `(of a person 人)`. These qualifiers share the
definition's lead line. A grammatical construction in `patterns` owns that lead line,
so the definition starts on the following line instead.

`definitionSegments` is the ordered rich projection of the English definition when it
contains an embedded pronunciation run. The adjacent term stays in the text segment,
while region, transcription, and audio remain a pronunciation segment at the same
position. `definition` remains the plain-text compatibility projection; renderers use
the segments when a structured run is present.

`usageSegments` retains the visual order of help and usage content when it includes
embedded examples: for example, text before an example, the translated and voiced
example, then later text. `usage` remains a plain-text projection for compatibility
and search. Renderers should use `usageSegments` when it is available. When a source
places usage before a group of sibling senses, the adapter attaches that shared flow to
the first sense only, preserving its source order without duplicating the content.

## Forms

`CanonicalForm` covers source-neutral `variant`, `inflection`, `word-family`, and
`derivative` records. A form always has display text and may carry a stable id,
introducer, presentation `relation`, part of speech, note, labels, pronunciations,
recursive senses, and attached variants. `presentation` orders introducers, semantic
labels, the target sentinel, and pronunciation sentinel around the form text while
`introducer` and `labels` remain convenient typed projections. A structured derivative
therefore keeps its regional spellings, pronunciations, examples, and media instead of
being flattened to a field name. Split spelling fragments are combined once by the
adapter and do not also appear as labels.

Renderers use `presentation` when it is present. This preserves both
`also less frequent anarchical` and `a/c especially in BrE` without reconstructing
order or punctuation from separate arrays. `separatorBefore` on a presentation label
records only a source-owned comma or semicolon; grouping parentheses and delimiters
between complete forms remain presentation structure.

Sense-scoped forms from an explicit `v-gs` group live in `CanonicalSense.variants`,
whether the source group includes visible parentheses or not; constructions stay in
`patterns`. This keeps `(also bide)` and a voiced sense spelling structurally distinct
from a construction such as `absolutely no…, absolutely nothing`.

Idioms and phrasal verbs use `CanonicalPhrase`, which keeps canonical display text,
primary-wording labels, ordered alternative forms, ordered recursive senses,
group-level `leadingUsage` and `trailingCrossReferences`, and raw source data. Group
usage attaches to the first phrase in its source group so it is displayed once in the
same position as the source. A variant retains its introducer, regional labels, and
`relation`: `alternative` for source wording marked as another form and `equivalent`
for unintroduced regional wording. Primary labels render before variants, and an
unintroduced regional equivalent keeps the source's parenthetical form instead of
inventing punctuation. Phrases remain separate from ordinary entry senses so navigation
and rendering do not duplicate phrase definitions.

## Cross References

Cross references retain both presentation and navigation information:

```ts
interface CanonicalCrossReference {
  id?: string;
  kind?: CanonicalCrossReferenceKind;
  label?: string;
  text: string;
  qualifier?: string;
  entryId?: string;
  targetId?: string;
  targetType?: string;
  raw: JsonValue;
}
```

`kind` supplies source-neutral presentation semantics. It is optional for additive
compatibility with existing canonical data; adapters should set it whenever a source
label can be classified. Renderers use `kind` for consistent treatment and use
`label` only as clean display wording. `entryId` is the resolved entry route when one
is available; `targetId` and `targetType` preserve a more specific unresolved source
target. A renderer may disable navigation when no entry route is known, but it must
still show the reference.

For ordered source alternatives that identify the same reference target, canonical
fields use the first non-empty source value. Empty optional ids remain undefined, so
they do not block a later usable entry or target id.

The current kinds are `synonym`, `antonym`, `compare`, `see-also`, `more-at`,
`note-at`, `topic-note`, `related`, `inflection`, `equivalent`, `punctuation`, and
`generic`. An unrecognized future label maps to `generic`; its normalized display
label and source `raw` data remain available.

Presentation derives placement from `kind`. A sense with a definition places
`synonym` and `antonym` references immediately after its bilingual definition.
Destination-oriented kinds such as `compare`, `see-also`, and `more-at` remain in the
sense's trailing reference block. When a sense has no definition, all references stay
trailing so none becomes detached from its structural context.

## Boxes

Grammar and usage material share `CanonicalGrammarUsageBox`. It keeps an optional
source id, type, canonical title, structured navigation `references`, structured
`blocks`, the original ordered JSON `body`, and the raw source object. Lists,
paragraphs, and table cells retain ordered text, term, cross-reference, and example
segments. Paragraphs and table cells also keep a plain-text `value` projection for
searching and compatibility; renderers use their ordered segments whenever present.
This structure preserves nested examples and media without teaching UI components a
source format. The original body remains available for future adapter improvements.
New box types are additive and render through a neutral fallback until a dedicated
presentation is added.

Navigation metadata is never projected into a title. When a source repeats the same
reference list in its body, the presentation projection removes only that exact
duplicate and keeps the structured, navigable references.

## Raw Preservation

`raw` is required at the entry root and recommended on every source-derived object.
It provides lossless access to:

- unknown future fields;
- original ids and media keys;
- token attributes not yet understood;
- nested objects that are not yet rendered;
- ordering and source-version diagnostics.

Raw data is read-only. Personal annotations reference canonical ids and never
mutate raw content.

## Runtime Validation

External HTTP envelopes and canonical entry results are validated at runtime. A
validation failure includes the adapter id, source version, entry id, and field
path, without logging the full entry body.

Validation happens once at the boundary. Internal components rely on TypeScript
types and do not repeat schema checks.

## Evolution Rules

- Add optional fields for additive source capabilities.
- Increment the schema major version when removing, renaming, or changing the
  meaning of a required field.
- Keep migration functions adjacent to canonical schemas.
- Keep fixtures for every supported source version.
- Do not reuse an id for a different semantic object inside one source version.
