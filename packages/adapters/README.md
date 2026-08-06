# Dictionary adapters

Adapters translate external dictionary payloads into `CanonicalEntry` and
validate their input before conversion. Register an adapter by a stable ID;
callers then depend on the registry and the canonical contract only.

To add a source:

1. Define an input schema at the adapter boundary.
2. Implement `DictionaryAdapter<TSource>` without adding source fields to the
   canonical package.
3. Keep original fields in `raw`, preserve ordering and subentry boundaries,
   and add compact fixtures to the contract tests.
4. Map labels through an explicit semantic allowlist and route forms, patterns,
   rich text, and navigation metadata to dedicated canonical fields.
5. Run the source-wide adapter audit before accepting a mapping change.
