import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const SWARM_YAML = `version: "0.1"
goal: "Describe your goal here"
parallelism: 2
budget_usd: 5
planner: swarm-architect
worker: swarm-implementer
quality_gate: swarm-quality-gate

policies:
  same_file: block
  same_symbol: ask
  out_of_scope_edit: fail
  tests_required: true
  security_scan_required: false

routing:
  plan_model: strong
  worker_model: fast
  gate_model: strong
`;

const SETTINGS_JSON = `{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(./config/credentials.json)"
    ]
  },
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SubagentStop": [],
    "Stop": []
  }
}
`;

const ARCHITECT_MD = `---
name: swarm-architect
description: Decompose a goal into a dependency-aware task DAG with explicit ownership and acceptance checks.
tools: [Read, Grep, Glob]
---

You are the architect for a swarm of code agents.

Responsibilities:
- Read the codebase only as much as needed to understand module boundaries.
- Split the goal into small, maximally-independent tasks with explicit dependencies.
- For each task, output: id, summary, depends_on, owned_files, owned_symbols, acceptance_checks, risk_level.
- Avoid two tasks owning the same file unless strictly necessary.
- If a single file MUST be edited by multiple tasks, prefer:
  - splitting by symbol, OR
  - serializing tasks via depends_on, OR
  - explicitly requesting arbitration.
- Do NOT write code. Plan only.

Output format: a single fenced \`\`\`json block at the end with shape:
{ "goal": string, "tasks": Task[] }
`;

const IMPLEMENTER_MD = `---
name: swarm-implementer
description: Execute one claimed task; only edit within the declared ownership boundary.
tools: [Read, Edit, Write, Bash, Grep, Glob]
---

You are an implementer in the swarm.

Hard rules:
- Do exactly the task you were given, nothing else.
- Only edit files/symbols inside the declared ownership boundary.
- If you must touch anything outside the boundary, STOP and output exactly: NEEDS_ARBITRATION
- After each change: run the minimal relevant tests/lint and record files_touched.
- Never merge with other tasks' work.
- Prefer small, reviewable patches.
`;

const QUALITY_GATE_MD = `---
name: swarm-quality-gate
description: Validate worker outputs; detect contradictions, missing tests, and out-of-scope edits.
tools: [Read, Bash, Grep, Glob]
---

You are the final quality gate.

Checklist:
- Did each task pass its acceptance_checks?
- Did any task touch files outside its ownership_claim?
- Are there API/type/migration contradictions across tasks?
- Do tests, lint, typecheck, and security scans pass?
- Final verdict must be one of: APPROVE | REQUEST_FIXES | REQUIRE_ARBITRATION
`;

const WORKTREE_INCLUDE = `# Files outside .gitignore that should still be copied into per-task worktrees.
# Add paths your workers genuinely need (e.g. local-only dotfiles for tests).
# Example:
# .env.test
`;

const GITIGNORE_ADD = `
# swarm-cp local state
.swarm/
.swarm-events.jsonl
`;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function writeIfMissing(path: string, content: string): Promise<"created" | "skipped"> {
  if (await exists(path)) return "skipped";
  await writeFile(path, content, "utf8");
  return "created";
}

export async function initProject(rootDir: string): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  const dirs = [
    ".claude",
    ".claude/agents",
    ".claude/commands",
    ".swarm",
  ];
  for (const d of dirs) await mkdir(join(rootDir, d), { recursive: true });

  const files: Array<[string, string]> = [
    ["swarm.yaml", SWARM_YAML],
    [".claude/settings.json", SETTINGS_JSON],
    [".claude/agents/swarm-architect.md", ARCHITECT_MD],
    [".claude/agents/swarm-implementer.md", IMPLEMENTER_MD],
    [".claude/agents/swarm-quality-gate.md", QUALITY_GATE_MD],
    [".worktreeinclude", WORKTREE_INCLUDE],
  ];
  for (const [rel, content] of files) {
    const result = await writeIfMissing(join(rootDir, rel), content);
    (result === "created" ? created : skipped).push(rel);
  }

  // Append to .gitignore if exists; otherwise create.
  const gi = join(rootDir, ".gitignore");
  if (await exists(gi)) {
    const { readFile, appendFile } = await import("node:fs/promises");
    const cur = await readFile(gi, "utf8");
    if (!cur.includes(".swarm/")) {
      await appendFile(gi, GITIGNORE_ADD, "utf8");
      created.push(".gitignore (appended)");
    } else {
      skipped.push(".gitignore (already has .swarm/)");
    }
  } else {
    await writeFile(gi, GITIGNORE_ADD.trimStart(), "utf8");
    created.push(".gitignore");
  }

  return { created, skipped };
}
