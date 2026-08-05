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
  schemaVersion: 1;
  dictionaryId: string;
  sourceVersion: string;
  id: string;
  headword: string;
  displayHeadword: RichText;
  searchKey: string;
  labels: Label[];
  pronunciations: Pronunciation[];
  partsOfSpeech: PartOfSpeech[];
  senses: Sense[];
  subentries: Subentry[];
  derivedForms: DerivedForm[];
  inflectedForms: InflectedForm[];
  crossReferences: CrossReference[];
  illustrations: Illustration[];
  boxes: DictionaryBox[];
  raw: unknown;
}
```

Supporting objects are recursive where the source is recursive. A sense can contain
subsenses, examples, cross references, illustrations, and boxes. A subentry can
contain the same semantic sections as a root entry.

## Rich Text

Dictionary text can carry emphasis, labels, references, superscripts, and source
tokens. Plain strings lose this information, so display text uses an ordered token
list:

```ts
type RichText = {
  plainText: string;
  tokens: RichTextToken[];
};
```

Token metadata remains source-neutral. Source-specific attributes that have no
canonical meaning stay attached to the corresponding object's `raw` value.

## Pronunciation And Media

A pronunciation records region, phonetic text, written form, and an optional media
reference. Media references are opaque keys resolved by the source client:

```ts
interface MediaReference {
  kind: "headword-audio" | "example-audio" | "illustration";
  key: string;
  mimeType?: string;
  sourceUrl?: string;
}
```

The renderer never constructs storage paths or remote URLs. This allows the same
entry to use a local archive, object storage, or a permitted remote provider.

## Senses And Examples

Sense order is semantically significant and always follows source order. Explicit
source numbering is preserved separately from array position.

```ts
interface Sense {
  id: string;
  sourceNumber?: string;
  labels: Label[];
  definition?: BilingualText;
  examples: Example[];
  subsenses: Sense[];
  crossReferences: CrossReference[];
  illustrations: Illustration[];
  boxes: DictionaryBox[];
  raw: unknown;
}
```

An example keeps its English text, translated text, labels, and regional audio as
one unit. Audio is not inferred from the example string.

## Boxes

Grammar, usage, vocabulary, culture, synonym, and comparison material share the
`DictionaryBox` container. The box keeps a stable kind, title, ordered blocks,
nested examples, and raw source payload. New box kinds are additive and render
through a neutral fallback until a dedicated presentation is added.

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

