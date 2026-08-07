# Enhancement Schema

This package defines versioned, source-neutral contracts for optional content that
enriches a primary dictionary entry without becoming part of `CanonicalEntry`.

The current `etymology` resource separates a lightweight term summary from complete
articles. Summaries can travel with entry responses and power cards or quick find.
Articles load by stable id and contain ordered semantic blocks and text runs. Source
HTML is parsed during import and never reaches the browser.

Add a resource kind only when it has its own lifecycle, storage, and presentation while
remaining subordinate to the primary entry. A new kind requires:

- a discriminated Zod summary and full-content response;
- stable resource and content ids plus a source version;
- bounded previews and explicit structured links;
- a provider/API implementation and corpus audit;
- a registration in `src/features/dictionary/resource-model.ts`;
- focused contract, routing, and renderer coverage.

Breaking field changes increment the schema major version. Additive optional fields
retain the current major version. Providers must preserve source order and must not
invent primary dictionary senses, translations, or personal-learning identity.
