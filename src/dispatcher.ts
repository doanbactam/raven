import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { ClaudeRunner, type RunOptions, type HookEvent } from "./runner.js";
import { normalizeHookEvents } from "./hooks.js";
import { WorktreeService } from "./worktree.js";
import { SwarmStore } from "./store.js";
import { runAcceptanceChecks } from "./gate.js";
import { checkOwnedFileScope } from "./scope.js";
import type { SwarmConfig, Task } from "./schema.js";

export const DEFAULT_STALE_CLAIM_MS = 30 * 60_000;

export interface DispatcherDeps {
  runner: ClaudeRunner;
  worktrees: WorktreeService;
  store: SwarmStore;
  cfg: SwarmConfig;
  rootDir: string;
}

export class Dispatcher {
  constructor(private deps: DispatcherDeps) {}

  /**
   * Wave-based execution:
   * 1. Tìm các task `pending` mà tất cả `depends_on` đã `done`.
   * 2. Cố gắng claim ownership; nếu fail vì conflict → giữ pending, thử wave sau.
   * 3. Spawn worker song song (giới hạn parallelism).
   * 4. Lặp đến khi không còn task pending hoặc không có progress (deadlock).
   */
  async run(runId: string): Promise<{ done: number; failed: number; blocked: number }> {
    const { store, cfg } = this.deps;
    const queue = new PQueue({ concurrency: cfg.parallelism });
    let done = 0;
    let failed = 0;

    while (true) {
      this.releaseStaleClaims(runId);
      const all = store.listTasks(runId);
      const remaining = all.filter((t) => t.status === "pending");
      if (remaining.length === 0) break;

      const ready = remaining.filter((t) =>
        t.depends_on.every((dep) => all.find((x) => x.id === dep)?.status === "done"),
      );
      if (ready.length === 0) break; // deadlock or all blocked by failure

      const claimed: typeof ready = [];
      for (const t of ready) {
        const ok = store.tryClaim(runId, t.id, t.owned_files, t.owned_symbols);
        if (ok) {
          claimed.push(t);
          store.setTaskStatus(runId, t.id, "running");
        }
        // else: ownership conflict với task khác đang chạy — chờ wave sau.
      }
      if (claimed.length === 0) {
        // Không claim được task nào trong wave này → deadlock soft, dừng.
        break;
      }

      await Promise.all(
        claimed.map((t) =>
          queue.add(async () => {
            const ok = await this.executeTask(runId, t);
            if (ok) done++;
            else failed++;
          }),
        ),
      );
    }

    const all = store.listTasks(runId);
    const blocked = all.filter((t) => t.status === "pending").length;
    return {
      done: Math.max(done, all.filter((t) => t.status === "done").length),
      failed: Math.max(
        failed,
        all.filter((t) => t.status === "failed" || t.status === "needs_arbitration").length,
      ),
      blocked,
    };
  }

  private releaseStaleClaims(runId: string): void {
    const { store } = this.deps;
    const cutoff = new Date(Date.now() - DEFAULT_STALE_CLAIM_MS).toISOString();
    const stale = store.releaseStaleClaims(runId, cutoff);
    const staleTaskIds = new Set(stale.map((claim) => claim.task_id));
    for (const taskId of staleTaskIds) {
      store.setTaskStatus(runId, taskId, "needs_arbitration");
    }
    for (const claim of stale) {
      store.appendEvent({
        run_id: runId,
        task_id: claim.task_id,
        type: "ArbitrationRequested",
        ts: new Date().toISOString(),
        payload: {
          reason: "stale_lock_released",
          path: claim.path,
          kind: claim.kind,
          claimedAt: claim.claimed_at,
          timeoutMs: DEFAULT_STALE_CLAIM_MS,
        },
      });
    }
  }

  private async executeTask(runId: string, t: Task): Promise<boolean> {
    const { runner, worktrees, store, cfg } = this.deps;
    let wt: string | null = null;
    let lastCostUsd: number | undefined;
    try {
      wt = await worktrees.create(runId, t.id);
      store.setTaskStatus(runId, t.id, "running", wt);
      store.appendEvent({
        run_id: runId,
        task_id: t.id,
        type: "WorktreeOpened",
        ts: new Date().toISOString(),
        payload: { path: wt },
      });

      const prompt = buildWorkerPrompt(t, cfg);
      const sessionId = store.getTaskSessionId(runId, t.id) ?? randomUUID();
      const model = workerModelForTask(t, cfg);
      store.setTaskSessionId(runId, t.id, sessionId);
      store.appendEvent({
        run_id: runId,
        task_id: t.id,
        type: "AgentStarted",
        ts: new Date().toISOString(),
        payload: { sessionId, model: model ?? "default" },
      });
      const runOptions: RunOptions = {
        cwd: wt,
        prompt,
        allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
        // Worktree is isolated; safe to bypass interactive prompts.
        dangerouslySkipPermissions: true,
        sessionId,
        includeHookEvents: true,
      };
      if (model) runOptions.model = model;
      const res = await runner.run(runOptions);
      lastCostUsd = res.costUsd;
      if (res.sessionId && res.sessionId !== sessionId) {
        store.setTaskSessionId(runId, t.id, res.sessionId);
      }

      // Phase 3: persist lifecycle hook events captured from --include-hook-events.
      if (res.hookEvents && res.hookEvents.length > 0) {
        const normalized = normalizeHookEvents(res.hookEvents, { runId, taskId: t.id });
        for (const ev of normalized) store.appendEvent(ev);
      }

      if (res.exitCode !== 0) {
        store.setTaskStatus(runId, t.id, "failed");
        store.appendEvent({
          run_id: runId,
          task_id: t.id,
          type: "TaskFailed",
          ts: new Date().toISOString(),
          payload: { exitCode: res.exitCode, stderr: res.stderr.slice(0, 4000) },
        });
        return false;
      }

      const scope = checkOwnedFileScope(await worktrees.changedFiles(wt), t.owned_files);
      if (!scope.passed) {
        store.setTaskStatus(runId, t.id, "needs_arbitration");
        store.appendEvent({
          run_id: runId,
          task_id: t.id,
          type: "ArbitrationRequested",
          ts: new Date().toISOString(),
          payload: {
            reason: "out_of_scope_edit",
            ownedFiles: t.owned_files,
            changedFiles: scope.changedFiles,
            outOfScopeFiles: scope.outOfScopeFiles,
            costUsd: res.costUsd ?? 0,
          },
        });
        return false;
      }

      // Quality gate: run acceptance_checks locally in the worktree.
      // Skipped silently when the planner produced none; warn so this is visible.
      let gatePassed = true;
      if (t.acceptance_checks.length > 0) {
        const verdict = await runAcceptanceChecks(wt, t.acceptance_checks);
        gatePassed = verdict.passed;
        store.appendEvent({
          run_id: runId,
          task_id: t.id,
          type: gatePassed ? "GatePassed" : "GateFailed",
          ts: new Date().toISOString(),
          payload: {
            results: verdict.results.map((r) => ({
              command: r.command,
              outcome: r.outcome,
              exitCode: r.exitCode,
            })),
            skipped: verdict.results.filter((r) => r.outcome === "skipped").length,
          },
        });
      }

      if (!gatePassed) {
        store.setTaskStatus(runId, t.id, "failed");
        // Persist cost even on gate fail so total spend is auditable.
        store.appendEvent({
          run_id: runId,
          task_id: t.id,
          type: "TaskFailed",
          ts: new Date().toISOString(),
          payload: {
            reason: "gate_failed",
            costUsd: res.costUsd ?? 0,
            finalMessage: res.finalMessage?.slice(0, 1000) ?? "",
          },
        });
        return false;
      }

      // Auto-commit worker changes so `swarm merge` has something to merge.
      await worktrees.commitAll(wt, `swarm: ${t.id} — ${t.summary}`);

      store.setTaskStatus(runId, t.id, "done");
      store.appendEvent({
        run_id: runId,
        task_id: t.id,
        type: "TaskValidated",
        ts: new Date().toISOString(),
        payload: {
          finalMessage: res.finalMessage?.slice(0, 2000) ?? "",
          costUsd: res.costUsd ?? 0,
          sessionId: res.sessionId ?? sessionId,
        },
      });
      return true;
    } catch (err) {
      store.setTaskStatus(runId, t.id, "failed");
      store.appendEvent({
        run_id: runId,
        task_id: t.id,
        type: "TaskFailed",
        ts: new Date().toISOString(),
        payload: {
          error: (err as Error).message,
          // Carry through worker cost if it had completed before the throw,
          // so total spend stays auditable even on post-worker failures.
          costUsd: lastCostUsd ?? 0,
        },
      });
      return false;
    } finally {
      store.releaseClaims(runId, t.id);
      // Worktree giữ lại để debug; cleanup tách bạch qua `swarm clean`.
    }
  }
}

function buildWorkerPrompt(t: Task, cfg: SwarmConfig): string {
  return [
    `Use the @${cfg.worker} subagent.`,
    ``,
    `Task ID: ${t.id}`,
    `Summary: ${t.summary}`,
    ``,
    `Ownership boundary (DO NOT edit files outside this list):`,
    `Files: ${JSON.stringify(t.owned_files)}`,
    `Symbols: ${JSON.stringify(t.owned_symbols)}`,
    ``,
    `Acceptance checks (must all pass):`,
    ...t.acceptance_checks.map((c) => `- ${c}`),
    ``,
    `If you must touch anything outside ownership, STOP and output exactly: NEEDS_ARBITRATION`,
    `When done, output a short JSON summary with files_touched and decision_log.`,
  ].join("\n");
}

export function workerModelForTask(t: Task, cfg: SwarmConfig): string | undefined {
  if (t.risk_level !== "low") return undefined;
  return resolveClaudeModelAlias(cfg.routing.worker_model);
}

export function resolveClaudeModelAlias(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (trimmed === "fast") return "sonnet";
  if (trimmed === "strong") return "opus";
  return trimmed;
}
