# Dictionary schema

`CanonicalEntry` is the source-neutral contract consumed by presentation code.
It carries stable identity and version fields, ordered display content, recursive
subentries, media references, and the complete source payload under `raw`.

Each `CanonicalSense` may contain ordered `subsenses`. Its optional
`partOfSpeech` is a normalized textual reference emitted only when the source
provides an unambiguous POS context. Entry and sense patterns remain separate
from labels, while forms may retain part of speech, notes, pronunciations, and
recursive senses.

`CanonicalEntry.idioms` and `CanonicalEntry.phrasalVerbs` hold ordered
`CanonicalPhrase` values. A phrase has source-neutral display text and tokens,
its own ordered senses, and the complete phrase payload under `raw`.

Grammar and usage boxes keep navigable references separate from their titles and
display blocks. Runtime defaults preserve compatibility when these additive fields
are absent from older canonical payloads.

When extending the contract:

1. Add a source-neutral field and its runtime schema in `src/index.ts`.
2. Retain unrendered source fields in the nearest `raw` value.
3. Preserve source ordering and nesting; add adapter contract coverage before
   depending on a new field in the UI.
