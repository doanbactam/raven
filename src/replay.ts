import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, type SwarmEvent } from "./schema.js";

export interface ReplaySummary {
  runId: string;
  events: SwarmEvent[];
  malformedLines: number;
  costUsd: number;
}

export function loadReplay(rootDir: string, runId: string): ReplaySummary {
  const path = join(rootDir, ".swarm", "events.jsonl");
  if (!existsSync(path)) {
    return { runId, events: [], malformedLines: 0, costUsd: 0 };
  }

  const raw = readFileSync(path, "utf8");
  const events: SwarmEvent[] = [];
  let malformedLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = EventSchema.safeParse(JSON.parse(trimmed));
      if (!parsed.success) {
        malformedLines++;
        continue;
      }
      if (parsed.data.run_id === runId) events.push(parsed.data);
    } catch {
      malformedLines++;
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { runId, events, malformedLines, costUsd: sumCost(events) };
}

export function formatReplay(summary: ReplaySummary): string {
  const lines = [
    `Replay ${summary.runId}`,
    `Events: ${summary.events.length}  Cost: $${summary.costUsd.toFixed(4)}`,
  ];
  if (summary.malformedLines > 0) {
    lines.push(`Warning: skipped ${summary.malformedLines} malformed event line(s).`);
  }
  if (summary.events.length === 0) {
    lines.push("No events found.");
    return lines.join("\n");
  }

  lines.push("");
  for (const ev of summary.events) {
    const task = ev.task_id ? ` ${ev.task_id}` : "";
    const cost = typeof ev.payload.costUsd === "number" ? ` cost=$${ev.payload.costUsd.toFixed(4)}` : "";
    const detail = eventDetail(ev);
    lines.push(`${ev.ts}  ${ev.type}${task}${cost}${detail ? `  ${detail}` : ""}`);
  }
  return lines.join("\n");
}

function sumCost(events: readonly SwarmEvent[]): number {
  let total = 0;
  for (const ev of events) {
    if (typeof ev.payload.costUsd === "number") total += ev.payload.costUsd;
  }
  return total;
}

function eventDetail(ev: SwarmEvent): string {
  switch (ev.type) {
    case "PlanCreated":
      return [
        typeof ev.payload.taskCount === "number" ? `tasks=${ev.payload.taskCount}` : "",
        ev.payload.fallbackUsed === true ? "fallback" : "",
        typeof ev.payload.goal === "string" ? truncate(ev.payload.goal, 80) : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "PlanFallbackUsed":
      return typeof ev.payload.reason === "string" ? truncate(ev.payload.reason, 120) : "fallback";
    case "RunCompleted":
      return [
        ...(["done", "failed", "blocked"] as const)
          .map((k) => (typeof ev.payload[k] === "number" ? `${k}=${ev.payload[k]}` : "")),
        typeof ev.payload.totalCostUsd === "number" ? `total_cost=$${ev.payload.totalCostUsd.toFixed(4)}` : "",
        ev.payload.budgetExceeded === true ? "BUDGET_EXCEEDED" : "",
        ev.payload.resumed === true ? "resumed" : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "TaskFailed":
    case "GateFailed":
    case "ArbitrationRequested":
      return typeof ev.payload.reason === "string"
        ? truncate(ev.payload.reason, 120)
        : typeof ev.payload.error === "string"
          ? truncate(ev.payload.error, 120)
          : "";
    case "WorktreeOpened":
      return typeof ev.payload.path === "string" ? ev.payload.path : "";
    case "HookPreToolUse":
    case "HookPostToolUse":
      return typeof ev.payload.toolName === "string" ? `tool=${ev.payload.toolName}` : "";
    case "HookSubagentStart":
    case "HookSubagentStop":
      return typeof ev.payload.subagentName === "string"
        ? `subagent=${ev.payload.subagentName}`
        : typeof ev.payload.hookType === "string"
          ? ev.payload.hookType
          : "";
    case "HookNotification":
      return typeof ev.payload.message === "string"
        ? truncate(ev.payload.message, 120)
        : typeof ev.payload.hookType === "string"
          ? ev.payload.hookType
          : "";
    case "HookStop":
      return typeof ev.payload.exitCode === "number"
        ? `exit=${ev.payload.exitCode}`
        : "";
    default:
      return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

export const _internals = { sumCost, eventDetail, truncate };
