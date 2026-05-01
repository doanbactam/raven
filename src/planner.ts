import { platform } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  attempts: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export class Planner {
  constructor(private runner: ClaudeRunner, private cfg: SwarmConfig) {}

  async plan(repoDir: string): Promise<PlanResult> {
    const failurePatterns = loadFailurePatterns(repoDir);
    const basePrompt = buildPlannerPrompt(this.cfg, undefined, failurePatterns);
    const maxAttempts = plannerMaxAttempts();
    let totalCostUsd = 0;
    let lastFailure = "unknown planner failure";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const prompt = attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous response was rejected because: ${lastFailure}\nTry again. Output ONLY a single fenced \`\`\`json block and no prose.`;
      const res = await this.runner.run({
        cwd: repoDir,
        prompt,
        // Planner không được edit; chỉ read.
        allowedTools: ["Read", "Grep", "Glob"],
      });
      totalCostUsd += res.costUsd ?? 0;
      if (res.exitCode !== 0) {
        lastFailure = `planner exited ${res.exitCode}: ${res.stderr || res.finalMessage || res.stdout.slice(0, 400)}`;
        if (attempt < maxAttempts - 1) continue;
        return this.fallbackPlan(repoDir, totalCostUsd, maxAttempts, lastFailure);
      }
      const json = extractPlannerJsonFromRunResult(res);
      if (!json) {
        lastFailure = "response did not contain a parseable JSON object";
        if (attempt < maxAttempts - 1) continue;
        return this.fallbackPlan(repoDir, totalCostUsd, maxAttempts, lastFailure);
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(json);
      } catch (parseErr) {
        lastFailure = `invalid JSON: ${(parseErr as Error).message}`;
        if (attempt < maxAttempts - 1) continue;
        return this.fallbackPlan(repoDir, totalCostUsd, maxAttempts, lastFailure);
      }
      const parsed = PlanSchema.safeParse(parsedJson);
      if (!parsed.success) {
        lastFailure = `schema validation failed: ${parsed.error.message}`;
        if (attempt < maxAttempts - 1) continue;
        return this.fallbackPlan(repoDir, totalCostUsd, maxAttempts, lastFailure);
      }
      // Validate ownership conflicts against policy.
      const conflicts = validatePlanConflicts(parsed.data, this.cfg);
      if (conflicts.length > 0 && this.cfg.policies.same_file === "block") {
        const details = conflicts.map((c) => `  ${c.file}: ${c.tasks.join(", ")}`).join("\n");
        lastFailure = `overlapping file ownership (policy: block):\n${details}`;
        if (attempt < maxAttempts - 1) continue;
        return this.fallbackPlan(repoDir, totalCostUsd, maxAttempts, lastFailure);
      }
      return { plan: parsed.data, costUsd: totalCostUsd, attempts: attempt + 1, fallbackUsed: false };
    }
    // Unreachable, but satisfies TS
    throw new Error("Planner failed after retries");
  }

  private fallbackPlan(repoDir: string, costUsd: number, attempts: number, reason: string): PlanResult {
    if (process.env.SWARM_PLANNER_STRICT === "1") {
      throw new Error(`Planner failed after ${attempts} attempts: ${reason}`);
    }
    return {
      plan: buildFallbackPlan(repoDir, this.cfg.goal),
      costUsd,
      attempts,
      fallbackUsed: true,
      fallbackReason: reason,
    };
  }
}

function plannerMaxAttempts(): number {
  const raw = process.env.SWARM_PLANNER_MAX_ATTEMPTS;
  if (!raw) return 2;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

export function buildFallbackPlan(repoDir: string, goal: string): Plan {
  const tasks = buildFallbackTasks(repoDir, goal);
  return {
    goal,
    tasks,
  };
}

function buildFallbackTasks(repoDir: string, goal: string): Plan["tasks"] {
  const files = inferOwnedFilesFromGoal(repoDir, goal);
  const checks = inferAcceptanceChecks(repoDir);
  if (files.length === 0) {
    return [
      {
        id: "T1-main",
        summary: "Implement the goal in one conservative task because structured planning was unavailable",
        depends_on: [],
        owned_files: ["**/*"],
        owned_symbols: [],
        acceptance_checks: checks,
        risk_level: "high",
      },
    ];
  }

  return files.map((file, index) => {
    const owned = [file, ...inferCompanionFiles(file, goal)].filter((value, i, all) => all.indexOf(value) === i);
    return {
      id: `T${index + 1}-${taskSlug(file)}`,
      summary: `Implement the requested changes for ${file}`,
      depends_on: [],
      owned_files: owned,
      owned_symbols: [],
      acceptance_checks: checks,
      risk_level: files.length === 1 ? "medium" : "low",
    };
  });
}

export function inferOwnedFilesFromGoal(repoDir: string, goal: string): string[] {
  const normalized = goal.replace(/\\/g, "/");
  const explicit = new Set<string>();
  const fileRe = /(?:^|[\s("'`])((?:src|lib|app|tests|test|packages|fixtures)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(normalized)) !== null) {
    explicit.add(match[1]!);
  }

  const srcDir = join(repoDir, "src");
  if (existsSync(srcDir)) {
    for (const file of safeListSourceFiles(srcDir)) {
      const base = file.split("/").pop()!;
      if (new RegExp(`\\b${escapeRegExp(base)}\\b`, "i").test(normalized)) {
        explicit.add(`src/${file}`);
      }
    }
  }

  return [...explicit]
    .filter((file) => !file.startsWith("tests/") && !file.startsWith("test/"))
    .sort();
}

function inferCompanionFiles(sourceFile: string, goal: string): string[] {
  if (!sourceFile.startsWith("src/")) return [];
  const base = sourceFile.split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  const companions: string[] = [];
  const goalText = goal.toLowerCase();
  if (goalText.includes("test")) companions.push(`tests/${stem}.test.js`);
  if (goalText.includes("doc") || goalText.includes("jsdoc")) companions.push(sourceFile);
  return companions;
}

function safeListSourceFiles(srcDir: string): string[] {
  try {
    return readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(cjs|mjs|js|jsx|ts|tsx|go|py|rs)$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function taskSlug(file: string): string {
  return file
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

function inferAcceptanceChecks(repoDir: string): string[] {
  const checks: string[] = [];
  const pkgPath = join(repoDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (typeof pkg.scripts?.test === "string") checks.push("npm test");
      if (typeof pkg.scripts?.typecheck === "string") checks.push("npm run typecheck");
    } catch {
      // fall through to generic checks
    }
  }
  if (existsSync(join(repoDir, "go.mod"))) checks.push("go test ./...");
  if (checks.length === 0) checks.push("git diff --check");
  return checks;
}

/** Exported for unit tests. */
export function buildPlannerPrompt(cfg: SwarmConfig, hostPlatform: string = platform(), failurePatterns: string[] = []): string {
  const isWindows = hostPlatform === "win32";
  const platformGuidance = isWindows
    ? [
        `Host platform: Windows (win32). The host shell is PowerShell, NOT bash.`,
        `CRITICAL: acceptance_checks MUST use ONLY these commands:`,
        `  - 'node --test path/to/file.test.js' for running tests`,
        `  - 'npm test' for project test scripts`,
        `  - 'npx tsc --noEmit' for type checking`,
        `  - 'node -e "CODE"' for content checks (see below)`,
        `NEVER use: grep, awk, sed, cut, wc, xargs, find, cat (these are POSIX-only and WILL fail on Windows). AVOID all POSIX-specific commands.`,
        `For checking if a file contains JSDoc comments, use:`,
        `  node -e "if(!require('fs').readFileSync('FILE','utf8').match(/@param/))process.exit(1)"`,
        `For checking if a test file exists, use:`,
        `  node -e "if(!require('fs').existsSync('FILE'))process.exit(1)"`,
      ].join("\n")
    : [
        `Host platform: ${hostPlatform}. Standard POSIX tools (grep, awk, sed, find) are available.`,
        `Acceptance checks should prefer 'node --test' / 'npm test' / 'npx tsc --noEmit' over ad-hoc grep where possible.`,
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
    `IMPORTANT: Your ENTIRE response must be the JSON block. Do not include any text before or after the JSON.`,
    ``,
    `Rules:`,
    `- Avoid two tasks owning the same file unless absolutely required.`,
    `- Prefer ${cfg.parallelism} parallelizable tasks where possible.`,
    `- Each task must list at least one acceptance_check (a shell command or test path).`,
    `- acceptance_checks must run successfully on the host platform stated above.`,
    ``,
    `Example output for goal "Add logging to all routes":`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "goal": "Add logging to all routes",`,
    `  "tasks": [`,
    `    {`,
    `      "id": "T1-auth-logging",`,
    `      "summary": "Add Winston logger to auth routes",`,
    `      "depends_on": [],`,
    `      "owned_files": ["src/routes/auth.js", "tests/auth.test.js"],`,
    `      "owned_symbols": ["login", "logout"],`,
    `      "acceptance_checks": ["node --test tests/auth.test.js"],`,
    `      "risk_level": "low"`,
    `    },`,
    `    {`,
    `      "id": "T2-api-logging",`,
    `      "summary": "Add Winston logger to API routes",`,
    `      "depends_on": [],`,
    `      "owned_files": ["src/routes/api.js", "tests/api.test.js"],`,
    `      "owned_symbols": ["getUsers", "createUser"],`,
    `      "acceptance_checks": ["node --test tests/api.test.js"],`,
    `      "risk_level": "low"`,
    `    }`,
    `  ]`,
    `}`,
    `\`\`\``,
  );
  return parts.join("\n");
}

/** Exported for unit tests. */
export function extractPlannerJson(text: string): string | null {
  const m = /```json\s*\n([\s\S]*?)\n```/i.exec(text);
  if (m && m[1]) return m[1];

  const streamJson = extractPlannerJsonFromStreamLines(text);
  if (streamJson) return streamJson;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }

  const embedded = extractFirstJsonObject(trimmed);
  if (!embedded) return null;
  try {
    JSON.parse(embedded);
    return embedded;
  } catch {
    return null;
  }
}

function extractPlannerJsonFromStreamLines(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      const content = event.message?.content ?? [];
      for (const part of content) {
        if (part.type === "text" && typeof part.text === "string") {
          const json = extractPlannerJson(part.text);
          if (json) return json;
        }
      }
      if (typeof event.result === "string") {
        const json = extractPlannerJson(event.result);
        if (json) return json;
      }
    } catch {
      // Not a stream-json line.
    }
  }
  return null;
}

function extractPlannerJsonFromRunResult(res: { finalMessage?: string; stdout: string; stderr: string }): string | null {
  const candidates = [res.finalMessage, res.stdout, res.stderr].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  for (const candidate of candidates) {
    const json = extractPlannerJson(candidate);
    if (json) return json;
  }
  return null;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
