# Contributing

## Change Boundaries

- Feature components consume `CanonicalEntry`; source-specific fields stay inside an
  adapter.
- The Go service owns read-only storage, bounded search, integrity checks, and media
  delivery.
- Browser learning data stays behind the IndexedDB repository interface.
- New source formats add an adapter, compact fixtures, and contract tests.
- Deployment code must keep dictionary and media assets outside container images and
  Git history.

## Verification

Run the focused checks while developing and the complete gate before a pull request:

```sh
npm ci
npm run lint
npm run typecheck
npm run test:contracts
npm run test:api
npm run build
npm run test:web
```

Adapter changes also require a complete source-corpus audit using the command in
`ADAPTER_GUIDE.md`. Tests should cover semantic behavior or a real regression; avoid
assertions that only mirror implementation details.

## Documentation

Update the closest contract or architecture document in the same change whenever an
API, canonical field, adapter rule, storage format, deployment variable, or responsive
interaction changes. Keep examples source-neutral and independently understandable.

## Content Safety

Do not commit source databases, generated runtime databases, audio, PDFs, application
packages, captured full entries, credentials, or machine-specific paths. The repository
ignore rules are a final guard, not a substitute for reviewing staged files.
