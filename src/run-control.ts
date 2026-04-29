import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { ClaudeRunner } from "./runner.js";
import { SwarmStore } from "./store.js";
import { WorktreeService } from "./worktree.js";

export interface RunSummary {
  done: number;
  failed: number;
  blocked: number;
}

export interface ExecuteRunResult {
  summary: RunSummary;
  recoveredRunning: number;
}

export interface ExecuteRunOptions {
  resumed?: boolean;
  runner?: ClaudeRunner;
  worktrees?: WorktreeService;
}

export async function executeRun(
  rootDir: string,
  runId: string,
  opts: ExecuteRunOptions = {},
): Promise<ExecuteRunResult> {
  const cwd = resolve(rootDir);
  const cfg = await loadConfig(cwd);
  const store = new SwarmStore(cwd);
  try {
    if (!store.getRun(runId)) throw new Error(`No run found: ${runId}`);
    const tasks = store.listTasks(runId);
    if (tasks.length === 0) throw new Error(`No tasks for run: ${runId}`);

    const recoveredRunning = opts.resumed ? recoverRunningTasksForResume(store, runId) : 0;
    const runner = opts.runner ?? new ClaudeRunner();
    const worktrees = opts.worktrees ?? new WorktreeService(cwd);
    const dispatcher = new Dispatcher({ runner, worktrees, store, cfg, rootDir: cwd });

    store.setRunStatus(runId, "running");
    const summary = await dispatcher.run(runId);
    store.setRunStatus(runId, summary.failed > 0 || summary.blocked > 0 ? "incomplete" : "done");
    store.appendEvent({
      run_id: runId,
      type: "RunCompleted",
      ts: new Date().toISOString(),
      payload: { ...summary, resumed: opts.resumed === true },
    });
    return { summary, recoveredRunning };
  } finally {
    store.close();
  }
}

export function recoverRunningTasksForResume(store: SwarmStore, runId: string): number {
  const claimsByTask = new Set(store.listClaims(runId).map((claim) => claim.task_id));
  let recovered = 0;
  for (const task of store.listTasks(runId)) {
    if (task.status !== "running") continue;
    if (claimsByTask.has(task.id)) continue;
    store.setTaskStatus(runId, task.id, "pending");
    recovered++;
  }
  return recovered;
}
