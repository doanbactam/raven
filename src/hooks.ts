import type { HookEvent } from "./runner.js";
import type { SwarmEvent, EventType } from "./schema.js";

/**
 * Normalize raw HookEvent[] from Claude Code's --include-hook-events stream
 * into SwarmEvent[] suitable for the event store.
 *
 * Mapping strategy:
 * - PreToolUse  → HookPreToolUse
 * - PostToolUse → HookPostToolUse
 * - SubagentStart / TaskCreated → HookSubagentStart
 * - SubagentStop  → HookSubagentStop
 * - Stop          → HookStop
 * - Notification / TeammateIdle → HookNotification
 * - Unknown hook types are dropped (logged to stderr in debug mode).
 */

const HOOK_TYPE_MAP: Record<string, EventType> = {
  PreToolUse: "HookPreToolUse",
  PostToolUse: "HookPostToolUse",
  SubagentStart: "HookSubagentStart",
  TaskCreated: "HookSubagentStart",
  SubagentStop: "HookSubagentStop",
  Stop: "HookStop",
  Notification: "HookNotification",
  TeammateIdle: "HookNotification",
};

export interface NormalizeOptions {
  runId: string;
  taskId: string;
  /** If true, unknown hookTypes are silently discarded. Default true. */
  dropUnknown?: boolean;
}

export function normalizeHookEvents(
  hooks: readonly HookEvent[],
  opts: NormalizeOptions,
): SwarmEvent[] {
  const dropUnknown = opts.dropUnknown ?? true;
  const events: SwarmEvent[] = [];

  for (const h of hooks) {
    const mapped = HOOK_TYPE_MAP[h.hookType];
    if (!mapped) {
      if (!dropUnknown) {
        // Surface unknown hooks as Notification so they at least appear in replay.
        events.push(buildEvent("HookNotification", h, opts));
      }
      continue;
    }
    events.push(buildEvent(mapped, h, opts));
  }
  return events;
}

function buildEvent(
  type: EventType,
  h: HookEvent,
  opts: NormalizeOptions,
): SwarmEvent {
  const payload: Record<string, unknown> = {
    hookType: h.hookType,
  };
  if (h.toolName) payload.toolName = h.toolName;
  if (h.subagentName) payload.subagentName = h.subagentName;

  // Carry through selected useful fields from the raw payload.
  if (typeof h.payload.tool_input === "string") {
    payload.toolInput = h.payload.tool_input.slice(0, 2000);
  }
  if (typeof h.payload.tool_result === "string") {
    payload.toolResult = h.payload.tool_result.slice(0, 2000);
  }
  if (typeof h.payload.message === "string") {
    payload.message = h.payload.message.slice(0, 1000);
  }
  if (typeof h.payload.duration_ms === "number") {
    payload.durationMs = h.payload.duration_ms;
  }
  if (typeof h.payload.exit_code === "number") {
    payload.exitCode = h.payload.exit_code;
  }

  return {
    run_id: opts.runId,
    task_id: opts.taskId,
    type,
    ts: h.ts,
    payload,
  };
}

/** Count tool uses by tool name from a set of normalized hook events. */
export function summarizeToolUse(events: readonly SwarmEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    if (ev.type === "HookPreToolUse" && typeof ev.payload.toolName === "string") {
      const name = ev.payload.toolName;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}
