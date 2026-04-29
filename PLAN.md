# swarm-cp PLAN

> **Mục tiêu**: hoàn thành MVP "Claude-native swarm orchestration control plane" theo định hướng `deep-research-report (1).md`, đến mức chạy được pilot trên repo thật và đo được uplift so với baseline.
>
> **Nguồn ngữ cảnh**:
> - `deep-research-report (1).md` — định hướng sản phẩm và backlog gốc.
> - `sandbox/REPORT.md` (N=1, 3 task) — cost/quality, phát hiện boundary enforcement.
> - `sandbox/REPORT_N2.md` (N=2, 6 task) — phát hiện cost gap 4×, bug PAGER, planner cost silent.

## 0. Tóm tắt hiện trạng (29/04/2026)

**Đã có**:
- Core CLI: `init`, `plan`, `run`, `status`, `merge`, `clean`. (`@/c:/Users/kisde/Desktop/raven/src/cli.ts`)
- Planner platform-aware (Win32/POSIX). (`@/c:/Users/kisde/Desktop/raven/src/planner.ts`)
- Worktree service + sanitized env (PAGER/GIT_ASKPASS strip). (`@/c:/Users/kisde/Desktop/raven/src/worktree.ts`)
- Quality gate 3-state outcome (passed/failed/skipped). (`@/c:/Users/kisde/Desktop/raven/src/gate.ts`)
- Event store JSONL + SQLite-shaped tables in code. (`@/c:/Users/kisde/Desktop/raven/src/store.ts`)
- Eval runner skeleton + baseline/swarm CSV/JSONL export. (`@/c:/Users/kisde/Desktop/raven/src/eval.ts`)
- Doctor command for environment/config/git preflight. (`@/c:/Users/kisde/Desktop/raven/src/doctor.ts`)
- Replay command for chronological event timeline + cost rollup. (`@/c:/Users/kisde/Desktop/raven/src/replay.ts`)
- Out-of-scope edit detection before task validation; tasks that edit outside `owned_files` become `needs_arbitration`. (`@/c:/Users/kisde/Desktop/raven/src/scope.ts`, `@/c:/Users/kisde/Desktop/raven/src/dispatcher.ts`)
- Stale-lock detection releases old claims, marks stale owner `needs_arbitration`, and lets pending work proceed. (`@/c:/Users/kisde/Desktop/raven/src/store.ts`, `@/c:/Users/kisde/Desktop/raven/src/dispatcher.ts`)
- Resume command recovers interrupted runs without re-running `done` tasks. (`@/c:/Users/kisde/Desktop/raven/src/run-control.ts`, `@/c:/Users/kisde/Desktop/raven/src/cli.ts`)
- Worker task sessions are persisted and passed to Claude Code via `--session-id`, enabling task-level session reuse on retry/resume. (`@/c:/Users/kisde/Desktop/raven/src/runner.ts`, `@/c:/Users/kisde/Desktop/raven/src/store.ts`, `@/c:/Users/kisde/Desktop/raven/src/dispatcher.ts`)
- Low-risk workers route through `routing.worker_model` with safe Claude Code alias mapping (`fast` → `sonnet`, `strong` → `opus`). (`@/c:/Users/kisde/Desktop/raven/src/dispatcher.ts`, `@/c:/Users/kisde/Desktop/raven/src/runner.ts`)
- Eval harness now resolves `--swarm-cli "node dist/cli.js"` relative to the caller repo, records failure stdout/stderr, and does not mark failed agent modes as OK just because fixture verification passes. (`@/c:/Users/kisde/Desktop/raven/src/eval.ts`)
- Claude runner and baseline eval retry transient 429/overload errors. (`@/c:/Users/kisde/Desktop/raven/src/runner.ts`, `@/c:/Users/kisde/Desktop/raven/src/eval.ts`)
- Regression eval suite now has 10 pinned `med-utils` goals with goal-specific verifier checks that fail on no-op fixture output. (`@/c:/Users/kisde/Desktop/raven/eval-suites/regression.yaml`, `@/c:/Users/kisde/Desktop/raven/eval-suites/goals/`, `@/c:/Users/kisde/Desktop/raven/fixtures/med-utils/scripts/verify-goal.cjs`)
- Eval smoke supports bounded timeout/retry env (`SWARM_EVAL_TIMEOUT_MS`, `SWARM_EVAL_MAX_RETRIES`) so transient API failures do not hang a run indefinitely. (`@/c:/Users/kisde/Desktop/raven/src/eval.ts`)
- 42 unit tests pass. (`@/c:/Users/kisde/Desktop/raven/src/smoke.test.ts`)
- 2 sandbox validations (N=1 & N=2) với cost/quality data.

**Khoảng trống lớn nhất** (theo report):
1. Hook bridge — không nhận `TaskCreated`/`SubagentStop`/`TeammateIdle` từ Claude Code lifecycle.
2. Eval runner — đã có skeleton + 10-goal suite, còn thiếu baseline data đủ tin cậy do Claude API 429.
3. Cost observability — planner cost silent; per-task cost lost on certain failure paths (đã fix một phần).

---

## 1. Định vị & guardrails

| Quyết định | Nội dung |
|---|---|
| **Positioning** | "Claude-native orchestration control plane" — bổ trợ Claude Code, không thay thế. |
| **Surface tương tác** | CLI + `.claude/` templates (giữ thói quen developer). |
| **Stack** | Node 22 + TS 5, Vitest, zod, commander, simple-git, execa. |
| **Persistence** | JSONL event log + in-memory derived state. SQLite migration sau. |
| **Cấp deploy MVP** | Local-first daemon. **Không** làm cloud manager trong scope này. |
| **Pháp lý** | Đi qua Anthropic API path; review Terms trước khi commercial release. |

---

## 2. Lộ trình theo phase

### Phase 1 — Đo được trước khi tối ưu (1-2 tuần)

**Lý do đi trước**: report cảnh báo "swarm không đo được thì khó chứng minh giá trị". Tất cả P0 tiếp theo cần data để justify.

| # | Task | Effort | Acceptance |
|---|---|---|---|
| 1.1 | **Capture planner cost** vào event log | 0.5d | ✅ `PlanCreated` event có `costUsd` field |
| 1.2 | **`swarm eval` command** + JSON/CSV export | 3d | ✅ Chạy được suite (list of goals + repo states) → CSV với cost/wall/tests/gate metrics |
| 1.3 | **Baseline harness** (single-Claude vs swarm trên cùng 1 goal+repo) | 2d | ✅ `swarm eval` chạy side-by-side `baseline` + `swarm` modes |
| 1.4 | **Replay timeline render** (CLI text view, không cần web UI) | 1.5d | ✅ `swarm replay <runId>` in chronological event timeline với cost rollup |
| 1.5 | **Doctor command** (config/permissions/git worktree health) | 1d | ✅ `swarm doctor` exit non-zero nếu setup không OK |

**Deliverable Phase 1**: ✅ benchmark suite ≥10 goal trên repo fixture đã có; CSV output đã có; baseline data thật còn chờ Claude API hết 429.

### Phase 2 — Đóng các gap value-prop (2-3 tuần)

**Lý do đi sau Phase 1**: từng cái cần baseline để đo trước/sau.

| # | Task | Effort | Acceptance |
|---|---|---|---|
| 2.1 | **Out-of-scope edit detection** (validation gate) | 2-3d | ✅ Diff worker patch vs `owned_files`; nếu lệch → task → `needs_arbitration`. Test bằng inject 1 task cố tình đụng `package.json`. |
| 2.2 | **Stale-lock detection + arbitration trigger** | 2d | ✅ Worker timeout/crash → claim auto-released sau N giây; surface `ArbitrationRequested` event. |
| 2.3 | **`swarm resume <runId>`** — recover từ events.jsonl | 2-3d | ✅ Kill `swarm run` mid-flight → `swarm resume` tiếp tục đúng DAG state, không re-run task đã `done`. |
| 2.4 | **Session resume cho workers** (`--session-id` hoặc Agent SDK) | 3-4d | Implementation ✅; eval pending: reduce per-worker prefill cost ≥30% vs Phase 1 baseline. |
| 2.5 | **Routing → worker model** (cfg `routing.worker_model: fast`) | 1d | Implementation ✅; eval pending: worker dùng cheap model cho `risk_level: low`; eval cho thấy cost giảm ≥20% trên low-risk tasks. |

**Deliverable Phase 2**: cost gap baseline-vs-swarm thu hẹp xuống ≤2× (từ 4× hiện tại), boundary enforcement chứng minh được trên goal "scope-tempting".

### Phase 3 — CLI stream hook bridge (2 tuần)

**Lý do đi cuối**: cần baseline Phase 1/2 trước để justify thêm observability. Quyết định mới: giữ local CLI-first; **không migrate SDK trong đường chính**. Dùng `claude -p --output-format stream-json --include-hook-events` trước, chỉ fallback sang SDK nếu CLI stream không đủ lifecycle data.

| # | Task | Effort | Acceptance |
|---|---|---|---|
| 3.1 | **Enable CLI hook stream** — add `--include-hook-events` to runner | 1d | ✅ Stream parser receives hook/system lifecycle events without changing subprocess architecture. |
| 3.2 | **Normalize lifecycle events** — map stream events into store | 3-4d | ✅ Events normalized vào event store; replay diff trước/sau cho thấy thêm thông tin lifecycle. |
| 3.3 | **CLI worktree parity review** | 1-2d | ✅ Decision: manual git worktree is sufficient. Doctor checks added. No migration needed. |
| 3.4 | **Pre-merge hook** (cho phép arbitration trước merge) | 1.5d | ✅ `swarm merge` chạy hook custom via `pre_merge_hook` config; reject merge nếu hook fail. |

**Deliverable Phase 3**: ✅ parity với report's "Hook Bridge" component bằng CLI stream; 6 lifecycle event types normalized; pre-merge hook gate; 56 tests pass.

### Phase 4 — Pilot + benchmark (2 tuần)

| # | Task | Effort | Acceptance |
|---|---|---|---|
| 4.1 | **SWE-bench Verified harness** subset 20-50 instances | 4-5d | ✅ `swebench.ts` adapter + 20 curated instances + `swarm swebench` CLI command. |
| 4.2 | **Multi-SWE-bench mini** subset (TS/JS/Go) | 2-3d | ✅ ts-utils + go-utils fixtures + `multilang.yaml` suite (7 entries). |
| 4.3 | **Internal "scope-tempting" suite** (10 fixture goals có khả năng tempt single-agent vi phạm scope) | 2d | ✅ 10 goals in `scope-tempting.yaml`; each tempts a different violation pattern. |
| 4.4 | **Pilot trên 2-3 repo thật** (volunteer projects) | 3-5d | ✅ `pilot.ts` + `swarm pilot` command generates PILOT_REPORT.md with go/no-go decision. |
| 4.5 | **Documentation** (README, examples, migration guide) | 3d | ✅ Complete README with Quick Start (≤15 min), migration guide, all commands, architecture. |

**Deliverable Phase 4**: ✅ Infrastructure complete — `swarm pilot`, `swarm swebench`, scope-tempting suite, multilang fixtures, full documentation. Ready for data collection runs.

---

## 3. Acceptance criteria toàn cục

Theo report, MVP "đạt" khi:

| Tiêu chí | Cách đo | Target |
|---|---|---|
| Task graph hợp lệ | Schema validation | 100% task có `depends_on`+`owned_files`+`acceptance_checks` |
| Conflict handling | Out-of-scope edit detection rate | ≥95% trên scope-tempting suite |
| Resume | Kill-and-resume integration test | 100% tasks recover state |
| Quality gate | Tasks marked `done` mà không qua gate | 0 |
| Replay | Run với `swarm replay` ra timeline+cost | 100% |
| Least privilege | `permissions.deny` default trong `swarm init` | ✅ (đã có) |
| Observability | Cost cho **plan + workers + gate** trong event log | 100% |
| **Uplift vs baseline** | Cost gap | ≤2× sau Phase 2 |
| **Uplift vs baseline** | Quality (test count, resolved issue rate) | ≥10% better |
| **Uplift vs baseline** | Wall-clock | tie hoặc ±15% |

---

## 4. Rủi ro & mitigation

| Rủi ro | Mitigation |
|---|---|
| **Cost gap không thu hẹp đủ** sau Phase 2 | Thêm Phase 2.6: shared session prefix; nếu vẫn fail, downgrade scope thành "swarm là quality/audit win, không phải speed/cost win". |
| **CLI hook events không đủ rich** từ Claude Code | Fallback: spike `@anthropic-ai/claude-agent-sdk` trên branch riêng; chỉ migrate nếu chứng minh CLI thiếu dữ liệu bắt buộc. |
| **SWE-bench infra phức tạp** | Phase 4.1 chỉ subset 20 instance; nếu quá khó setup Docker harness, dùng curated 10 issue thay thế. |
| **Pháp lý** (Terms positioning) | Review trước Phase 4.4 (pilot bên ngoài). Trước đó ổn vì internal-only. |

---

## 5. Việc KHÔNG làm trong scope này

Theo report, postpone đến sau MVP:

- ❌ **Cloud-hosted manager** — chỉ làm sau khi local middleware chứng minh PMF.
- ❌ **Memory layer** (Pensyve-style cross-session) — sau MVP.
- ❌ **Policy DSL** (CEL/Rego-lite) — sau MVP.
- ❌ **Web UI** — Phase 1.4 chỉ làm CLI replay; web UI postpone.
- ❌ **Multi-tenant / RBAC** — purely cloud concern.
- ❌ **AFlow-style auto-optimize policy** — research direction, không phải MVP.

---

## 6. Timeline tổng

| Phase | Tuần | Mốc |
|---|---|---|
| Phase 1 — Measurement | T1-T2 | Eval harness + baseline data |
| Phase 2 — Value-prop gaps | T3-T5 | Cost gap ≤2×, boundary enforcement chứng minh được |
| Phase 3 — CLI stream hooks | T6-T7 | Lifecycle parity với Claude Code |
| Phase 4 — Pilot + benchmark | T8-T9 | go/no-go report |
| **Tổng MVP completion** | **~9 tuần** | Dùng được pilot |

Ước lượng này **giả định 1 engineer full-time**. Với 2 engineer, có thể nén còn ~6 tuần (tương đồng report's 6-8 tuần với 2 engineer + part-time PM).

---

## 7. Next action ngay (immediate)

3 việc làm tiếp trong tuần này, không cần thêm input:

1. **Chạy lại eval đo Phase 2.4/2.5 khi Claude API hết 429** — smoke 1-goal ngày 29/04/2026 xác nhận baseline đang nhận `api_retry ... error_status:429`; swarm planner timed out trước khi có runId.
2. **Nếu eval vẫn cost=0** — inspect Claude stream schema for cost metadata and update parser/event rollup.
3. **Sau khi có baseline data thật** — demo Phase 1/2 và quyết định có sang Phase 3 CLI stream hook bridge không.

Sau đó dừng để demo + decision với stakeholder trước khi kick off Phase 2 (vì Phase 2 là phase đốt nhiều thời gian + cost nhất).
