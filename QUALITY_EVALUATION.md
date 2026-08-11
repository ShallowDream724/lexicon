# Testing And Retrieval Quality

This document separates release verification from retrieval evaluation. Tests verify contracts
and runtime boundaries. Retrieval metrics describe a finite labelled set; they are not a user
success rate or a product-wide accuracy claim.

## Current Asset Baseline

| Asset | Contract |
| --- | --- |
| Primary dictionary | SHA-256 `f6ac9d3e20482112b24ca4142481e5b5ba78efbc9cbca85299e0ac4fc86e22d5` |
| Reverse-search sidecar | schema `9`, projection `2.2`, 102,408,192 bytes, SHA-256 `9677b91a2d2f4fc6dc825a989ea2e157a77f2e19646aeb1b3a60a8e2dcd39630` |
| Semantic-search sidecar | schema `5`, projection `2.2`, 259,973,120 bytes, SHA-256 `f76c97820fc44485696a19a2829bb6be4f0d298b9fc3524dabef5b26b2915033` |

The reverse sidecar contains 197,340 documents, 361,278 exact segments, 16,861 headword
forms, 55,975 headword terms, and 117,214 English terms. Its document scopes are `sense`
84,821, `phrase` 12,423, `form` 5, `example` 92,016, and `resource` 8,075. The semantic
sidecar contains 197,340 documents and 181,883 unique 1,024-dimensional vectors. Both
sidecars are fingerprint-bound to the primary database and to each other.

## Release Verification

Release checks cover TypeScript contracts, runtime asset fingerprints, Go API behavior,
semantic builder and evaluator behavior, rendered web output, PWA output, linting,
typechecking, and the production build. The asset checks reject mismatched sizes, hashes,
schemas, and cross-database fingerprints. API checks cover bounded queries, cache behavior,
provider timeout and degradation, and response contracts.

The filter contract is verified as four user-facing choices: 词义 (`sense` and `form`), 短语
(`phrase`), 例句 (`example`), and 扩展资料 (`resource`). The default is 词义 plus 短语.
Etymology is excluded from semantic search. English suggestion and submission paths are
lexical and do not request embeddings.

## Evaluation Design

Evaluation has three distinct roles.

| Layer | Reused for tuning | Role |
| --- | --- | --- |
| Model-selection and development sets | Yes | Compare embedding spaces and diagnose ranking changes |
| Historical holdouts, including Fresh-100 | No after execution | Preserve earlier point-in-time measurements |
| Quality v5 threshold holdout | No | Current release gate for a fixed labelled set |

The v5 holdout is constructed before product-result review. Queries are normalized for
comparison and checked against development and other reserved sets to prevent duplicate or
near-duplicate leakage. Each retrieval case is manually labelled with acceptable target
entries; gap cases are labelled separately. Labels include a scope and a locatable evidence
expectation where applicable. Dataset construction and review do not use product lexical or
hybrid output, then the set is frozen before its gate is evaluated.

This controls reuse of known examples, label leakage, and accidental scope substitution. It
does not make the set representative of every query population, every provider condition, or
individual user intent.

## Quality v5 Gate

The frozen v5 threshold holdout produced these results with the released embedding contract
and the `0.590489181` absolute-score threshold:

| Check | Result | Meaning |
| --- | ---: | --- |
| Retention | 90% | Required labelled retrieval cases remain retained by the gate definition |
| Gap rejection | 45% | Labelled corpus-gap cases do not produce a false positive under the gate definition |
| Single-anchor Hit@1 | 15% | A case with one required anchor is returned first |
| Single-anchor Hit@3 | 30% | A case with one required anchor appears in the first three results |
| MRR | 0.280 | Mean reciprocal rank for the labelled targets |

Retention and gap rejection measure separate conditions. Hit@1, Hit@3, and MRR measure rank
within the labelled set. They must not be combined into a single score or presented as product
accuracy, user satisfaction, or a probability that a result is correct.

## Historical Measurements

Fresh-100 and earlier model, development, and v3 measurements are historical projections.
They were generated under earlier data assets, projection contracts, ranking behavior, or
provider conditions. Fresh-100 is useful as a documented snapshot of that historical system,
but it is not a current schema 5 / projection 2.2 result and must not be cited as a current
2.2 score.

Historical metrics remain useful for regression investigation when their original asset and
methodology are named. They cannot establish the current system's quality after a projection,
ranking, scope, or provider-contract change.

## Metric Definitions And Limits

`Hit@k` is the proportion of labelled cases with an acceptable target in the first `k`
results. `MRR` is the mean of the reciprocal rank of the first acceptable labelled target.
Retention and gap rejection follow their v5 case classifications. Scope leakage and forbidden
result checks are safety and contract checks, not relevance scores.

Finite labels cannot enumerate every valid synonym, alternative explanation, or user goal.
Provider latency, availability, cache state, and network conditions also vary by deployment.
The runtime protects literal results at lexical tier `>= 3`; when the three-second external
provider budget cannot produce a valid vector, it returns lexical results. This fallback is a
service-continuity behavior, not evidence that semantic ranking succeeded.

## Reproduction

Use the repository's locked dependencies and the `aider` conda environment for Python-based
checks:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:contracts
npm run test:assets
npm run test:api
npm run semantic-search:test
npm run semantic-search:quality:validate
npm run build
npm run test:web
```

The offline quality validation command checks the current schema-5 sidecar, the 80 v5
development and holdout rows, target availability, and query disjointness without contacting
an embedding provider. Historical v3 and Fresh-100 validators require their original pinned
assets and are not current release gates.

Model and runtime configuration are described in [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md).
