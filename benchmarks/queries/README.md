# Production repository query corpus

`R1-linux.json`, `R2-vscode.json`, and `R3-kubernetes.json` are fixed query
corpora for the exact shallow-clone commits recorded in each file. Regenerate
them with:

```sh
npx tsx benchmarks/generate-queries.ts
```

Generation is intentionally read-only with respect to repository contents. It
checks each repository commit and asks the production query planner whether the
declared route is indexed or fallback, but it does not launch ripgrep content
scans. `benchmarks/run.ts` is the single owner of actual rg differential runs;
the JSON `expected.verification` fields therefore remain `null` until the run
artifact records observed results. This avoids duplicate full-tree scans of the
large Linux tree.

## Schema

Each file uses `fast-grep-benchmark-queries/v1` and contains:

- `repo`, `snapshot`, and human-readable language metadata;
- a `summary` with category, route, and performance-eligible counts;
- at least 64 `queries`.

Every query has:

- `id`, `category`, and `description`;
- `request`, using the exact `SearchRequest` field names from `src/types.ts`;
- `expectedRoute`: `index_preferred` or `fallback_required`;
- `performanceEligible`: whether the capped latency runner may include it;
- `expected.outcome`: `matches`, `no_matches`, or `invalid_regex`.

Correctness runs must ignore the request presentation `limit` and compare the
complete `(path, absoluteStart, absoluteEnd)` match set. Performance runs use
the request's cap and context symmetrically for normal and instant backends.
Queries with lookbehind and backreferences assert `invalid_regex`: the public
request contract has no PCRE2 switch, so default ripgrep rejects these forms.
