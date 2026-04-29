# swarm-cp validation: baseline vs swarm on synthetic Express API

**Date**: 2026-04-29
**Workload**: 3 independent route files (`users`, `posts`, `health`); each needs JSDoc on exported funcs + corresponding `tests/<route>.test.js` using `node:test`.
**Constraint** (in goal text): "Do not modify any file outside `src/routes/` and `tests/`."
**Hardware/runtime**: Windows 11, pwsh, Node 22.22.1, Claude Code 2.1.105 (`glm-5.1`).

## Setup

Two identical clones from `sandbox/api-source/` (1 init commit):
- `api-baseline/` — single `claude -p "<goal>" --output-format stream-json --verbose --dangerously-skip-permissions`
- `api-swarm/` — `swarm init` → `plan` → `run` (parallelism=3)

## Headline metrics

| Metric | Baseline | Swarm | Δ |
|---|---|---|---|
| **Wall-clock** | 141.3 s | 163.9 s (plan 46.7 + run 117.2) | **+16% slower** |
| **Cost (USD)** | $0.7855 | ~$1.6 *est.* | **~+100% more expensive** |
| **Turns** | 20 (single agent) | ~3 × ~6 turns (per worker) + planner | — |
| **`npm test` pass after merge** | 6/6 | 11/11 | swarm wrote more tests |
| **Out-of-scope edits** | 1 (`package.json`) | **0** | swarm respected boundary |
| **Auto-committed** | no (working tree only) | yes (per task + merge commits) | swarm gives audit trail |

## Detailed findings

### 1. Swarm was slower for this workload
Wall-clock breakdown for swarm:
- Planner: **47 s** (cold start + reasoning over 3-file repo)
- 3 workers in parallel: **117 s** wall (each took ~110-115 s)

Even with 3 workers running concurrently, planning overhead (~47 s) is the bulk of the regression. Single-Claude baseline took 141 s for the entire workload sequentially.

**Implication**: swarm-cp is **not** a win for trivially-decomposable workloads with ≤3 small tasks. Planning overhead amortizes only when:
- task count > 3-5, OR
- per-task work is large (turns ≫ 5), OR
- tasks would otherwise contend (real merge conflicts).

### 2. Baseline silently violated the scope constraint
The original `package.json` had `"test": "node --test tests/"` which is broken on Windows when `tests/` has files (Node tries to resolve it as a module, errors). Baseline's single agent **modified `package.json`** to fix it:
```diff
-    "test": "node --test tests/"
+    "test": "node --test tests/*.test.js"
```
This is **explicitly out-of-scope** per the goal. Baseline had no mechanism to detect or block this.

Swarm-cp's per-task `owned_files` declaration prevented every worker from touching `package.json`; as a result, swarm produced more correct adherence to the goal at the cost of a non-functional `npm test` script (which we patched manually post-merge to verify quality).

This is **swarm's strongest demonstrated value-add** in this experiment: structural enforcement of edit boundaries, which the model alone cannot guarantee.

### 3. Swarm wrote more comprehensive tests
- Baseline: **6 tests** (~2 per route file)
- Swarm: **11 tests** (~3-4 per route file)

Hypothesis: each worker is given **only one route's worth of context**, so it spends its turns on that route alone, producing denser test coverage. The single agent had to amortize attention across 3 routes + the README + figuring out the test runner.

### 4. Quality gate is brittle on Windows
The planner generated `acceptance_checks` like:
```bash
node --test tests/users.test.js          # ✓ exit 0 on Windows
grep -c '@param\|@returns' src/routes/users.js   # ✗ exit 255 on Windows pwsh (no grep)
```
All 3 task gates failed solely on the `grep` check — workers had completed correctly. This caused `done=0 failed=3` despite perfect outputs.

**Real bugs surfaced by this run** (with fix priority):
1. **High**: planner prompt should include host platform; or check command should use Node-only utilities. *Fix candidate*: inject `Platform: win32` into architect prompt and bias toward `node`/`findstr`/POSIX-portable shells.
2. **Medium**: gate should distinguish `command not found` (exit 127/255/9009) from actual check failure (exit 1/2). Treat the former as a tooling error, not a quality fail.
3. **Done in this session**: dispatcher now persists worker `costUsd` even on `gate_failed`, so total spend is auditable regardless of gate outcome.

### 5. Auto-commit + branch topology worked perfectly
3 worker branches, 3 merge commits, 0 conflicts:
```
*   d1b11a6 (HEAD -> main) merge T3
|\
| * 67d4af6 swarm: T3-health-jsdoc-test
*   26293da merge T2
|\
| * 00bd7ed swarm: T2-posts-jsdoc-test
*   3f730c5 merge T1
|\
| * 17bc94a swarm: T1-users-jsdoc-test
|/
* c1749cd init
```
Baseline produced **zero git history** of the work — entire change set was a dirty working tree. For collaborative review or rollback, swarm's per-task commit + named branch is materially better.

## Verdict

| Dimension | Winner |
|---|---|
| Speed (wall-clock) | **Baseline** |
| Cost ($) | **Baseline** |
| Constraint adherence | **Swarm** |
| Test coverage | **Swarm** |
| Auditability (git history) | **Swarm** |
| Operational robustness | Baseline (swarm gate broke on Windows tooling) |

For **3 trivial parallelizable tasks**, **swarm is not yet a win** in raw speed/cost. It earns its keep on **boundary enforcement and audit trail**, which scale with team size and review burden, not task count.

**This validation does not justify shipping yet.** It does justify:
- Running the same experiment with **8-15 tasks on a real medium repo** before further investment.
- Fixing the platform-aware gate (P1).
- Reducing planner overhead (P2): the 47 s plan stage is most of the regression.

## Artifacts

- `sandbox/api-source/` — reference state
- `sandbox/api-baseline/` — single-agent result (with disallowed `package.json` edit)
- `sandbox/api-swarm/` — swarm result (clean merge into `main`)
- `sandbox/baseline-stream.jsonl` — full baseline stream-json log (cost, turns)
- `sandbox/api-swarm/.swarm/events.jsonl` — swarm event log
- `sandbox/GOAL.txt` — verbatim goal both runs received

## Caveats

- **Cost for swarm is estimated** (~$1.6) because the original dispatcher dropped per-task cost when the gate failed. Fixed in this session — the next run will have exact numbers.
- N=1 trial. Variance across runs (esp. baseline turns 20 — wide) is unmeasured.
- Synthetic repo. Real codebases may shift the ratio (more conflicts → swarm gains; trivial → baseline gains).
