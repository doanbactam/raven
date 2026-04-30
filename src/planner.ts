import { platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRunner } from "./runner.js";
import { PlanSchema, type Plan, type SwarmConfig } from "./schema.js";

/**
 * Validate that a plan respects the `same_file` and `same_symbol` policies.
 * Returns a list of conflicts (empty if the plan is clean).
 */
export function validatePlanConflicts(
  plan: Plan,
  cfg: SwarmConfig,
): Array<{ file: string; tasks: string[] }> {
  if (cfg.policies.same_file === "allow") return [];

  const fileToTasks = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const f of t.owned_files) {
      const norm = f.replace(/\\/g, "/");
      const existing = fileToTasks.get(norm) ?? [];
      existing.push(t.id);
      fileToTasks.set(norm, existing);
    }
  }

  const conflicts: Array<{ file: string; tasks: string[] }> = [];
  for (const [file, tasks] of fileToTasks) {
    if (tasks.length > 1) {
      conflicts.push({ file, tasks });
    }
  }
  return conflicts;
}

/**
 * Load failure patterns from past runs so the planner can avoid repeating them.
 * Returns a human-readable summary of past failures for inclusion in the planner prompt.
 */
export function loadFailurePatterns(rootDir: string): string[] {
  const eventsPath = join(rootDir, ".swarm", "events.jsonl");
  if (!existsSync(eventsPath)) return [];

  const patterns: string[] = [];
  try {
    const raw = readFileSync(eventsPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as {
          type?: string;
          payload?: { reason?: string; outOfScopeFiles?: string[]; error?: string; ownedFiles?: string[] };
        };
        if (e.type === "ArbitrationRequested" && typeof e.payload?.reason === "string") {
          const reason = e.payload.reason;
          if (reason === "out_of_scope_edit" && e.payload.outOfScopeFiles) {
            patterns.push(`Past failure: out-of-scope edit detected on files: ${e.payload.outOfScopeFiles.join(", ")}. Assign these files to the task or create a dedicated task.`);
          } else if (reason === "stale_lock_released") {
            patterns.push(`Past failure: stale lock detected — workers timed out. Consider smaller tasks or lower parallelism.`);
          } else if (reason === "merge_conflict") {
            patterns.push(`Past failure: merge conflict between task branches. Consider fewer shared files or sequential dependencies.`);
          } else if (reason === "budget_exceeded") {
            patterns.push(`Past failure: budget exceeded before all tasks completed. Plan fewer or simpler tasks.`);
          }
        }
        if (e.type === "TaskFailed" && typeof e.payload?.error === "string") {
          const err = e.payload.error;
          if (/PAGER|GIT_EDITOR|GIT_ASKPASS|allowUnsafe/.test(err)) {
            patterns.push(`Past failure: git env var blocked operation (${err.slice(0, 100)}). Ensure sanitizedEnv() strips it.`);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* file not found */ }

  // Deduplicate
  return [...new Set(patterns)];
}

/**
 * Planner: gọi Claude với subagent `swarm-architect` để sinh task DAG.
 *
 * Contract: subagent BẮT BUỘC trả về một fenced ```json block duy nhất chứa
 * `{ goal, tasks: [...] }` đúng schema. Prompt template trong
 * `.claude/agents/swarm-architect.md` và `.claude/commands/swarm-plan.md`
 * phải enforce điều này (xem template scaffolded bởi `swarm init`).
 */
export interface PlanResult {
  plan: Plan;
  /** USD cost reported by Claude for the planner run, if available. */
  costUsd: number;
}

export class Planner {
  constructor(private runner: ClaudeRunner, private cfg: SwarmConfig) {}

  async plan(repoDir: string): Promise<PlanResult> {
    const failurePatterns = loadFailurePatterns(repoDir);
    const prompt = buildPlannerPrompt(this.cfg, undefined, failurePatterns);
    const res = await this.runner.run({
      cwd: repoDir,
      prompt,
      // Planner không được edit; chỉ read.
      allowedTools: ["Read", "Grep", "Glob"],
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `Planner failed (exit ${res.exitCode}): ${res.stderr || res.finalMessage || res.stdout.slice(0, 4000)}`,
      );
    }
    const json = extractJsonBlock(res.finalMessage ?? res.stdout);
    if (!json) {
      throw new Error("Planner did not return a fenced ```json block");
    }
    const parsed = PlanSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      throw new Error(`Plan failed schema: ${parsed.error.message}`);
    }
    // Validate ownership conflicts against policy.
    const conflicts = validatePlanConflicts(parsed.data, this.cfg);
    if (conflicts.length > 0 && this.cfg.policies.same_file === "block") {
      const details = conflicts.map((c) => `  ${c.file}: ${c.tasks.join(", ")}`).join("\n");
      throw new Error(`Plan has overlapping file ownership (policy: block):\n${details}`);
    }
    return { plan: parsed.data, costUsd: res.costUsd ?? 0 };
  }
}

/** Exported for unit tests. */
export function buildPlannerPrompt(cfg: SwarmConfig, hostPlatform: string = platform(), failurePatterns: string[] = []): string {
  const isWindows = hostPlatform === "win32";
  const platformGuidance = isWindows
    ? [
        `Host platform: Windows (${hostPlatform}). The host shell is PowerShell, NOT bash.`,
        `Acceptance checks MUST be cross-platform OR Windows-compatible. AVOID:`,
        `  - grep / awk / sed / cut / wc / xargs / find (POSIX only)`,
        `  - 'cmd1 && cmd2' chaining and 'cmd1 | grep x' pipelines`,
        `Prefer instead:`,
        `  - 'node --test path/to/file.test.js' for tests`,
        `  - 'node -e "require(\\'fs\\').readFileSync(\\'X\\').includes(\\'Y\\') || process.exit(1)"' for content checks`,
        `  - 'npm test' / 'npm run lint' / 'npx tsc --noEmit' for project scripts`,
        `  - For grep-like content checks, use: 'node -e "if(!require(\\'fs\\').readFileSync(\\'FILE\\',\\'utf8\\').match(/PATTERN/))process.exit(1)"'`,
      ].join("\n")
    : [
        `Host platform: ${hostPlatform}. Standard POSIX tools (grep, awk, sed, find) are available.`,
        `Acceptance checks should still prefer 'npm test' / 'node --test' / 'npx tsc' over ad-hoc grep where possible.`,
      ].join("\n");

  const parts: string[] = [
    `Use the @${cfg.planner} subagent.`,
    `Goal: ${cfg.goal}`,
    ``,
    platformGuidance,
  ];

  // Include past failure patterns as context so the planner learns from them.
  if (failurePatterns.length > 0) {
    parts.push("");
    parts.push("Past failure patterns (AVOID repeating these):");
    for (const p of failurePatterns) parts.push(`- ${p}`);
  }

  parts.push(
    ``,
    `Output ONLY a single fenced \`\`\`json block matching this TypeScript type:`,
    `{`,
    `  goal: string;`,
    `  tasks: Array<{`,
    `    id: string;`,
    `    summary: string;`,
    `    depends_on: string[];`,
    `    owned_files: string[];`,
    `    owned_symbols: string[];`,
    `    acceptance_checks: string[];`,
    `    risk_level: "low" | "medium" | "high";`,
    `  }>;`,
    `}`,
    ``,
    `Rules:`,
    `- Avoid two tasks owning the same file unless absolutely required.`,
    `- Prefer ${cfg.parallelism} parallelizable tasks where possible.`,
    `- Each task must list at least one acceptance_check (a shell command or test path).`,
    `- acceptance_checks must run successfully on the host platform stated above.`,
  );
  return parts.join("\n");
}

function extractJsonBlock(text: string): string | null {
  const m = /```json\s*\n([\s\S]*?)\n```/i.exec(text);
  return m && m[1] ? m[1] : null;
}
