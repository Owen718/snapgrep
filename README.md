<h1 align="center">snapgrep</h1>

<p align="center">
  An in-process trigram index that makes code search in <a href="https://github.com/earendil-works/pi">Pi</a><br>
  <b>Typically 40–70× faster than ripgrep</b> on a warm index —<br>
  and every result is checked against ripgrep, byte for byte.
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Terminal demo: ripgrep takes 147.7 ms to search a 17 MB repository while snapgrep takes 2.1 ms, drawn to true scale" width="820">
</p>

<p align="center">
  No sidecar process. No daemon. A single 3.2 MB native addon loaded inside the agent process.
</p>

## Install

### Pi

```sh
npm install -g snapgrep
```

Pi's built-in `grep` is replaced automatically, in every project. To confirm, ask Pi to search for a string you know exists — the tool detail shows `actualBackend: kernel`.

### oh-my-pi (omp)

```sh
npm install -g snapgrep
```

Same package, no changes: omp treats `@earendil-works/pi-coding-agent` as an aliased scope and its loader accepts `.pi` directories alongside `.omp`.

### DeepSeek Harness (dsh)

```sh
dsh plugin --profile headless add snapgrep
```

Verify with `dsh --profile headless --dump-config | grep snapgrep`.

It replaces both `grep` and `glob`: the registry rejects a duplicate tool name outright, so the built-in search row is disabled and this plugin supplies both. `glob` runs the same ripgrep invocation the built-in used.

---

Only the addon your machine can run is downloaded — about 1.2 MB, two packages. Nothing is compiled and no daemon is started.

Prebuilt for macOS (Apple Silicon and Intel), Linux (x64 and arm64, glibc), and Windows x64. Alpine/musl is not built yet; on an unsupported platform the extension names the exact file it could not find rather than failing silently.

<details>
<summary><b>Other ways to install</b> — no npm, single project, or one copy for every machine</summary>

Without npm, a script fetches the matching archive from the [latest release](https://github.com/Owen718/snapgrep/releases/latest) and installs into `~/.pi/agent/extensions`:

```sh
curl -fsSL https://raw.githubusercontent.com/Owen718/snapgrep/main/install.sh | sh
```

Set `PI_EXTENSIONS_DIR` to install elsewhere. For a directory that works on any machine, `snapgrep-extension-all-platforms.tar.gz` from the same release carries all five addons and picks the right one at load time.

Into a single project rather than globally:

```sh
git clone https://github.com/Owen718/snapgrep.git

mkdir -p /path/to/your-project/.pi/extensions
cp -R snapgrep/artifacts/pi-extension/pi-fast-grep /path/to/your-project/.pi/extensions/

cd /path/to/your-project
pi --approve
```

`--approve` is only needed the first time, to trust a project-level extension. The artifact carries a `.gitignore` scoped to its own directory, so installing it will not make your repository dirty.

Building from source: `npm run build:kernel && npm run package:extension`.

</details>

中文安装说明见 [安装说明.md](artifacts/pi-extension/pi-fast-grep/安装说明.md)。

## Why this exists

Coding agents search constantly. Every `grep` call in a large repository means ripgrep reads every byte on disk again — hundreds of milliseconds, several times a minute, forever.

Index-backed search fixes that, but the usual answer is a sidecar daemon (Zoekt, and everything built on it): another process to launch, supervise, keep in sync, and debug when it drifts. For a CLI agent that starts and stops constantly, that is a lot of machinery.

snapgrep puts the whole index in the agent's own process. Rust builds and queries a trigram index over a git snapshot; Node calls it through N-API. Startup to first query is about half a second, and the index is smaller than the code it indexes.

## Measured results

All numbers are P50 over 7 measured iterations after 3 warmups, kernel and ripgrep alternating within the same run, on the same repository snapshot with identical query parameters and output limits.

### Against ripgrep

| Query | snapgrep | ripgrep | Speedup |
| --- | ---: | ---: | ---: |
| Rare token, 1 match in 4,000 files | 0.120 ms | 230.8 ms | **1921×** |
| Escaped regex, 1,200 matching files | 3.188 ms | 220.2 ms | **69×** |
| `createServer` in a 17 MB repo | 2.065 ms | 147.7 ms | **72×** |
| `defineConfig`, 186 candidate files | 2.574 ms | 142.9 ms | **56×** |
| `import\.meta`, 538 candidate files | 4.179 ms | 156.5 ms | **37×** |
| Path-filtered search | 0.973 ms | 8.0 ms | **8×** |

### Where the speedup goes away

Speedup comes from *not reading files*, so it tracks how many files ripgrep would otherwise have to open. Push that number to its limit and the advantage disappears. From an independent run on Linux, single core, a 20 MB / 5,001-file repository:

| Scenario | snapgrep | ripgrep | Speedup |
| --- | ---: | ---: | ---: |
| Every file matches (5,001 files) | 6.98 ms | 18.5 ms | **2.6×** |
| 300 files match | 0.22 ms | 14.1 ms | 63.5× |
| One file matches (rare token) | 0.006 ms | 14.2 ms | 2458× |

**When every file matches, the index has nothing to skip, and 2.6× is all it can win.** That is the number to plan around for a query like `function` in a JavaScript repository. The four-digit figures are the other extreme: ripgrep must scan the whole tree to prove a token appears once, while the index answers from a posting list.

Most real agent searches sit in the middle — a symbol name in a few dozen to a few hundred files.

### Against Zoekt

Zoekt is the reference index-backed engine. Every query that snapgrep serves from its index is at least twice as fast, measured against Zoekt in the same run:

| Query | snapgrep | Zoekt | Ratio |
| --- | ---: | ---: | ---: |
| Glob filter `*.yaml`, 800 files | 1.533 ms | 70.4 ms | 0.022 |
| Case-insensitive, 500 files | 3.003 ms | 51.8 ms | 0.058 |
| Glob filter `*.ts` | 3.053 ms | 14.8 ms | 0.206 |
| Case-insensitive `defineConfig` | 4.806 ms | 13.8 ms | 0.347 |

Zoekt's per-query cost is dominated by HTTP transport, JSON decoding, and re-verification across a process boundary. Removing the process boundary removes all three.

### Footprint

| | Synthetic 17.0 MB corpus | Real 17.4 MB repository |
| --- | ---: | ---: |
| Index size | 6.5 MB (0.38× source) | 15.9 MB (0.91× source) |
| Cold start to first query | 662 ms | 508 ms |
| Resident processes | 0 | 0 |

## Why a custom kernel

Not because the trigram algorithm is novel. It isn't — Zoekt has done this well for years, and this project measured itself against Zoekt on every accepted change.

The reason is that buying the index means buying its process boundary, and the boundary costs more than the search. Here is where Zoekt's slowest query on the vite corpus actually spent its 18.32 ms:

| Stage | Time | Share |
| --- | ---: | ---: |
| Zoekt's own search | 1.24 ms | 7% |
| HTTP transport + JSON decode | 3.58 ms | 20% |
| Verification (mostly `rg` process startup) | 8.34 ms | 45% |
| Local merge and classification | 5.14 ms | 28% |

**The search itself is 7% of the bill.** The other 93% is the cost of the index living somewhere else: serialise the query, cross a socket, decode JSON, then spawn ripgrep to re-read files the index already had in memory. A single ripgrep spawn has a floor of about 6 ms on this machine — that alone outweighs the entire search.

Owning the kernel is what makes that 93% disappear:

- **The index is mapped into the agent's own memory.** No socket, no JSON, no serialisation. A query is a function call.
- **Verification reads the mmap'd index, not the disk.** Candidates are confirmed in-process against bytes that are already resident, so there is no spawn and no second read.
- **Unsupported queries can fail closed instead of approximating.** This one is not a performance argument, and it is the reason a general-purpose library was not enough. An earlier attempt used an off-the-shelf file finder for candidate selection; on the Linux kernel tree it returned 17,767 files where ripgrep found 17,772. Five missing files, from nested `.gitignore` re-inclusion rules — and a final ripgrep pass can only remove extra results, never recover ones the candidate stage already dropped. When the recall boundary is someone else's implementation detail, you cannot prove it, and you cannot fix it.
- **The index format is tuned for this shape of data** — compressed content blocks, delta-varint gram metadata — which is how the index lands at 0.38–0.91× the size of the source it indexes.

The trade is real and worth stating: one `.node` per platform to build and ship, and every ripgrep behaviour has to be re-proven rather than inherited. Twenty of the twenty-four benchmark queries are served from the index today; the other four hit ripgrep's binary-file and NUL-byte output semantics, which have not been replicated yet, so they fall back rather than guess.

## Correctness comes first

Every result set is checked against ripgrep on the same snapshot with the same flags. The bar is `missing = 0 && extra = 0` — and also identical ordering, byte offsets, context lines, and truncation behaviour.

**All 24 conformance queries match ripgrep exactly.** 20 are answered from the index; the other 4 fall back to ripgrep, and the comparison covers both paths. That has held on every accepted change.

Anything the index cannot serve *correctly* falls back to a full ripgrep search rather than returning a partial answer. Fallback is reported in the result metadata with a reason, so an unsupported query never looks like an empty result.

Currently falling back:

- Binary files where ripgrep's NUL-byte output semantics apply
- Regex combined with path or glob filters
- Literals shorter than 3 bytes, or spanning line breaks
- Case-insensitive search with a non-ASCII pattern
- Glob syntax outside the proven subset (`!`, `?`, `[]`, `{}`)

These are correctness boundaries, not missing features. Each one is a case where matching ripgrep's exact behaviour has not been proven yet, so the index refuses to guess.

## Staying fresh

An index is only useful if it reflects what you just edited.

Before any tool that can modify files runs, in-flight searches are drained and the index is invalidated. After the tool finishes, the index is rebuilt from the current working tree. A search can therefore only ever observe a complete state — never a torn one, mid-edit.

Measured recovery on a 300-file repository: **41–62 ms** from edit to searches running on the index again. Two consecutive `edit` calls and one `bash` call were each followed by a search that returned to the index and matched ripgrep exactly.

While a rebuild is in flight, searches fall back to ripgrep. Correct, just not accelerated.

## How it works

```
Pi (Node)                         snapgrep (Rust, same process)
┌────────────────┐   N-API     ┌──────────────────────────────┐
│ grep tool      │ ──────────► │ trigram index over a git     │
│                │ ◄────────── │ snapshot, mmap'd             │
└───────┬────────┘             └──────────────┬───────────────┘
        │                                     │ candidates
        │ unsupported query,                  ▼
        │ or index rebuilding      ┌────────────────────────┐
        ▼                          │ in-process exact verify│
   ripgrep (full search)           └────────────────────────┘
```

1. Split the pattern into trigrams and intersect their posting lists to get candidate files.
2. Apply hidden / path / glob / case filters at the candidate level, before any file is read.
3. Verify exactly, in-process, over the mmap'd index — no subprocess, no re-read from disk.
4. Materialize only the lines actually needed for the requested limit and context.

The index is a single file per repository, built from a clean git snapshot, with content blocks compressed and gram metadata delta-varint encoded.

## Development

```sh
./scripts/bootstrap.sh      # pins dependencies, builds, runs the test suite
npm run check               # type check
npm test                    # unit and integration tests
npm run test:kernel         # native tests against the real addon
npm run benchmark           # correctness and performance harness
```

Requires Node 22.19+, Rust, and ripgrep on `PATH`.

Benchmark result artifacts from the most recent accepted rounds are in [`artifacts/results/`](artifacts/results/), including the correctness runs, the same-run A/B no-regression measurements, and the delivery readiness numbers quoted above.

## Method notes

Two measurement rules this project learned the hard way, both worth stealing:

**Never compare against a P50 recorded in an earlier run.** Re-measuring the same unchanged code across sessions drifted by −31% to +9% — enough to manufacture a regression that does not exist, or hide one that does. Every no-regression check runs both versions in the same process batch, alternating ABAB, each with its own warmups.

**A 5% threshold is meaningless on a query that does no work.** For searches with zero candidate files, 5% is about 4 microseconds — below timing noise. Running two byte-identical builds against each other showed exactly how much noise each class of query carries, and the thresholds were set from that measurement: absolute microsecond bounds for near-zero-work queries, the relative 5% bound for everything else. That calibration immediately caught a real 5 µs regression caused by an added per-instance property changing V8's object layout.

## License

MIT
