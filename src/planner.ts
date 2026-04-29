import { platform } from "node:os";
import { ClaudeRunner } from "./runner.js";
import { PlanSchema, type Plan, type SwarmConfig } from "./schema.js";

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
    const prompt = buildPlannerPrompt(this.cfg);
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
    return { plan: parsed.data, costUsd: res.costUsd ?? 0 };
  }
}

/** Exported for unit tests. */
export function buildPlannerPrompt(cfg: SwarmConfig, hostPlatform: string = platform()): string {
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

  return [
    `Use the @${cfg.planner} subagent.`,
    `Goal: ${cfg.goal}`,
    ``,
    platformGuidance,
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
  ].join("\n");
}

function extractJsonBlock(text: string): string | null {
  const m = /```json\s*\n([\s\S]*?)\n```/i.exec(text);
  return m && m[1] ? m[1] : null;
}
