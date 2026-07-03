# MOMP on SCAMP-wasm — the case for it

A short pitch for why building [MOMP](algorithms-momp-madrid.md) on top of
SCAMP-wasm is the single highest-leverage next feature. Not a plan of
record — call this a "we deferred it, here's the case if we change our
mind" doc.

## What MOMP is, in one sentence

MOMP is an *anytime, exact* motif-discovery algorithm that uses a
provably-correct lower bound on the matrix profile to prune ~90–99%
of the input data before running exact MP on the surviving fragment.
The exact-MP call in the paper's pseudocode is literally `SCAMP(T, m)`.

## Why it matters for scamp-wasm specifically

- **Wasm-native SCAMP has an O(n²) time wall**, well before it has a
  memory wall. On a modern browser, 1M points takes a few minutes; 10M
  points would take hours; 100M points is impractical.
- MOMP's reported speedups on real datasets (from the ICDM'23 paper):

  | Dataset | n | SCAMP alone | MOMP | Speedup |
  |---|---|---|---|---|
  | Human Y chromosome | 26M | ~5 years | 1.08 hours | ~41,000× |
  | EOG (13.4M) | 13.4M | days | 125s (good motif), 7.1h (converged) | 100–1000× |
  | 7-hour respiratory | 6M | 68.3 hours | 2.21 hours | ~30× |

- **This turns "SCAMP in the browser" (a curiosity) into "exact motif
  discovery on real datasets in the browser" (a genuinely useful tool)**.

## Why this is cheap to build

MOMP's non-SCAMP code, from the paper's Table 2–6, is:

- **PAA downsampling** — ~10 lines, straight typed-array reduce.
- **KTIP computation** — ~14 lines, nested loop over Euclidean distances
  at power-of-2 diagonal offsets.
- **lbMP computation** — ~7 lines, one SCAMP call + subtraction + upsample.
- **Local BSF refinement** — ~7 lines, one small SCAMP call at a slice.
- **Pruning** — ~5 lines, mask + concatenate.
- **Main loop** — ~14 lines.

**~60 lines of pure numeric code**. All the heavy lifting stays inside
our existing scamp-wasm.

## Implementation shape

A separate JS-only package or subexport, `scamp-wasm-motif`, that
depends on scamp-wasm:

```ts
import { momp } from 'scamp-wasm-motif';

const { motifDistance, motifLocation, bsfHistory } = await momp(
  timeSeries,   // Float64Array
  windowSize,   // e.g. 1024
  {
    onProgress: ({ pruneRate, currentBSF, iter }) => ...,
    signal,     // AbortSignal — proper anytime abort
  },
);
```

Internally:
1. `create()`s a scamp-wasm client.
2. Runs the coarse-to-fine loop: PAA → KTIP → lbMP → prune, halving
   dsr until dsr=1.
3. At dsr=1, calls `scamp.run({a: prunedSeries, ...})` for the exact
   final MP.
4. Returns the best-so-far motif from anywhere along the way.

Zero changes to SCAMP core. Zero changes to scamp-wasm's C++ bindings.
Purely a JS/TS library on top.

## Why it's a natural fit for the anytime UX we already prototyped

MOMP is inherently anytime — each iteration of the coarse-to-fine loop
produces a valid best-so-far, monotonically improving. The `onProgress`
callback we already have for scamp-wasm maps cleanly:

- Between MOMP iterations, fire an update with `{iter, dsr, pruneRate, bsf}`.
- Inside the final SCAMP call, the existing `onProgress`/`onSnapshot`
  hooks pass through — so we get the demo's live plot for free.

## Estimated effort

- **v0.1 MOMP** (correct, no perf tuning): **~1 day.** Straight port of
  Tables 2–6 from the paper, tested against paper's provided data.
- **v0.2 with the paper's optimizations** (KTIP caching across dsr
  levels, best-so-far location refinement): **~1 more day.**
- **Nice-to-have: anytime plot in the demo** showing prune rate + BSF
  over time: half day of demo work.

Total to ship MOMP as a real feature on top of scamp-wasm: **~2–3 days**.

## Why we deferred it

Nothing in the wasm work itself needs MOMP to be considered "done". MOMP
is a "next big thing" — it opens up a new class of workloads (browser
motif discovery at 100M+ points) but isn't a bug fix or completeness
item. Building it should be its own decision.

## Failure modes to know before starting

From the paper's Section V.D:

1. **Pure noise ("nothing is a motif")**: no pruning ever happens, MOMP
   runs at ~2× SCAMP's cost (wasted coarse iterations). Not a correctness
   issue.
2. **Homogeneous data ("everything is a motif", e.g. clean sine)**:
   same — bounds too loose for pruning. MOMP runs full cost with
   overhead.
3. **Small n**: SCAMP alone is fast; MOMP overhead not worth it. The
   paper notes a break-even at ~40% prune rate. Small datasets rarely
   hit that.
4. **Small m**: not enough resolution levels for the multi-scale loop.

Practical impact: MOMP should have a runtime heuristic that falls back
to plain SCAMP when prune rates stay <40% after 2-3 iterations. Adds
maybe 10 lines to the wrapper.

## References

- The MOMP paper (Matrix Profile XXXI), local copy at
  `wasm/notes/papers/MOMP_DeskTop.pdf` (git-ignored).
- Detailed algorithm mechanics + pseudocode in
  [`algorithms-momp-madrid.md`](algorithms-momp-madrid.md).
