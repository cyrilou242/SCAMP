# Left / Right Matrix Profile in SCAMP — design notes

Exploration notes from a session investigating whether SCAMP could add
left/right MP support. **Not a decision doc, not a plan of record** —
just captured findings so a future implementation attempt doesn't have
to rediscover them.

## What "left matrix profile" means

For a self-join on a series of length `n` with subsequence length `w`:

- **Full MP** at position `i`: `min over j ≠ i (with exclusion band) of dist(i, j)`.
- **Left MP** at position `i`: `min over j < i - excl of dist(i, j)`. "How close is my nearest neighbour in the past?"
- **Right MP** at position `i`: `min over j > i + excl of dist(i, j)`. Mirror image.
- `Full MP[i] = min(Left MP[i], Right MP[i])`.

Standard use cases for left MP:
- Streaming / online anomaly detection (only the past exists).
- Discord discovery (DAMP, MADRID).
- Time-series chains (follow `argmin` pointers leftward or rightward).
- Regime-change detection.

## What SCAMP has today

**Not directly**, but the pieces are 80% there.

### `profile_a` vs `profile_b`

These are the outputs of two different reduction directions inside each
tile:

- `profile_a` — indexed by **column position**. Reduction over rows within
  the tile.
- `profile_b` — indexed by **row position**. Reduction over columns within
  the tile.

For an **AB-join**: `profile_a` = MP of A vs B, `profile_b` = MP of B vs A.
Two independent MPs, as pyscamp exposes.

For a **self-join** with `keep_rows_separate=false` (default): both get
merged into `profile_a` at merge time
(`src/core/tile.cpp:559` — the `else if (info_->self_join && info_->computing_rows)`
branch calls `profile_a->MergeTileToProfile(&profile_b_tile_, ...)`).

For a **self-join** with `keep_rows_separate=true`: the two stay separate,
but this configuration is **not intended** by upstream for self-joins.
`src/main.cpp` docs the flag as *"only valid for ab-joins"* and
`src/python/SCAMP_python.cpp` doesn't expose it for self-joins.

### Why `keep_rows_separate=true` on a self-join *almost* gives you left/right MP but not quite

SCAMP enumerates only upper-triangle tiles for a self-join
(`src/core/SCAMP.cpp:37`, `get_tiles()`). Every pair `(i, j)` computed has
`j > i`. So naively:

- Reducing over rows at column `j` → min over `i < j` → **LEFT MP at j**.
- Reducing over columns at row `i` → min over `j > i` → **RIGHT MP at i**.

**Catch**: off-diagonal tiles use `do_self_join_full` which internally
runs both `do_self_join_half` (upper) and a "swapped lower" pass
(`src/core/tile.cpp:589-623`). The lower pass calls
`cpu_kernel_self_join_lower`, which **swaps `profile_a` and `profile_b`**
plus `computing_rows` / `computing_cols`
(`src/core/cpu_kernel/kernel_dispatcher.cpp:65`). This is done to
efficiently share correlation state between the two triangle passes of a
single tile — but it **destroys the left/right correspondence** in
`profile_a` / `profile_b`. Empirically the split output is *some*
partition of the pairwise contributions, not clean left/right.

### What would need to change to expose real left/right MP

1. **Restrict self-join tile execution to strict upper triangle.** Replace
   `do_self_join_full` with `do_self_join_half` for off-diagonal tiles.
   Costs ~10-20% perf (loses the correlation-reuse of the "full" pass).
2. **Keep the two reduction directions in separate output buffers**
   throughout — already what `keep_rows_separate=true` does at storage
   level.
3. **Expose it via API.** Either a new profile-type value
   (`PROFILE_TYPE_1NN_INDEX_LEFT_RIGHT`) or an orthogonal boolean flag
   (`compute_left_right: bool` on `SCAMPArgs`).

Kernel-level change is on the order of a dozen lines. Merge logic is
already keep-separate-aware.

## Rolling-lookback left MP (a different animal)

Intuition question that came up: "shouldn't every position be compared to
the *same number* of previous windows, so the rightmost windows don't get
compared against way more history than leftmost?"

That's not what MADRID/DAMP does. MADRID uses **unbounded left lookback**:

```matlab
% From MADRID_2_0.m, DAMP_2_0() and DAMP_topK_new()
query = T(i : i+SubsequenceLength-1);
Left_MP(i) = min( real(MASS_V2(T(1:i), query)) );
```

Position `i` is compared against **all** i-1 earlier starting positions.
The paper's rationale:

1. The anomaly question is inherently asymmetric: "given all history so
   far, is this surprising?" naturally scales with how much history you
   have.
2. Early positions are explicitly discarded via `location_to_start_processing`
   (aka `train_test_split`) — their MP values are marked NaN because
   the lookback is too short to be meaningful.
3. The `lookahead` variable in the MADRID code is a **forward-in-time
   pruning trick** ("this future subsequence's MP is already dominated
   by best-so-far, skip"), not a lookback bound. Confusingly named.

The rolling variant — position `i` compared to `[i-W, i)` for fixed W —
is a **legitimate different algorithm** with different semantics:

| Variant | Lookback | Best for | Cost |
|---|---|---|---|
| Full-lookback left MP (MADRID/DAMP) | `[0, i)`, grows | Offline anomaly detection where "unusual vs everything seen" is the definition | O(n²) |
| Rolling-lookback left MP | `[i - W, i)`, fixed | Streaming / concept-drift, positionally-comparable scores | **O(n·W)** |
| Bidirectional MP (classic) | full series | Motif discovery, chains | O(n²) |

### Behavioural differences

- Full lookback: a repeating motif starting at t=1000 recurring at
  t=100 000 is *low* at t=100 000 (earlier occurrence matches) but *high*
  at t=1000 (nothing precedes it). Right-decreasing trend intrinsic to
  the definition.
- Rolling lookback (W = 50 000): same pattern is *low* at both
  t=1000 (short reference) and t=100 000 (previous match in window). No
  intrinsic drift with time.
- Rolling lookback surfaces **regime changes** more sharply: the
  reference window is temporally local, so a shift in behavior stands
  out. Full-lookback MADRID reports the same regime change but with a
  larger score contaminated by ancient history.

### Cost profile

Rolling with W ≪ n is *much cheaper* than either full MP or full-lookback
left MP: `O(n·W)` instead of `O(n²)`. This opens much longer series to
real-time analysis than any current SCAMP mode.

## If we ever do this

Preferred API shape (bike-shed later):

```
profileVariant: 'full' | 'left' | 'right'      # unbounded left/right MP
profileVariant: 'left_rolling'                  # rolling variants
lookback: W                                     # accompanies rolling
```

Order of contribution to upstream, by increasing controversy:

1. **Rolling left MP.** Different cost class (linear in n), no impact on
   existing full-MP paths, orthogonal API surface. Probably the highest-
   leverage / lowest-friction addition.
2. **Full-lookback left/right MP.** Reuses existing self-join machinery
   with the strict-upper-triangle tweak. Small perf hit for self-joins
   with the current `do_self_join_full` optimization removed for the
   left/right-requesting path (can be gated so default self-joins keep
   the current fast path).
3. Both.

No plan of record — this doc exists just so someone (me, next time,
probably) doesn't have to re-derive all this from scratch.

## References

- `src/core/SCAMP.cpp:27-90` — `get_tiles()` self-join tile ordering.
- `src/core/tile.cpp:337-370` — `InitProfile` behaviour under
  `keep_rows_separate`.
- `src/core/tile.cpp:589-623` — `do_self_join_full` = upper-half + swapped
  lower-half; the pass that destroys the left/right split.
- `src/core/cpu_kernel/kernel_dispatcher.cpp:52-74` — the
  `_lower` variants that swap `profile_a`/`profile_b` and
  `computing_rows`/`computing_cols`.
- `src/common/scamp_args.cpp:75-85` — `InitProfileMemory` allocation
  behaviour under `keep_rows_separate`.
- `src/main.cpp:220-240` — `--keep_rows` CLI flag, documented as
  "only valid for ab-joins".
- `~/Downloads/MADRID_2_0.m`, functions `DAMP_2_0` (line 511) and
  `DAMP_topK_new` (line 324) — canonical left MP implementation with
  brute-force `MASS_V2(T(1:i), query)`.
