# swarm-cp

**Claude-native swarm orchestration control plane** — a local-first CLI that decomposes complex goals into parallel, isolated Claude Code worker tasks with dependency-aware scheduling, scope enforcement, and quality gates.

## What it does

`swarm-cp` sits on top of the `claude` CLI (Claude Code) and provides:

- **Task DAG planning** — an architect agent decomposes your goal into a dependency-ordered graph
- **File ownership claims** — each task declares which files it owns; conflicts are detected atomically
- **Git worktree isolation** — each worker runs in its own worktree branch, preventing interference
- **Scope enforcement** — out-of-scope edits are detected and escalated to arbitration
- **Quality gates** — acceptance checks run in-worktree before marking tasks done
- **Event-sourced state** — SQLite + JSONL replay log for full observability
- **Lifecycle hook bridge** — captures Claude Code's internal events (tool use, subagent lifecycle)
- **Pre-merge hooks** — custom validation before branches merge into main
- **Model routing** — route low-risk tasks to cheaper models automatically
- **Resume** — interrupted runs recover gracefully; stale claims are released

It does **not** reimplement the agent loop. It spawns the `claude` CLI as a subprocess.

## Prerequisites

- **Node.js 22+**
- **Git 2.20+** (worktree support)
- **Claude CLI** installed and authenticated (`claude --version` must work)

## Quick Start (≤15 minutes)

```bash
# 1. Install swarm-cp
git clone <this-repo> && cd swarm-cp
npm install
npm run build
npm link          # exposes `swarm` globally

# 2. Initialize your target repo
cd /path/to/your/repo
swarm init        # scaffolds .claude/agents/, swarm.yaml, .swarm/

# 3. Edit swarm.yaml — set your goal
#    goal: "Add comprehensive test coverage for all modules"
#    parallelism: 4

# 4. Plan → Run → Merge
swarm doctor      # verify environment is ready
swarm plan        # architect decomposes goal → prints RUN_ID
swarm run <RUN_ID>
swarm status <RUN_ID>
swarm merge <RUN_ID>

# 5. Review
swarm replay <RUN_ID>    # timeline of all events + cost
```

## Commands

| Command | Description |
|---------|-------------|
| `swarm init` | Scaffold config files and agent templates |
| `swarm plan` | Decompose goal into task DAG via architect agent |
| `swarm run <id>` | Execute pending tasks with parallel workers |
| `swarm resume <id>` | Resume an interrupted run |
| `swarm status <id>` | Show task statuses for a run |
| `swarm status <id> --json` | Show task statuses for automation |
| `swarm replay <id>` | Show event timeline with costs |
| `swarm merge <id>` | Merge done branches in topological order |
| `swarm clean <id>` | Remove worktrees for a run |
| `swarm gc --older-than-hours 24` | Garbage-collect old swarm worktrees |
| `swarm doctor` | Pre-flight environment checks |
| `swarm tui` | Open the interactive terminal control plane |
| `swarm ui` | Open the local web control plane |
| `swarm eval <suite>` | Run eval suite (baseline vs swarm) |
| `swarm swebench <suite>` | Run SWE-bench harness |
| `swarm pilot <suite>` | Generate go/no-go PILOT_REPORT.md |

## Terminal Control Plane

Run `swarm tui` or `npm run tui` to operate swarm-cp without editing YAML by hand.

| Input | Action |
|-------|--------|
| type or paste text | Start a request in the composer |
| `Enter` | Create a plan from the current request |
| `/run` | Confirm and run the selected plan |
| `/resume` | Continue an interrupted selected run |
| `/runs` | Show recent plans and move between them with `j`/`k` or arrows |
| `/tasks` | Show the generated task plan |
| `/replay` | Show the run timeline |
| `/env` | Show environment checks |
| `/settings` | Edit `parallelism` and `budget_usd` |
| `/refresh` | Reload local state |
| `/help` | Show the command reference in the transcript |
| `/init` | Scaffold swarm config in the current repo |
| `/new` | Return to the request-first guide |
| `/clear` | Clear shell output and return to the guide |
| `@path/to/file` | Attach a file snippet to the next plan prompt |
| `!command` | Run a shell command from the TUI and show the output |
| `Up` / `Down` | Recall previous prompts while editing |
| `q` | Quit when the composer is not focused |

Power-user aliases still work: `1` focuses the prompt, `2` runs, `3` toggles tasks/replay, `4` edits settings, `5` refreshes, `l` opens the run list, `d` opens environment checks, `j`/`k` or arrows move between runs, `Ctrl+P` plans with the saved `swarm.yaml` goal, and `i` initializes project scaffolding.

## Configuration (`swarm.yaml`)

```yaml
version: "0.1"
goal: |
  Describe your goal here. The architect agent will decompose it.
parallelism: 4

policies:
  same_file: block
  same_symbol: ask
  out_of_scope_edit: fail
  tests_required: true
  security_scan_required: false

routing:
  plan_model: strong      # model for the architect/planner
  worker_model: fast      # model for low-risk workers
  gate_model: strong      # model for quality gate checks

runtime:
  worker_timeout_ms: 1800000
  stale_claim_ms: 1800000

# Optional: shell command(s) run before each task branch merges.
# Exit non-zero to reject the merge.
pre_merge_hook: "npm test"
# Or multiple:
# pre_merge_hook:
#   - "npm run lint"
#   - "npm test"
```

## Architecture

```
src/
  cli.ts          Commander entry point (all subcommands)
  init.ts         Scaffold .claude/agents, settings.json, swarm.yaml
  config.ts       Load + validate swarm.yaml via Zod
  schema.ts       Task, Plan, Event, SwarmConfig Zod schemas
  store.ts        SQLite (runs, tasks, claims) + JSONL event log
  worktree.ts     Git worktree create/remove/commit/merge (simple-git)
  runner.ts       Claude CLI wrapper (stream-json + hook events)
  planner.ts      Architect subagent → JSON task DAG
  dispatcher.ts   Wave scheduler + ownership + parallel spawn + hook normalization
  gate.ts         Acceptance check runner (shell commands)
  scope.ts        Owned-file boundary enforcement
  hooks.ts        Normalize Claude Code lifecycle events → event store
  merge-hook.ts   Pre-merge hook runner
  run-control.ts  Run orchestration + resume logic
  replay.ts       Event timeline formatter
  pilot.ts        Pilot report generator (go/no-go decision)
  swebench.ts     SWE-bench Verified harness adapter
  eval.ts         Eval suite runner (baseline vs swarm)
  doctor.ts       Environment health checks
```

## Event Types

The event store captures:

| Category | Events |
|----------|--------|
| **Core lifecycle** | PlanCreated, TaskClaimed, TaskReleased, AgentStarted, AgentStopped |
| **Planning resilience** | PlanFailed, PlanFallbackUsed |
| **Workspace** | WorktreeOpened, WorktreeClosed |
| **Outcomes** | PatchProposed, TaskValidated, TaskFailed, GateFailed, GatePassed |
| **Escalation** | ArbitrationRequested, RunCompleted |
| **Hook bridge** | HookPreToolUse, HookPostToolUse, HookSubagentStart, HookSubagentStop, HookNotification, HookStop |

## Eval & Benchmarks

Three eval suites are included:

1. **`eval-suites/regression.yaml`** — 10 entries on the `med-utils` fixture (JS)
2. **`eval-suites/multilang.yaml`** — 7 entries across TypeScript, JavaScript, and Go
3. **`eval-suites/scope-tempting.yaml`** — 10 goals that tempt scope violations (detection target: ≥95%)
4. **`eval-suites/swebench-verified.yaml`** — 20 curated SWE-bench instances (Python)

```bash
# Run regression suite
swarm eval eval-suites/regression.yaml --swarm-cli "node dist/cli.js"

# Run scope-tempting suite
swarm eval eval-suites/scope-tempting.yaml --swarm-cli "node dist/cli.js"

# Generate pilot report
swarm pilot eval-suites/regression.yaml --out PILOT_REPORT.md
```

Eval CSV output includes `cost_measured` and `success` columns so missing Claude
cost metadata is visible instead of being silently treated as a real `$0.0000`.

## Production Defaults

- Planner output is retried up to 2 times with schema feedback.
- Set `SWARM_PLANNER_MAX_ATTEMPTS=N` to tune planner retries. Eval defaults to `1` to avoid wasting runs when a backend does not follow JSON format.
- If structured planning still fails, swarm-cp infers per-file fallback tasks from files/modules named in the goal and records `PlanFallbackUsed`.
- If no target files can be inferred, swarm-cp falls back to one conservative high-risk task.
- Set `SWARM_PLANNER_STRICT=1` to disable fallback and fail fast when planner JSON is invalid.
- Worker and stale-claim timeouts live under `runtime` in `swarm.yaml`.
- `status`, `history`, and `gc` support JSON output for scripts and CI wrappers.
- Cost extraction reads both stdout and stderr and supports JSON stream output plus log-style `total_cost_usd: 0.123`.
- Replay surfaces fallback planning in the event timeline.

## Migration Guide

### From single-Claude to swarm-cp

1. **No code changes needed** — swarm-cp works alongside your existing repo
2. Run `swarm init` to scaffold the config
3. Edit `swarm.yaml` with your goal
4. The architect agent handles task decomposition automatically
5. Workers use the same tools/permissions as your existing Claude Code setup

### Key differences from single-agent

| Aspect | Single Claude | swarm-cp |
|--------|--------------|----------|
| Scope | Whole repo | Per-task file ownership |
| Isolation | Shared branch | Per-task worktree |
| Parallelism | Sequential | Configurable (1-N) |
| Cost tracking | Manual | Automatic per-task + total |
| Resume | Start over | Automatic state recovery |
| Quality | Trust agent | Gate checks per task |

### Configuration tips

- Start with `parallelism: 2` and increase after confirming stability
- Use `pre_merge_hook: "npm test"` to catch integration issues early
- Set `routing.worker_model: fast` for cost savings on low-risk tasks
- Run `swarm doctor` before first use to verify your environment

## Development

```bash
npm install
npm run build         # TypeScript → dist/
npm run tui           # Ink terminal control plane
npm run ui            # local web control plane
npm test              # vitest (79+ tests)
npm run typecheck     # tsc --noEmit
```

## Go/No-Go Criteria (from PLAN.md)

| Criterion | Target |
|-----------|--------|
| Cost gap (swarm/baseline) | ≤2× |
| Quality uplift | ≥10% |
| Wall-clock delta | ±15% |
| Scope violation detection | ≥95% |
| Resume recovery | 100% |
| Gate enforcement | 0 unvalidated "done" tasks |

## License

Private — pending positioning + Anthropic Terms review.
