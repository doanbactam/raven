import { execa } from "execa";
import { join } from "node:path";

/**
 * Wrapper quanh `claude` CLI runtime.
 *
 * Chiến lược MVP:
 * - Spawn `claude -p "<prompt>" --output-format stream-json` trong cwd của worktree
 *   để tận dụng subagents/skills/hooks/permissions của Claude Code đã định nghĩa
 *   trong `.claude/` của repo gốc.
 * - Subagent được chỉ định qua prompt (vd: "Use the swarm-implementer subagent to...")
 *   hoặc qua slash command custom trong `.claude/commands/`.
 * - Hook events do Claude Code emit sẽ được hook bridge ghi vào event store
 *   ngoài tiến trình này (xem `.claude/settings.json` template).
 *
 * Note: chính xác flag/args phụ thuộc version Claude Code đang cài. Verify bằng
 * `claude --help` trên máy thực; spike script (Option 2) sẽ confirm.
 */
export interface RunOptions {
  cwd: string;
  prompt: string;
  /** Subagent name (filename không có .md trong .claude/agents/). */
  subagent?: string;
  /** Allow tools whitelist; nếu undefined thì dùng settings của repo. */
  allowedTools?: string[];
  /** Bỏ qua interactive permission prompts (dangerous — chỉ dùng trong worktree cô lập). */
  dangerouslySkipPermissions?: boolean;
  /** Stable Claude Code session UUID used to resume/reuse task context. */
  sessionId?: string;
  /** Claude model or alias to use for this run. */
  model?: string;
  /** Timeout ms. */
  timeoutMs?: number;
  /** Retries for transient Claude service errors such as 429 overload. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** When true, pass --include-hook-events to receive lifecycle/hook data in the stream. */
  includeHookEvents?: boolean;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Last assistant message text nếu parse được từ stream-json. */
  finalMessage?: string;
  /** Token/cost nếu Claude CLI emit (qua hook hoặc stream metadata). */
  costUsd?: number;
  /** Claude Code session id emitted by the stream init event. */
  sessionId?: string;
  /** Hook/lifecycle events captured when --include-hook-events is active. */
  hookEvents?: HookEvent[];
}

export class ClaudeRunner {
  private bin: string;

  constructor(bin = "claude") {
    this.bin = bin;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    // `claude -p` + `--output-format stream-json` requires `--verbose` (verified on Claude Code 2.1.x).
    const args: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push("--allowed-tools", opts.allowedTools.join(","));
    }
    if (opts.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.includeHookEvents) {
      args.push("--include-hook-events");
    }

    const maxRetries = opts.maxRetries ?? 2;
    let out: RunResult | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const child = execa(this.bin, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30 * 60_000,
        reject: false,
        // Claude CLI waits for piped stdin in -p mode; close it explicitly.
        stdin: "ignore",
        env: {
          ...process.env,
          // Hook bridge sẽ tail file này; mỗi run có path riêng để demux.
          SWARM_EVENT_LOG: join(opts.cwd, ".swarm-events.jsonl"),
        },
      });

      const result = await child;
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      const parsed = parseStreamJson(stdout);
      out = {
        exitCode: result.exitCode ?? -1,
        stdout,
        stderr,
      };
      if (parsed.finalMessage !== undefined) out.finalMessage = parsed.finalMessage;
      if (parsed.costUsd !== undefined) out.costUsd = parsed.costUsd;
      if (out.costUsd === undefined) {
        const stderrCost = extractCostFromText(stderr);
        if (stderrCost !== undefined) out.costUsd = stderrCost;
      }
      if (parsed.sessionId !== undefined) out.sessionId = parsed.sessionId;
      if (parsed.hookEvents.length > 0) out.hookEvents = parsed.hookEvents;
      // Only check stderr (not stdout which contains Claude CLI's own internal 429 retry logs).
      // Also skip retry if the process timed out — retrying a timeout just wastes more time.
      if (
        out.exitCode === 0 ||
        result.timedOut ||
        !isTransientClaudeError({ stdout: "", stderr }) ||
        attempt === maxRetries
      ) return out;
      await sleep(opts.retryDelayMs ?? 5000);
    }
    return out!;
  }
}

/** A lifecycle/hook event captured from Claude Code's --include-hook-events stream. */
export interface HookEvent {
  /** Hook type: PreToolUse, PostToolUse, SubagentStop, Stop, Notification, etc. */
  hookType: string;
  /** Timestamp (ISO or epoch) from the stream event, falling back to capture time. */
  ts: string;
  /** Tool name if this is a tool-related hook. */
  toolName?: string;
  /** Subagent name if this is a subagent lifecycle hook. */
  subagentName?: string;
  /** Raw payload preserved for downstream normalization. */
  payload: Record<string, unknown>;
}

interface ParsedStream {
  finalMessage?: string;
  costUsd?: number;
  sessionId?: string;
  hookEvents: HookEvent[];
}

/**
 * Parse Claude Code stream-json output (verified against Claude Code 2.1.92):
 * - `{type:"system", subtype:"init"|"hook_started"|"hook_response", ...}`
 * - one or more `{type:"assistant", message:{content:[{type:"text"|"thinking", ...}]}}`
 * - final `{type:"result", subtype:"success", result, total_cost_usd, duration_ms, ...}`
 *
 * ANSI escape sequences are stripped before parsing to handle terminal color codes
 * that Claude CLI may inject into stream-json output.
 */
export function parseStreamJson(streamJson: string): ParsedStream {
  const out: ParsedStream = { hookEvents: [] };
  let lastAssistantText: string | undefined;
  const cleaned = stripAnsi(streamJson);
  for (const line of cleaned.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as Record<string, unknown>;
    const eType = e.type as string | undefined;
    if (eType === "system" && typeof e.session_id === "string") {
      out.sessionId = e.session_id;
    } else if (eType === "assistant") {
      const msg = e.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (msg?.content) {
        for (const c of msg.content) {
          if (c.type === "text" && typeof c.text === "string") lastAssistantText = c.text;
        }
      }
    } else if (eType === "result") {
      if (typeof e.result === "string") out.finalMessage = e.result;
      if (typeof e.total_cost_usd === "number") out.costUsd = e.total_cost_usd;
    } else if (eType === "hook" || eType === "lifecycle") {
      out.hookEvents.push(parseHookEvent(e));
    }
  }
  // Fallback: nếu không có result event, dùng assistant text cuối cùng.
  if (out.finalMessage === undefined && lastAssistantText !== undefined) {
    out.finalMessage = lastAssistantText;
  }
  // Fallback: regex scan for cost if not found via structured parsing
  if (out.costUsd === undefined) {
    const cost = extractCostFromText(cleaned);
    if (cost !== undefined) out.costUsd = cost;
  }
  return out;
}

export function extractCostFromText(text: string): number | undefined {
  const cleaned = stripAnsi(text);
  let cost: number | undefined;
  const re = /["']?total_cost_usd["']?\s*[:=]\s*([\d.eE+-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    const value = Number.parseFloat(match[1]!);
    if (Number.isFinite(value) && (cost === undefined || value > cost)) {
      cost = value;
    }
  }
  return cost;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Map a raw stream JSON object with type=hook|lifecycle into a HookEvent. */
function parseHookEvent(raw: Record<string, unknown>): HookEvent {
  const hookType = typeof raw.hook_type === "string"
    ? raw.hook_type
    : typeof raw.subtype === "string"
      ? raw.subtype
      : "unknown";
  const ts = typeof raw.ts === "string"
    ? raw.ts
    : typeof raw.timestamp === "string"
      ? raw.timestamp
      : new Date().toISOString();
  const he: HookEvent = { hookType, ts, payload: {} };
  if (typeof raw.tool_name === "string") he.toolName = raw.tool_name;
  if (typeof raw.subagent_name === "string") he.subagentName = raw.subagent_name;
  // Preserve full raw data for downstream normalizer, but strip large binary blobs.
  const { type: _t, ...rest } = raw;
  he.payload = rest as Record<string, unknown>;
  return he;
}

export function isTransientClaudeError(result: Pick<RunResult, "stdout" | "stderr" | "finalMessage">): boolean {
  const text = `${result.stderr}\n${result.finalMessage ?? ""}\n${result.stdout}`;
  return /429|overload|temporarily overloaded|rate limit|UV_HANDLE_CLOSING|Assertion failed/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
