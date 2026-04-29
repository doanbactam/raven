# swarm-cp validation N=2: medium synthetic repo

**Date**: 2026-04-29
**Workload**: 6 independent utility modules (`strings`, `arrays`, `numbers`, `objects`, `dates`, `predicates`); 3 exports each = 18 functions total. Add JSDoc + node:test test file per module. `npm test` must pass.
**Constraint**: edits restricted to `src/` and `tests/`.
**Hardware/runtime**: Windows 11, pwsh, Node 22.22.1, Claude Code 2.1.105 (`glm-5.1`).

## Run results

| Run | Wall-clock | Cost | Test count | Notes |
|---|---|---|---|---|
| **Baseline-1** | **246.3 s** | **$0.889** | 51/51 ✓ | 29 turns; no cache (run first) |
| **Baseline-2** | **262.4 s** | **$0.526** | 51/51 ✓ | 27 turns; **41% cheaper via prompt cache** (`cache_read_input_tokens: 312k`) |
| **Swarm-1** | **220.1 s** *(plan 90.2 + run 129.9)* | *unrecorded — bug* | 54/54 ✓ | 6 tasks all `GatePassed` then crashed at commit step (PAGER bug; see Findings #2) |
| **Swarm-2** | **308.4 s** *(plan 122.8 + run 185.6)* | **$2.98** *(workers only; see #3)* | 65/65 ✓ | **7 tasks** — planner added integration `npm test` task; full E2E success |

### Aggregates

| Metric | Baseline mean | Swarm mean | Δ |
|---|---|---|---|
| Wall-clock | 254.4 s | 264.3 s (mean of 220 + 308) | **+4% slower** |
| Cost (worker total) | $0.71 | $2.98 (only swarm-2 measurable) | **~4× more expensive** |
| Tests written | 51 | 54–65 | **+6% to +27% more coverage** |
| Out-of-scope edits | 0/2 | 0/2 | tie this round |

## Key findings

### 1. Both bug fixes from N=1 worked
- **Platform-aware planner**: Swarm-2's planner produced cross-platform checks (`node -e "...readFileSync.includes(...)"`) instead of `grep`. Zero gate failures on tooling. ✓
- **Gate `tool not found` semantics**: Untested in this run because no checks tripped it, but unit-tested (5 new tests in `@c:/Users/kisde/Desktop/raven/src/smoke.test.ts:140-182`).

### 2. NEW BUG #1 (caught + fixed): simple-git rejects PAGER
Swarm-1 saw all 6 tasks `GatePassed` then crash at `commitAll` with:
```
Use of "PAGER" is not permitted without enabling allowUnsafePager
```
Root cause: `simple-git@^3` rejects a list of "unsafe" env vars (PAGER, GIT_PAGER, GIT_ASKPASS, SSH_ASKPASS, GIT_PROXY_COMMAND, GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND) when inherited from parent `process.env`. Our dev env has `PAGER=cat` set globally.

**Fix**: `sanitizedEnv()` helper in `@c:/Users/kisde/Desktop/raven/src/worktree.ts:92-113` strips all 7 vars before passing to simple-git. Applied to both constructor and `commitAll()`.

### 3. NEW BUG #2 (caught + fixed): cost lost on post-worker exception
When `commitAll` threw, the `catch (err)` block logged `error` only, dropping `costUsd` from the worker. Swarm-1's $1.5–3 in worker spend is auditless.

**Fix**: dispatcher now hoists `lastCostUsd` outside the try and emits it in the catch path (`@c:/Users/kisde/Desktop/raven/src/dispatcher.ts:75,95,170-175`). All future runs preserve cost regardless of failure point.

### 4. Cost gap is real (4×) but partly explainable
- Baseline-2 was 41% cheaper than Baseline-1 due to prompt cache. Single agent rerunning the same goal benefits hugely from KV-cache.
- Swarm spawns 6 cold sessions; each pays full prompt-prefill cost.
- Swarm-2 also has a 7th task (integration check) the planner added on its own.
- **Planner cost is currently unmeasured** — `Planner.plan()` doesn't read `total_cost_usd` from the planner's stream. Real swarm-2 cost is likely $3.5–4.5 incl. planner.

Cost is the headline regression. Possible mitigations (none implemented):
- Share session prefix across worker calls (Claude Code's `--session-id` resume) — saves ~30-50% on prefill.
- Cheaper worker model for low-risk tasks (config has `routing.worker_model: fast`, but our runner doesn't yet pass `--model`).
- Drop the integration task (or make it free via `npm test` outside the agent loop).

### 5. Quality advantage: more thorough tests
- Baseline avg: 51 tests (8.5/module).
- Swarm-1: 54 tests (9.0/module).
- Swarm-2: 65 tests (10.8/module + 0 integration assertions).

Each isolated worker spent its turns more deeply on its single module than the single-agent baseline could amortize across 6.

### 6. Boundary-enforcement value didn't manifest this round
Both baselines stayed within scope because `package.json`'s test script was already `node --test tests/*.test.js` (fixed before this run, after N=1 surfaced the issue). With the broken script, baselines reliably violate the constraint (1/1 in N=1). With it pre-fixed, single-agent has no incentive to step outside scope.

This means **swarm's structural enforcement is only valuable when the model is tempted to violate scope** — which depends on goal/repo combination.

### 7. Wall-clock surprise: Swarm-1 was *faster* than baseline
220 s vs 254 s avg. Plan stage was 90 s, run stage 130 s with 6 parallel workers. When the plan completes fast and tasks parallelize cleanly, swarm wins on wall-clock even at 6 tasks. Swarm-2's slower 308 s came from a 122 s plan (likely longer thinking) + 7 tasks instead of 6.

**Variance is high**: plan time alone went 90 s → 122 s between runs. With N=2 we cannot conclude on wall-clock; need N≥5.

## Verdict

| Dimension | Winner |
|---|---|
| Wall-clock (this N=2) | **Tie** (high variance) |
| Cost ($) | **Baseline** (~4× cheaper) |
| Test coverage | **Swarm** (6–27% more) |
| Constraint adherence | Tie (constraint not exercised) |
| Auditability (git history) | **Swarm** (only swarm produces named branches + merge commits) |
| Operational robustness | Swarm now stable after #2/#3 fixes |

**Decision**: still don't ship. The 4× cost regression is the blocker. Before next round:

**P0** (do before any more $-spending validation):
- Capture planner cost in events. Currently silent.
- Add `--session-id` resume so workers share the planner's KV-cache (estimated 30-50% cost cut).
- Pass `cfg.routing.worker_model` to the runner so cheaper models run for `risk_level: low` tasks.

**P1**:
- Run N≥5 for statistical signal on wall-clock.
- Test on a **scope-tempting** goal (one where baseline naturally needs to touch out-of-scope files) so boundary value shows up.

## Artifacts

- `sandbox/med-source/` — reference state (init commit only)
- `sandbox/med-baseline-1/`, `med-baseline-2/` — baseline results (working tree dirty, no commits)
- `sandbox/med-swarm-1/`, `med-swarm-2/` — swarm results (clean merge into `main`)
- `sandbox/med-baseline-1.jsonl`, `med-baseline-2.jsonl` — full stream-json logs
- `sandbox/med-swarm-1/.swarm/events.jsonl`, `med-swarm-2/.swarm/events.jsonl` — swarm event logs
- `sandbox/GOAL_MED.txt` — verbatim goal both runs received

## Caveats

- Swarm-1 cost is unmeasurable (bug #2 fixed for next run).
- Planner cost unmeasured for both swarm runs (P0 fix above).
- N=2 trial; meaningful conclusions need N≥5.
- Synthetic repo with perfectly-decomposable tasks; real repos have shared-state risks that swarm should handle better than baseline (untested here).
