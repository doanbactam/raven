#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { initProject } from "./init.js";
import { loadConfig } from "./config.js";
import { SwarmStore } from "./store.js";
import { ClaudeRunner } from "./runner.js";
import { WorktreeService } from "./worktree.js";
import { Planner } from "./planner.js";
import { runDoctor, formatChecks, hasFailures } from "./doctor.js";
import { modeSucceeded, runSuite } from "./eval.js";
import { formatReplay, loadReplay } from "./replay.js";
import { executeRun } from "./run-control.js";
import { runPreMergeHooks } from "./merge-hook.js";
import { runSWEBenchSuite, formatSWEBenchSummary } from "./swebench.js";
import { runPilot, formatPilotReport } from "./pilot.js";

const program = new Command();
program
  .name("swarm")
  .description("Claude-native swarm orchestration control plane (MVP)")
  .version("0.0.1");

program
  .command("init")
  .description("Scaffold .claude/, swarm.yaml, and .swarm/ in the current repo")
  .action(async () => {
    const cwd = process.cwd();
    const { created, skipped } = await initProject(cwd);
    console.log("Created:");
    created.forEach((f) => console.log("  +", f));
    if (skipped.length) {
      console.log("Skipped (already exists):");
      skipped.forEach((f) => console.log("  =", f));
    }
    console.log("\nNext: edit swarm.yaml goal, then `swarm plan` and `swarm run`.");
  });

program
  .command("plan")
  .description("Run planner subagent and persist a task DAG")
  .option("--goal <text>", "override goal from swarm.yaml")
  .action(async (opts: { goal?: string }) => {
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    if (opts.goal) cfg.goal = opts.goal;
    const runId = randomUUID();
    const store = new SwarmStore(cwd);
    const runner = new ClaudeRunner();

    store.insertRun(runId, cfg.goal);
    console.log(`Planning run ${runId}...`);
    const planner = new Planner(runner, cfg);
    const { plan, costUsd } = await planner.plan(cwd);

    // Only emit PlanCreated after a successful plan parse, so failures don't
    // leave orphan events. costUsd is the planner's spend; per-task spend is
    // logged separately by the dispatcher on TaskValidated/TaskFailed.
    store.appendEvent({
      run_id: runId,
      type: "PlanCreated",
      ts: new Date().toISOString(),
      payload: { goal: cfg.goal, taskCount: plan.tasks.length, costUsd },
    });

    for (const t of plan.tasks) store.insertTask(runId, t);
    store.setRunStatus(runId, "ready");
    console.log(`Plan saved: ${plan.tasks.length} tasks (planner cost: $${costUsd.toFixed(4)}). Run ID: ${runId}`);
    console.log(`Next: swarm run ${runId}`);
    store.close();
  });

program
  .command("run")
  .argument("<runId>", "run id from `swarm plan`")
  .description("Execute a planned run")
  .action(async (runId: string) => {
    const { summary } = await executeRun(process.cwd(), runId);
    console.log(`Run complete. done=${summary.done} failed=${summary.failed} blocked=${summary.blocked}`);
  });

program
  .command("resume")
  .argument("<runId>", "run id to recover and continue")
  .description("Resume an interrupted run without re-running completed tasks")
  .action(async (runId: string) => {
    const { summary, recoveredRunning } = await executeRun(process.cwd(), runId, { resumed: true });
    console.log(
      `Resume complete. recovered_running=${recoveredRunning} done=${summary.done} failed=${summary.failed} blocked=${summary.blocked}`,
    );
  });

program
  .command("status")
  .argument("<runId>", "run id")
  .description("Show task statuses for a run")
  .action((runId: string) => {
    const store = new SwarmStore(process.cwd());
    const tasks = store.listTasks(runId);
    if (tasks.length === 0) {
      console.log("No tasks for run", runId);
    } else {
      for (const t of tasks) {
        console.log(`[${t.status.padEnd(8)}] ${t.id}  ${t.summary}`);
      }
    }
    store.close();
  });

program
  .command("replay")
  .argument("<runId>", "run id")
  .description("Render the event timeline for a run with a cost rollup")
  .action((runId: string) => {
    const summary = loadReplay(process.cwd(), runId);
    console.log(formatReplay(summary));
    if (summary.events.length === 0) process.exitCode = 1;
  });

program
  .command("merge")
  .argument("<runId>", "run id")
  .option("--delete-branches", "delete task branches after merging", false)
  .description("Merge done task branches into the current branch in topological order")
  .action(async (runId: string, opts: { deleteBranches?: boolean }) => {
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const store = new SwarmStore(cwd);
    const worktrees = new WorktreeService(cwd);
    const tasks = store.listTasks(runId);
    if (tasks.length === 0) {
      console.log("No tasks for run", runId);
      store.close();
      return;
    }
    // Normalize pre_merge_hook to array (may be string, string[], or undefined).
    const hookCmds: string[] = cfg.pre_merge_hook
      ? Array.isArray(cfg.pre_merge_hook) ? cfg.pre_merge_hook : [cfg.pre_merge_hook]
      : [];
    const order = topologicalOrder(tasks);
    const merged: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    for (const t of order) {
      if (t.status !== "done") {
        skipped.push(`${t.id} (${t.status})`);
        continue;
      }
      // Phase 3.4: run pre-merge hook(s) before merging each task branch.
      if (hookCmds.length > 0) {
        const branch = worktrees.branchName(runId, t.id);
        const hookResult = await runPreMergeHooks(cwd, hookCmds, { runId, taskId: t.id, branch });
        if (!hookResult.passed) {
          const lastFail = hookResult.results[hookResult.results.length - 1];
          console.error(`! pre-merge hook rejected ${t.id}: "${lastFail?.command}" exited ${lastFail?.exitCode}`);
          if (lastFail?.stderr) console.error(`  ${lastFail.stderr.split("\n")[0]}`);
          failed.push(t.id);
          console.error("  Stopping. Fix the hook issue and re-run merge.");
          break;
        }
      }
      const r = await worktrees.mergeBranch(runId, t.id);
      if (r.ok) {
        merged.push(t.id);
        console.log(`+ merged ${t.id}`);
        if (opts.deleteBranches) await worktrees.deleteBranch(runId, t.id, true);
      } else {
        failed.push(t.id);
        console.error(`! merge failed for ${t.id}: ${r.message.split("\n")[0]}`);
        console.error("  Stopping. Resolve the conflict manually and re-run with the remaining tasks.");
        break;
      }
    }
    console.log(`\nMerged: ${merged.length}, Failed: ${failed.length}, Skipped: ${skipped.length}`);
    if (skipped.length) console.log("  skipped:", skipped.join(", "));
    store.close();
    if (failed.length > 0) process.exit(1);
  });

program
  .command("clean")
  .argument("<runId>", "run id")
  .option("--keep-branches", "remove worktrees but keep task branches", false)
  .description("Remove all worktrees (and optionally branches) for a run")
  .action(async (runId: string, opts: { keepBranches?: boolean }) => {
    const cwd = process.cwd();
    const store = new SwarmStore(cwd);
    const worktrees = new WorktreeService(cwd);
    const tasks = store.listTasks(runId);
    let removed = 0;
    for (const t of tasks) {
      const wt = store.getTaskWorktree(runId, t.id);
      if (wt) {
        await worktrees.remove(wt);
        removed++;
      }
      if (!opts.keepBranches) {
        await worktrees.deleteBranch(runId, t.id, true);
      }
    }
    console.log(`Removed ${removed} worktrees${opts.keepBranches ? "" : " and deleted task branches"}.`);
    store.close();
  });

/** Kahn's algorithm — emit tasks in dependency order, ignoring missing deps. */
function topologicalOrder<T extends { id: string; depends_on: string[] }>(tasks: T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indeg = new Map<string, number>();
  for (const t of tasks) {
    indeg.set(t.id, t.depends_on.filter((d) => byId.has(d)).length);
  }
  const queue: T[] = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0);
  const out: T[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    out.push(t);
    for (const other of tasks) {
      if (other.depends_on.includes(t.id)) {
        const left = (indeg.get(other.id) ?? 0) - 1;
        indeg.set(other.id, left);
        if (left === 0) queue.push(other);
      }
    }
  }
  // Append any cycle-stuck tasks at the end so caller sees them.
  for (const t of tasks) {
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

program
  .command("doctor")
  .description("Check environment, config, and git health before running")
  .action(async () => {
    const checks = await runDoctor(process.cwd());
    console.log(formatChecks(checks));
    if (hasFailures(checks)) {
      console.error("\nDoctor found blocking issues. Fix the [FAIL] entries above.");
      process.exit(1);
    }
  });

program
  .command("eval")
  .argument("<suite>", "path to eval suite YAML")
  .option("--swarm-cli <bin>", "swarm CLI to invoke for the swarm mode", "swarm")
  .option("--claude-bin <bin>", "Claude CLI to invoke for the baseline mode", "claude")
  .description("Run an eval suite (baseline vs swarm) and emit JSONL+CSV results")
  .action(async (suite: string, opts: { swarmCli: string; claudeBin: string }) => {
    const results = await runSuite(suite, { swarmCli: opts.swarmCli, claudeBin: opts.claudeBin });
    console.log(`\nDone. ${results.length} runs.`);
    // Quick stdout summary grouped by entry+mode
    const byKey = new Map<string, { wall: number[]; cost: number[]; verifyExits: number[] }>();
    for (const r of results) {
      const k = `${r.entryId}/${r.mode}`;
      const acc = byKey.get(k) ?? { wall: [], cost: [], verifyExits: [] };
      acc.wall.push(r.wallMs);
      acc.cost.push(r.costUsd);
      acc.verifyExits.push(r.verifyExit);
      byKey.set(k, acc);
    }
    for (const [k, v] of byKey) {
      const meanWall = (v.wall.reduce((a, b) => a + b, 0) / v.wall.length).toFixed(0);
      const meanCost = (v.cost.reduce((a, b) => a + b, 0) / v.cost.length).toFixed(4);
      const modeOk = results.filter((r) => `${r.entryId}/${r.mode}` === k).every(modeSucceeded);
      const verifyOk = v.verifyExits.every((e) => e === 0 || e === -1);
      console.log(`  ${k.padEnd(40)} wall_ms_mean=${meanWall} cost_usd_mean=$${meanCost} verify=${verifyOk && modeOk ? "ok" : "FAIL"}`);
    }
  });

program
  .command("swebench")
  .argument("<suite>", "path to SWE-bench suite YAML")
  .option("--swarm-cli <bin>", "swarm CLI to invoke for swarm mode", "swarm")
  .option("--claude-bin <bin>", "Claude CLI for baseline mode", "claude")
  .description("Run a SWE-bench Verified subset (baseline vs swarm)")
  .action(async (suite: string, opts: { swarmCli: string; claudeBin: string }) => {
    const results = await runSWEBenchSuite(suite, { swarmCli: opts.swarmCli, claudeBin: opts.claudeBin });
    console.log(formatSWEBenchSummary(results));
  });

program
  .command("pilot")
  .argument("<suite>", "path to eval suite YAML (regression or scope-tempting)")
  .option("--swarm-cli <bin>", "swarm CLI", "swarm")
  .option("--claude-bin <bin>", "Claude CLI for baseline", "claude")
  .option("--out <path>", "output report path", "PILOT_REPORT.md")
  .description("Run pilot evaluation and generate a go/no-go report")
  .action(async (suite: string, opts: { swarmCli: string; claudeBin: string; out: string }) => {
    const report = await runPilot(suite, { swarmCli: opts.swarmCli, claudeBin: opts.claudeBin });
    const md = formatPilotReport(report);
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(opts.out, md, "utf8");
    console.log(md);
    console.log(`\nReport written to ${opts.out}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
