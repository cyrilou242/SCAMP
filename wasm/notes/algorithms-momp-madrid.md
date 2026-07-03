# Notes on MOMP and MADRID — implications for SCAMP-wasm

Papers reviewed:
- **MOMP** ("Matrix Profile XXXI: Motif-Only Matrix Profile: Orders of Magnitude Faster"), Shahcheraghi & Keogh.
- **MADRID** ("Matrix Profile XXX: MADRID: A Hyper-Anytime and Parameter-Free Algorithm to Find Time Series Anomalies of all Lengths"), Lu, Srinivas, Nakamura, Imamura, Keogh (ICDM'23).
- KDD 2025 Motif-Mining Tutorial slides, Keogh.

Local copies: `wasm/notes/papers/*.pdf` (git-ignored).

## The two papers solve *opposite* problems on top of the same base

- **MADRID → discord (anomaly) discovery**, based on DAMP (left MP + pruning).
  Runs DAMP at *every* subsequence length in `[minL, maxL]` and returns a
  ranked multi-length discord table. Truly parameter-free (minL=3,
  maxL=arbitrary, step=1 as defaults).
- **MOMP → motif (repeated pattern) discovery**, based on classic MP.
  Uses a novel *lower bound* on the MP to admissibly prune large regions
  of the time series before running exact MP on the survivors.

MOMP calls a full MP algorithm as a subroutine. The paper explicitly
names SCAMP in Table 2 line 13: `mp, motifloc = SCAMP(T, m)`. **MOMP is
architected as a wrapper around SCAMP.**

## MOMP mechanics

Two ingredients:

### 1. Lower Bound Matrix Profile via KTIP

Idea: downsample T by factor `dsr` using PAA (Piecewise Aggregate
Approximation), compute an *approximate* MP (`AMP_dsr`) on the downsampled
series. AMP is *not* a lower bound (Figure 6). Correct it into a true
lower bound `lbMP_dsr` by subtracting the *K-Triangular Inequality
Profile* (KTIP) — a per-column bound on how far cohort points around each
anchor could vary from the anchor.

Formal:
```
lb_i = max_{j ≠ i} [ amp[i] - (ktip[i] + ktip[j]) ]
lbMP_dsr[i] = lb_i  (upsampled by dsr, multiplied by √dsr)
```

Special case: `dsr = 1` → `lbMP_1-to-1 = MP` (no downsampling = exact).

Trade-off (Figure 7 Pareto frontier): larger `dsr` = cheaper compute but
looser bound. There's a per-dataset sweet spot; the paper's algorithm
doesn't pick one — it uses *all of them* iteratively.

### 2. Iterative prune-then-upsample

```
T_0 = T
dsr = m / 32              # coarse start
bsf = infinity
ktip_full = computeKTIP(T_0, m, dsr)
while True:
    ktip_slice = ktip_full at level log2(dsr)
    lbMP, local_bsf = computeLBMP(T, m, dsr, ktip_slice)
    bsf = refineBSFLoc(T_0, m, dsr, local_bsf, bsf)  # local scan
    prnT = prune(T, m, lbMP, bsf)                    # drop regions with lbMP > bsf
    T = prnT
    dsr = dsr / 2
    if dsr == 1:
        mp, motifloc = SCAMP(T, m)                    # ← exact MP on surviving data
        return min(mp), prnT.indices(motifloc)
```

Every halving of dsr, previously-pruned regions stay pruned; new
pruning happens on the finer data. By the time dsr=1, most of T is gone
and SCAMP only sees a fraction of the original series.

### Cost model (Figure 9)

```
Speedup vs classic MP ≈ 1 / (1 - prune_rate)² · 1/2
```

Break-even at ~40% prune rate. Above that, speedup is superlinear in
prune rate:
- 90% pruned → **~41×**
- 99% pruned → **~1,250×**
- 99.9% pruned → **~125,000×**

Worst-case overhead is ~2× (nothing prunes, all the coarse iterations
wasted). Space: O(n).

### Empirical results (paper Section VI)

- **Human Y chromosome (26M bp)**: SCAMP alone would take ~5 years.
  MOMP: **1.08 hours**. Speedup: ~41,000×.
- **13.4M-point EOG dataset**: MOMP finds good motif in **125 seconds**;
  fully converges in 7.1 hours.
- **7-hour respiratory dataset**: MOMP 2.21 hours, SCAMP 68.3 hours.
- Prune rates on real data: routinely 91–99% (low-sample-rate) up to
  96.9% (high-sample-rate).

### Failure modes (paper Section V.D)

1. **"Nothing is a motif"** (pure noise): bsf never drops, no pruning.
2. **"Everything is a motif"** (e.g., sine wave + noise): everything is
   near-motif, bounds are close to zero everywhere, no pruning.
3. Small `n`: SCAMP is already fast, overhead not worth it.
4. Small `m`: not enough resolution levels for the multi-scale loop.

## MADRID mechanics

MADRID's tricks are orthogonal to MOMP's:

- **Warm-start DAMP**: each row's DAMP run initializes `bsf` from the
  previous row's discord location. ~1.5× speedup.
- **Hyper-anytime initialization**: instead of processing lengths in
  order, first do DAMP at maxL, then minL, then mid-length, then
  cross-length column fills. Delivers a good approximate multi-length
  table within ~1% of full compute budget.
- **Length normalization**: divide distances by √m so scores across
  different subsequence lengths are commensurate.

Hyper-anytime property (Figure 5): converges to within 10% of final
answer using <10% of compute resources.

Perf (Figure 7, 8192-point series, 641 subsequence lengths):
- Pure brute force NN: **~15.5 hours**
- MASS Brute Force: ~1 hour (14× faster)
- Pure DAMP: **24 minutes**
- Warm-start DAMP: **16 minutes**
- MADRID hyper-anytime: converges much earlier

## Direct implications for SCAMP-wasm

### 1. MOMP on top of SCAMP-wasm is the obvious next big feature

The paper's authors imagined MOMP being deployed on top of SCAMP. Our
SCAMP-wasm build gets us "SCAMP in the browser". MOMP on top gets us
"motif discovery on datasets 100–40 000× larger than SCAMP alone can
handle, in the browser."

The non-SCAMP part of MOMP is *small*:
- PAA downsampling (Definition 4, ~10 lines).
- KTIP computation (Table 3, ~14 lines).
- lbMP computation (Table 4, ~7 lines).
- Local BSF refinement (Table 5, ~7 lines).
- Pruning (Table 6, ~5 lines).
- Main loop (Table 2, ~14 lines).

Total non-SCAMP arithmetic: **~60 lines of straightforward numerical code**.
The heavy lifting stays inside SCAMP.

Two implementation options:

**A. MOMP entirely in JS (best for wasm)**
- The PAA / KTIP / lbMP / prune arithmetic runs in JS over typed arrays.
- The `SCAMP(T, m)` line calls our existing `scamp.run(...)`.
- Zero changes to SCAMP core. Pure JS wrapper library on top of
  scamp-wasm.
- Downsampled MP calls invoke SCAMP wasm; results feed the lbMP.
- Estimated effort: **1–2 days**.

**B. MOMP inside SCAMP C++**
- Same code but in C++ inside `wasm/src/bindings.cpp` (or a new source
  file).
- Faster PAA/KTIP because they run in wasm SIMD.
- But those steps are already tiny compared to SCAMP itself, so the
  speedup is likely <5% end-to-end.
- More invasive; not worth it unless we also want to expose MOMP
  natively in non-wasm SCAMP.

**Recommendation: option A.** Ship as `scamp-wasm-motif` or similar
higher-level package. Users call `momp(a, window, opts)` and get back a
`{motifIdx, distance}` result on time series that would OOM or take
weeks with vanilla SCAMP.

### 2. MADRID / DAMP is a separate project

MADRID depends on DAMP, which is a **left-MP + pruning** algorithm.
SCAMP has no left-MP support (see `left-right-matrix-profile.md`).
DAMP-on-SCAMP is far more work than MOMP-on-SCAMP because:
- Need to add left-MP to SCAMP first (~1 week of upstream work).
- DAMP's backward-expanding search doesn't fit SCAMP's tile scheduler.
- Reference DAMP MATLAB is competitive on real data (99%+ prune rate).

Value proposition is weaker: browser anomaly-detection on huge series is
niche; browser motif discovery on huge series is a demo/tool win.

### 3. What we already have, ordered by usefulness

| Feature | Status | Realistic dataset ceiling |
|---|---|---|
| SCAMP wasm CPU/SIMD self-join | ✅ done | ~500k points (~few minutes) |
| SCAMP wasm MT | ✅ done | ~1–2M points |
| MOMP on top of scamp-wasm (option A) | 🔜 1–2 days | ~10–100M points |
| Left-MP in SCAMP + DAMP-on-SCAMP | 🔮 multi-week | irrelevant if MOMP does the job |

MOMP is the single highest-leverage next step.

## Detailed algorithm crib (for future implementation)

### PAA (Definition 4)
```
ti_bar = k/n · Σ_{j=n(i-1)/k+1}^{n·i/k} tj    # window mean
```
For k = n/dsr (i.e., downsample by `dsr`), output length is n/dsr,
each output value is the mean of `dsr` consecutive input values.

### KTIP (Table 3)
```
computeKTIP(T, m, dsr_0):
  n = len(T)
  ktip = nan(n-m+1, log2(dsr_0))
  temp = nan(n-m+1, 1)
  for diag = 1..dsr_0:
    for rr = 1..n-m-diag+2:
      cc = rr + diag - 1
      dist = ED(T[rr..rr+m-1], T[cc..cc+m-1])
      if dist < temp[rr]: temp[rr] = dist
      if dist < temp[cc]: temp[cc] = dist
    if ispow2(diag):
      ktip[:, log2(diag)] = temp
  return ktip
```
Intuition: for each subsequence, compute the largest z-normalized
distance to any of its "cohort" neighbours (within `diag` positions in
either direction). Store at power-of-two diagonal offsets. Later used
as a "how far could this anchor's local neighbourhood be from it"
compensation term.

Cost: O(n · dsr_0) diagonals × O(n) per diagonal = O(n²) worst case,
but with a large dsr_0 the constant is a fraction of the full MP.

### lbMP (Table 4)
```
computeLBMP(T, m, dsr, ip):     # ip = ktip slice
  lbMP = nan(size(amp))
  dT = PAA(T, dsr)
  amp = SCAMP(dT, m/dsr)                        # cheap: n/dsr points
  for i in 1..len(amp):
    lbMP[i] = max_{j≠i}(amp[i] - ip[i] - ip[j])
  lbMP_dsr = upsample(lbMP, dsr)                # repeat each value dsr times
  return lbMP_dsr, min(lbMP_dsr)
```
Cost dominated by the inner `SCAMP(dT, m/dsr)` call, which is `dsr²`
times cheaper than SCAMP on the full data. That's the whole point.

### Prune (Table 6)
```
prune(T, m, lbMP, bsf):
  tgts = locate(lbMP <= bsf)                    # positions we still need to check
  prnT = concatenate(T[t : t+m-1] for t in tgts)
  return prnT
```
Note: actual code handles concatenation overlaps and boundary alignment;
paper glosses over this. Would need care in JS/C++ impl.

### Main loop (Table 2)
```
MOMP(T, m):
  T_0 = T
  dsr = m/32
  bsf = infinity
  full_ktip = computeKTIP(T_0, m, dsr)          # one-time cost
  while True:
    ip = full_ktip[:, log2(dsr)]
    lbMP, local_bsf = computeLBMP(T, m, dsr, ip)
    bsf = refineBSFloc(T_0, m, dsr, local_bsf, bsf)
    prnT = prune(T, m, lbMP, bsf)
    T = prnT
    dsr = dsr / 2
    if dsr == 1:
      mp, motifloc = SCAMP(T, m)                # ← our SCAMP wasm call
      return min(mp), prnT.indices(motifloc)
```

`m/32` initial dsr is not critical — the paper reports 128:1 and 16:1
give ~equivalent perf. Number of outer iterations: `log2(m/32)`, so for
m=1024, 5 iterations. Each iteration is cheaper than the previous by
roughly 4× (data is halved twice per dsr halving because both series
length AND effective window shrink).

## What to build first

If we commit to this: a small standalone JS/TS package
`scamp-wasm-motif` (or a sub-export of scamp-wasm) exposing:

```ts
import { momp } from 'scamp-wasm-motif';
const { motifDistance, motifLocation, progress } = await momp(
  timeSeries,          // Float64Array
  windowSize,          // e.g. 1024
  {
    onProgress: (bsf, pruneRate, iter) => ...,
    signal,            // AbortSignal
  }
);
```

Internally calls our existing `SCAMP.create({...})` and `scamp.run(...)`,
plus the PAA/KTIP/lbMP/prune loop in pure JS. Reuses the wasm-native
correlation kernel for the coarse (`dsr > 1`) MP passes too — no
separate coarse-MP implementation needed; SCAMP handles arbitrary
subsequence lengths so `SCAMP(dT, m/dsr)` is just another SCAMP call
with different args.

This turns SCAMP-wasm from "matrix profile in the browser (~1M points)"
into "**exact motif discovery in the browser (~100M points)**", which is
a much more compelling headline demo.
