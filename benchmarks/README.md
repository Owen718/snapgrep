# fast_grep benchmark contracts

This directory contains test data and query metadata only. It deliberately does
not import the pi extension or prescribe a test runner, so the same contract can
be consumed by an rg comparator, an HTTP sidecar test, or a pi end-to-end test.

## Layout

- `fixtures/core/` is a deterministic miniature repository. Run commands with
  this directory as the working directory so its `.gitignore` owns ignore
  semantics.
- `queries/core.json` contains the core query contract, expected locations,
  routing expectations, and create/modify/delete freshness scenarios.

The fixture has visible TypeScript and Go files, nested paths, a hidden file, an
ignored file, a path that is both hidden and ignored, a four-line match, context
matches at both file boundaries, and files that are safe to modify or delete in
a disposable copy. `fresh-created.ts` is intentionally absent.

Never mutate the checked-in fixture in place. A runner should copy it into a
temporary directory for freshness tests and discard that copy afterward.

## Query arguments and rg mapping

Values omitted from a query inherit `defaults` in `core.json`. The intended rg
mapping is:

| Contract argument | rg behavior |
| --- | --- |
| `pattern` | an argv value after `--`, never shell-interpolated |
| `path` | path operand relative to the fixture root |
| `glob` | `--glob <value>` |
| `caseInsensitive` | `--ignore-case` when true |
| `multiline` | `--multiline` when true |
| `hidden` | `--hidden` when true |
| `noIgnore` | `--no-ignore` when true |
| `beforeContext` | `--before-context <n>` |
| `afterContext` | `--after-context <n>` |
| `maxResults` | a global presentation cap, not rg's per-file `--max-count` |

The baseline should invoke rg as a child process with an argv array and include
`--no-config --json --color never`. Exit code 0 means at least one match, 1
means a valid query with no match, and 2 or greater is an error. Do not suppress
stderr when classifying an invalid regex. Default rg rejects lookbehind and
backreferences; this contract never changes those queries to PCRE2 implicitly.

`hidden` and `noIgnore` are independent. `hidden=true` does not disable ignore
rules, and `noIgnore=true` does not include hidden paths. Production repository
runners should always exclude VCS metadata and index artifacts such as
`.git/**` and `.pi/index/**` from every compared backend, even when
`noIgnore=true`.

## Match identity and comparison

Parse rg JSON rather than its human-readable output. The canonical identity of
one match is:

```text
(fixture-relative path, absolute UTF-8 start byte, absolute UTF-8 end byte)
```

For rg, add each submatch's byte offsets to its event's `absolute_offset`.
This identity distinguishes multiple matches on one line and continues to work
for multiline matches. `fast_grep` structured results should expose absolute
byte offsets directly or enough UTF-8 byte information to derive them. Line
ranges in `core.json` are human-readable assertions in addition to, not a
replacement for, byte identity.

Normalize paths to fixture-relative forward-slash form before comparing.
Ordering is not part of set correctness. For an untruncated query calculate:

```text
missing = rg_matches - fast_grep_matches
extra   = fast_grep_matches - rg_matches
```

`missing` must always be empty. Since the proposed fast path applies rg exact
verification after index candidate selection, the final result should normally
also have no `extra` entries; report extras even if recall is the only hard
gate.

Context lines are not matches. Parse and compare them separately, including
their path, line number, text, and match-versus-context role. The context query
asserts clipping at lines 1 and 10, merging of overlapping windows into lines
1-6, a genuine omitted line 7, and a second group at lines 8-10.

## Unlimited correctness versus capped performance

Correctness and presentation answer different questions and must be separate
runs:

1. **Correctness mode is unlimited.** Remove `maxResults`, exhaust pagination
   if the API is paginated, and compare the complete sets. A capped public API
   is not sufficient evidence of zero missed recall.
2. **Performance mode is capped.** Apply the same global result cap, context,
   filters, output serialization, and process boundary to Normal, Instant, and
   FFF. The core truncation query uses a cap of 2 over 4 matches and requires
   explicit `truncated=true` and `totalMatches=4` metadata.

Do not map a global cap to rg `--max-count`: that flag is per file. A comparator
must implement an equivalent global cap in its common adapter or consume a
common renderer after collecting results.

Queries marked `index_preferred` are expected to exercise the indexed route.
Queries marked `rg_fallback_required` are valid default-rg expressions but are
intentionally unsafe to translate to Zoekt; they must preserve result semantics
through fallback. Queries marked `reject` must return a structured regex error,
not an empty success.

## Read-your-writes contract

Run every mutation scenario through the same pi write/edit/delete lifecycle
hooks used in production. Assert once on the very next search and again after
the index reports an acknowledged generation with an empty dirty set.

The overlay merge required to pass modification and deletion is:

```text
(indexed results excluding every dirty or tombstoned path)
  union rg results from dirty paths that still exist
```

A plain union is incorrect: it leaves an old match after replacement and leaves
all indexed matches from a deleted file. Keep a deletion tombstone until the
index has explicitly acknowledged the new filesystem state; do not clear dirty
state on a timer.
