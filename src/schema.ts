import { z } from "zod";

/** Một task trong DAG. Planner phải xuất đúng shape này. */
export const TaskSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  owned_files: z.array(z.string()).default([]),
  owned_symbols: z.array(z.string()).default([]),
  acceptance_checks: z.array(z.string()).default([]),
  risk_level: z.enum(["low", "medium", "high"]).default("medium"),
});
export type Task = z.infer<typeof TaskSchema>;

export const PlanSchema = z.object({
  goal: z.string(),
  tasks: z.array(TaskSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Cấu hình swarm.yaml */
export const SwarmConfigSchema = z.object({
  version: z.literal("0.1"),
  goal: z.string(),
  parallelism: z.number().int().positive().default(2),
  budget_usd: z.number().positive().default(5),
  planner: z.string().default("swarm-architect"),
  worker: z.string().default("swarm-implementer"),
  quality_gate: z.string().default("swarm-quality-gate"),
  policies: z
    .object({
      same_file: z.enum(["block", "ask", "allow"]).default("block"),
      same_symbol: z.enum(["block", "ask", "allow"]).default("ask"),
      out_of_scope_edit: z.enum(["fail", "warn", "allow"]).default("fail"),
      tests_required: z.boolean().default(true),
      security_scan_required: z.boolean().default(false),
    })
    .default({}),
  routing: z
    .object({
      plan_model: z.string().default("strong"),
      worker_model: z.string().default("fast"),
      gate_model: z.string().default("strong"),
    })
    .default({}),
  /** Shell command(s) run before each task branch is merged. Exit non-zero to reject. */
  pre_merge_hook: z.union([z.string(), z.array(z.string())]).optional(),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

/** Event types ghi vào event store (event-sourced). */
export const EventTypeSchema = z.enum([
  "PlanCreated",
  "TaskClaimed",
  "TaskReleased",
  "WorktreeOpened",
  "WorktreeClosed",
  "AgentStarted",
  "AgentStopped",
  "PatchProposed",
  "TaskValidated",
  "TaskFailed",
  "GateFailed",
  "GatePassed",
  "ArbitrationRequested",
  "RunCompleted",
  // Phase 3: lifecycle hook events captured from --include-hook-events stream
  "HookPreToolUse",
  "HookPostToolUse",
  "HookSubagentStart",
  "HookSubagentStop",
  "HookNotification",
  "HookStop",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Eval suite: a list of (goal, fixture) pairs that can be run in baseline
 * (single-Claude) and/or swarm modes for regression and uplift measurement.
 */
export const EvalEntrySchema = z.object({
  id: z.string().min(1),
  /** Path (relative to suite file) to a clean fixture repo. Will be copied to a tempdir per run. */
  fixture: z.string().min(1),
  /** Either inline goal text or a path to a goal file (relative to suite file). */
  goal: z.string().optional(),
  goal_file: z.string().optional(),
  /** Modes to run. Default: both. */
  modes: z.array(z.enum(["baseline", "swarm"])).default(["baseline", "swarm"]),
  /** How many times to repeat each mode (for variance). Default 1. */
  runs: z.number().int().positive().default(1),
  /** Optional shell command run after each mode finishes; expected to exit 0 if quality OK. */
  verify_cmd: z.string().optional(),
});
export type EvalEntry = z.infer<typeof EvalEntrySchema>;

export const EvalSuiteSchema = z.object({
  version: z.literal("0.1"),
  out_dir: z.string().default("./eval-results"),
  entries: z.array(EvalEntrySchema).min(1),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const EventSchema = z.object({
  run_id: z.string(),
  task_id: z.string().optional(),
  type: EventTypeSchema,
  ts: z.string().datetime(),
  payload: z.record(z.unknown()).default({}),
});
export type SwarmEvent = z.infer<typeof EventSchema>;
