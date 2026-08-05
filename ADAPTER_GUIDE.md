# Dictionary Adapter Guide

## Contract

An adapter converts one validated source envelope into `CanonicalEntry`:

```ts
interface DictionaryAdapter<TEnvelope> {
  readonly id: string;
  readonly sourceVersions: readonly string[];
  canHandle(input: unknown): input is TEnvelope;
  adapt(input: TEnvelope, context: AdapterContext): CanonicalEntry;
}
```

The registry selects an adapter by explicit dictionary configuration and verifies
that it accepts the source version. Content inspection is a fallback for imported
files, never the primary selection mechanism.

## Required Invariants

Every adapter must:

1. Validate its external envelope before reading fields.
2. Return a valid canonical entry at the current schema version.
3. Preserve the order of senses, examples, subentries, boxes, and references.
4. Preserve source ids, token metadata, media keys, nested structures, and unknown
   fields through canonical fields or `raw`.
5. Generate deterministic fallback ids only when the source omits an id.
6. Keep headword normalization separate from displayed spelling.
7. Represent missing data as absent optional fields or empty ordered collections;
   never invent definitions or translations.
8. Avoid storage URLs and UI markup in canonical objects.

## Adding A Source

Create a source package under `packages/adapters/src/<source-id>/` with:

```text
schema.ts       runtime envelope schema
adapter.ts      recursive conversion
normalizers.ts  source-specific text and id helpers
fixtures/       compact representative source fragments
adapter.test.ts contract assertions
index.ts        public exports
```

Register the adapter in the central registry and add a dictionary configuration
that supplies `dictionaryId`, `sourceVersion`, and media resolution rules.

## Fixture Coverage

Fixtures should be compact while exercising real structural cases:

- a normal bilingual entry with two regional pronunciations;
- multiple parts of speech and numbered senses;
- a root with no part of speech and nested subentries;
- subsenses, idioms, phrasal forms, and cross references;
- examples with translated text and regional audio keys;
- grammar or usage boxes with ordered blocks;
- illustrations attached below the root level;
- unknown fields that must survive in `raw`.

Golden snapshots may cover canonical shape, but tests should also assert semantic
invariants directly so intentional additive fields do not cause noisy rewrites.

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

