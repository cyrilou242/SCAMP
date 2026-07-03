# Publishing & infrastructure — deferred items

Notes on things we know need to happen before scamp-wasm is a "real"
product but which we haven't done yet. Not a plan of record — captured
so we don't rediscover the decisions from scratch later.

## Continuous integration

None currently. A minimum-viable GH Actions workflow would:

1. Cache emsdk (~1.5 GB unpacked; cache key = `.emsdk-version`).
2. On PR / push to main:
   - `wasm/setup.sh` (no-op on cache hit)
   - `wasm/build.sh both`
   - `node wasm/test/node-smoke.mjs`
   - `node wasm/test/correctness.mjs` (needs native binary — either
     build in the same job or skip on CI runners without the native
     dependency chain sorted)
3. On release tag `wasm-vX.Y.Z`:
   - build ST + MT
   - upload `dist/` as workflow artifacts
   - optionally `npm publish` if we've decided on a name

Estimated effort: **~half day**. The awkward bit is the correctness
test — it needs a working native SCAMP build, which currently means
cloning submodules, running the full CMake configure (~15s cold cache),
and building at least the `SCAMP` executable target. Doable but adds
several minutes to CI. Options:

- Skip correctness on CI, run it locally as a release gate.
- Cache the native binary as an artifact from a separate job.
- Ship a reference "golden output" JSON for the correctness input and
  diff wasm against that (no native binary needed on CI).

The third option is cleanest and worth doing regardless.

## npm publishing

`wasm/package.json` exists but:
- No `prepublishOnly` hook.
- No `.npmignore`; `files` field lists `dist/` only, which is correct.
- No entry point declarations for ESM (`exports` field missing).
- Version is `0.1.0`; no changelog.
- **Name is unclaimed on npm.** `scamp-wasm` looks free but should be
  verified before commit.

To publish:
1. Decide on scoping. Options: `scamp-wasm`, `@zpzim/scamp-wasm` (if
   upstream accepts / co-owns), `@cyrilou242/scamp-wasm`.
2. Add `exports` field for modern ESM+CJS interop:
   ```json
   "exports": {
     ".": {
       "types": "./dist/scamp.d.ts",
       "require": "./dist/scamp.js"
     }
   }
   ```
   Note our current `scamp.js` is UMD-with-CJS-detection; if we want
   ESM export too we'd need a small ESM stub file.
3. Add `prepublishOnly: "bash build.sh both && npm test"`.
4. `npm publish --access public` (for scoped names).

Estimated effort: **~2 hours** once we've decided on the name and repo
extraction status.

## Repository extraction

Currently scamp-wasm lives under `wasm/` in a fork of the upstream
SCAMP repo. Longer term, extracting to a standalone repo is preferable
because:

- Users installing `scamp-wasm` shouldn't have to clone SCAMP's ~200 MB
  git history (with submodules).
- Independent release cadence.
- Cleaner CI (no cross-contamination with upstream's Python/CUDA CI).

Two paths, discussed earlier in the session:

**Path A — upstream the necessary hooks first.**
Get three small PRs into `zpzim/SCAMP`:
1. `src/core/scamp_async_shim.h` + shim'd `std::async` calls (10 LOC,
   uncontroversial).
2. `SCAMP_BUILD_WASM` cmake option + gate for main.cpp/gflags (~15 LOC,
   uncontroversial).
3. Progress callback + abort flag additions to `SCAMP_Operation`
   (~30 LOC, may draw API discussion — non-blocking for us since we
   can ship without it via a downstream patch).

Then scamp-wasm becomes a pure downstream consumer that pulls SCAMP as
a git submodule at a pinned tag. **~1 day** of extraction work after
upstream merges.

**Path B — extract now with a patch series.**
Same code changes as Path A but delivered as a `patches/` directory in
the scamp-wasm repo that gets applied by `setup.sh` before building.
Works without upstream cooperation. Cost: rebasing patches on every
SCAMP release, typically 15 minutes. SCAMP releases infrequently (~7
months apart historically), so amortised cost is low.

Estimated effort:
- Path A: **~1 day** post-merge (mostly repo hygiene + CI setup).
- Path B: **~1.5 days** (add ~3 hours for the patch series scaffolding
  and idempotence checks).

**Recommendation** (from earlier session): open the upstream PRs now
(low risk, low contentious content), extract to Path B initially, flip
to Path A once merges land.

## What we're NOT doing (and why)

- **Phase 3 wasm SIMD** (hand-written intrinsics or Eigen wasm backend).
  See performance table in `wasm/README.md`. Remaining wasm-vs-native
  gap on 1NN is bounded by wasm's lack of AVX2/FMA. `-mrelaxed-simd`
  might close half of it (~15% speedup); pursued if a user reports
  1NN perf as blocking, otherwise not.
- **GPU (WebGPU) SCAMP.** Would require a full CUDA-to-WGSL port of
  the kernels. Not the same order of effort as the current wasm work;
  more like a research project. WebGPU fp64 support is still spotty.
- **Streaming / online API.** Not designed for. Current API is batch
  self-join / AB-join. Streaming would need DAMP-style pruning +
  left-MP, both non-trivial (see `left-right-matrix-profile.md` and
  `algorithms-momp-madrid.md`).

## Committed but questionable

- **`dist/` is currently tracked in git.** ~750 KB per commit of built
  artifacts. Fine for now (avoids requiring emsdk on every consumer),
  will be removed once we have CI producing release artifacts and/or
  npm publishing the package. See `.gitignore` for what stays out.
- **The 32 MB tutorial PDF** in `notes/papers/` is git-ignored —
  reference-only, not part of the repo.

## Rough cost of "actually ship v0.1"

If we decided today to make scamp-wasm publish-ready:

| Task | Effort |
|---|---|
| Golden-output-based correctness test (removes native dep from CI) | 3 h |
| GH Actions: build + smoke + correctness on push | 4 h |
| Path B extraction (patches + submodule + own repo) | 1 day |
| npm publish setup + first publish | 2 h |
| README polish targeted at end users vs contributors | 3 h |
| Small demo hosted somewhere (GH Pages, Cloudflare Pages) | 3 h |
| **Total** | **~3 working days** |

Then Path A upstream PRs to enable a cleaner v0.2 without patch
management overhead.
