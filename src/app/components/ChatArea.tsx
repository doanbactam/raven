import React, { useRef, useEffect } from "react";
import {
  Play,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  FileCode,
  Download,
} from "lucide-react";
import type { View } from "../App";
import type {
  RunSummary,
  TaskSummary,
  SwarmEvent,
  DoctorCheck,
  SwarmConfig,
} from "../types";

interface ChatAreaProps {
  view: View;
  run: RunSummary | null;
  tasks: TaskSummary[];
  events: SwarmEvent[];
  costUsd: number;
  doctor: DoctorCheck[];
  config: SwarmConfig | null;
  busy: boolean;
  hasConfig: boolean;
  onInit: () => void;
  onRun: (runId: string) => void;
  onResume: (runId: string) => void;
  onSaveConfig: (patch: Record<string, unknown>) => void;
}

export function ChatArea(props: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [props.tasks, props.events, props.run]);

  if (props.view === "doctor") return <DoctorView doctor={props.doctor} />;
  if (props.view === "settings")
    return (
      <SettingsView
        config={props.config}
        hasConfig={props.hasConfig}
        onInit={props.onInit}
        onSaveConfig={props.onSaveConfig}
        busy={props.busy}
      />
    );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">
        {!props.run ? (
          <WelcomeMessage hasConfig={props.hasConfig} onInit={props.onInit} />
        ) : (
          <>
            <UserMessage text={props.run.goal} />

            <RunStatus run={props.run} costUsd={props.costUsd} tasks={props.tasks} />

            {props.tasks.length > 0 && (
              <TaskPanel tasks={props.tasks} />
            )}

            {props.events.length > 0 && (
              <EventPanel events={props.events} />
            )}

            <ActionBar
              run={props.run}
              busy={props.busy}
              onRun={props.onRun}
              onResume={props.onResume}
            />
          </>
        )}
      </div>
    </div>
  );
}

function WelcomeMessage({
  hasConfig,
  onInit,
}: {
  hasConfig: boolean;
  onInit: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh]">
      <div className="text-center mb-8">
        <h2 className="text-[15px] font-semibold text-text-primary mb-1.5">
          swarm
        </h2>
        <p className="text-[12px] text-text-muted max-w-xs leading-relaxed">
          Describe a goal. Swarm plans, parallelizes, and executes with Claude.
        </p>
      </div>
      {!hasConfig && (
        <button
          onClick={onInit}
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-surface-2 border border-border text-[11px] text-text-secondary hover:text-text-primary hover:border-border-active transition-all mb-6"
        >
          <Download size={12} />
          Initialize swarm.yaml
        </button>
      )}
    </div>
  );
}

function UserMessage({ text }: { text: string }) {
  const isPlaceholder = text.trim().toLowerCase() === "describe your goal here";
  return (
    <div className="animate-fade-in">
      <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider mb-1">goal</div>
      <div className={`text-[13px] leading-relaxed ${isPlaceholder ? "text-text-muted italic" : "text-text-primary"}`}>
        {isPlaceholder ? "No goal set" : text}
      </div>
    </div>
  );
}

function RunStatus({
  run,
  costUsd,
  tasks,
}: {
  run: RunSummary;
  costUsd: number;
  tasks: TaskSummary[];
}) {
  const done = run.counts.done ?? 0;
  const failed = (run.counts.failed ?? 0) + (run.counts.needs_arbitration ?? 0);
  const running = run.counts.running ?? 0;
  const pending = run.taskCount - done - failed - running;

  // Status badge
  const statusStyle: Record<string, string> = {
    done: "bg-success-soft text-success",
    ready: "bg-info-soft text-info",
    running: "bg-info-soft text-info",
    failed: "bg-danger-soft text-danger",
    incomplete: "bg-warning-soft text-warning",
  };
  const badge = statusStyle[run.status] ?? "bg-surface-2 text-text-muted";

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">status</div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge}`}>
          {run.status}
        </span>
      </div>

      {run.status === "failed" && run.taskCount === 0 ? (
        <div className="text-[12px] text-danger/70 bg-danger-soft rounded-lg px-3 py-2.5 border border-danger/10 leading-relaxed">
          Planning failed — Claude could not generate tasks for this goal.
          <br />
          <span className="text-text-muted/50 text-[11px]">Try a more specific goal or check Doctor for environment issues.</span>
        </div>
      ) : run.taskCount === 0 ? (
        <div className="text-[12px] text-text-muted">
          No tasks yet — planning in progress or goal needs refinement.
        </div>
      ) : (
        <>
          <div className="text-[13px] text-text-secondary mb-3">
            {run.taskCount} task{run.taskCount === 1 ? "" : "s"}
            {costUsd > 0 && <> · <span className="tabular-nums">${costUsd.toFixed(4)}</span> spent</>}
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            {done > 0 && <Chip color="success" label={`${done} done`} />}
            {running > 0 && <Chip color="info" label={`${running} running`} />}
            {failed > 0 && <Chip color="danger" label={`${failed} failed`} />}
            {pending > 0 && <Chip color="muted" label={`${pending} pending`} />}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ color, label }: { color: string; label: string }) {
  const styles: Record<string, string> = {
    success: "bg-success-soft text-success",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
    muted: "bg-surface-2 text-text-muted",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md font-medium ${styles[color] ?? styles.muted}`}>
      {label}
    </span>
  );
}

function TaskPanel({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <FileCode size={11} className="text-text-muted/50" />
        <span className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">
          Tasks
        </span>
        <span className="text-[10px] text-text-muted/30 ml-auto tabular-nums font-mono">
          {tasks.length}
        </span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden bg-surface-1/50">
        {tasks.map((task, i) => (
          <TaskRow key={task.id} task={task} last={i === tasks.length - 1} />
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task, last }: { task: TaskSummary; last: boolean }) {
  const icon =
    task.status === "done" ? (
      <CheckCircle2 size={12} className="text-success/80" />
    ) : task.status === "failed" || task.status === "needs_arbitration" ? (
      <XCircle size={12} className="text-danger/80" />
    ) : task.status === "running" ? (
      <Clock size={12} className="text-info animate-spin-slow" />
    ) : (
      <Circle size={12} className="text-text-muted/40" />
    );

  const riskColor =
    task.risk_level === "high"
      ? "text-danger/60"
      : task.risk_level === "medium"
        ? "text-warning/60"
        : "text-text-muted/40";

  return (
    <div className={`px-3 py-2 hover:bg-surface-2/30 transition-colors ${last ? "" : "border-b border-border/50"}`}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-px">
            <span className="text-[11px] font-mono font-medium text-text-primary/90">
              {task.id}
            </span>
            <span className={`text-[9px] font-mono ${riskColor}`}>
              {task.risk_level}
            </span>
          </div>
          <div className="text-[11px] text-text-secondary/80 leading-snug">{task.summary}</div>
          {task.owned_files.length > 0 && (
            <div className="text-[10px] text-text-muted/40 font-mono mt-0.5 truncate">
              {task.owned_files.join("  ")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EventPanel({ events }: { events: SwarmEvent[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const recent = events.slice(-30).reverse();
  const shown = expanded ? recent : recent.slice(0, 8);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <Clock size={11} className="text-text-muted/50" />
        <span className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">
          Events
        </span>
        <span className="text-[10px] text-text-muted/30 ml-auto tabular-nums font-mono">
          {events.length}
        </span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden bg-surface-1/50">
        {shown.map((event, i) => (
          <EventRow key={`${event.ts}-${i}`} event={event} last={i === shown.length - 1 && !(!expanded && recent.length > 8)} />
        ))}
        {!expanded && recent.length > 8 && (
          <button
            onClick={() => setExpanded(true)}
            className="w-full px-3 py-1.5 text-[10px] text-text-muted/50 hover:text-text-muted hover:bg-surface-2/30 transition-colors border-t border-border/50"
          >
            Show {recent.length - 8} more
          </button>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, last }: { event: SwarmEvent; last: boolean }) {
  const detail =
    typeof event.payload.reason === "string"
      ? event.payload.reason
      : typeof event.payload.error === "string"
        ? event.payload.error
        : typeof event.payload.toolName === "string"
          ? event.payload.toolName as string
          : typeof event.payload.goal === "string"
            ? (event.payload.goal as string)
            : "";
  const cost =
    typeof event.payload.costUsd === "number"
      ? `$${(event.payload.costUsd as number).toFixed(4)}`
      : "";

  return (
    <div className={`px-3 py-1.5 hover:bg-surface-2/30 transition-colors ${last ? "" : "border-b border-border/30"}`}>
      <div className="flex items-center gap-2 text-[10px] font-mono">
        <span className="text-accent/60 shrink-0">{event.type}</span>
        {event.task_id && (
          <span className="text-text-muted/40">{event.task_id}</span>
        )}
        {cost && <span className="text-warning/50">{cost}</span>}
        <span className="text-text-muted/30 truncate">{detail}</span>
      </div>
    </div>
  );
}

function ActionBar({
  run,
  busy,
  onRun,
  onResume,
}: {
  run: RunSummary;
  busy: boolean;
  onRun: (runId: string) => void;
  onResume: (runId: string) => void;
}) {
  const canExecute = run.taskCount > 0 && (run.status === "ready");
  const canResume = run.taskCount > 0 && (run.status === "incomplete" || run.status === "failed");
  const isDone = run.status === "done";
  const isRunning = run.status === "running";

  if (isDone || isRunning || (!canExecute && !canResume)) return null;

  return (
    <div className="animate-fade-in flex items-center gap-2 pt-1">
      {canExecute && (
        <button
          onClick={() => onRun(run.id)}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-[11px] font-medium hover:bg-accent/80 transition-all disabled:opacity-30"
        >
          <Play size={11} />
          Execute
        </button>
      )}
      {canResume && (
        <button
          onClick={() => onResume(run.id)}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-border text-[11px] text-text-secondary hover:text-text-primary hover:border-border-active transition-all disabled:opacity-30"
        >
          <RotateCcw size={11} />
          Resume
        </button>
      )}
    </div>
  );
}

function DoctorView({ doctor }: { doctor: DoctorCheck[] }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider mb-3">
          Environment
        </div>
        {doctor.length === 0 ? (
          <div className="text-[12px] text-text-muted">No checks available</div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden bg-surface-1/50">
            {doctor.map((check, i) => (
              <div
                key={check.name}
                className={`flex items-center gap-3 px-3 py-2 ${i < doctor.length - 1 ? "border-b border-border/50" : ""}`}
              >
                {check.level === "ok" ? (
                  <CheckCircle2 size={12} className="text-success/70 shrink-0" />
                ) : check.level === "warn" ? (
                  <AlertTriangle size={12} className="text-warning/70 shrink-0" />
                ) : (
                  <XCircle size={12} className="text-danger/70 shrink-0" />
                )}
                <span className="text-[11px] font-mono text-text-primary/80 w-28 shrink-0">
                  {check.name}
                </span>
                <span className="text-[11px] text-text-secondary/60 truncate">{check.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView({
  config,
  hasConfig,
  onInit,
  onSaveConfig,
  busy,
}: {
  config: SwarmConfig | null;
  hasConfig: boolean;
  onInit: () => void;
  onSaveConfig: (patch: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [goal, setGoal] = React.useState(config?.goal ?? "");
  const [parallelism, setParallelism] = React.useState(String(config?.parallelism ?? 2));
  const [budget, setBudget] = React.useState(String(config?.budget_usd ?? 5));

  React.useEffect(() => {
    if (config) {
      setGoal(config.goal);
      setParallelism(String(config.parallelism));
      setBudget(String(config.budget_usd));
    }
  }, [config]);

  const handleSave = () => {
    onSaveConfig({
      goal,
      parallelism: parseInt(parallelism, 10) || 2,
      budget_usd: parseFloat(budget) || 5,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-6 py-6 space-y-5">
        <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">
          Configuration
        </div>

        {!hasConfig && (
          <div className="px-3 py-2.5 rounded-lg border border-warning/20 bg-warning-soft">
            <div className="text-[11px] text-warning/80 font-medium mb-1">
              No swarm.yaml found
            </div>
            <button
              onClick={onInit}
              disabled={busy}
              className="text-[10px] text-warning/60 underline hover:no-underline"
            >
              Initialize project
            </button>
          </div>
        )}

        <div className="space-y-3">
          <label className="block">
            <span className="text-[10px] text-text-muted/60 mb-1 block font-medium uppercase tracking-wider">Goal</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="w-full bg-surface-2/70 border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/50 transition-all resize-y min-h-[80px] font-sans"
              placeholder="Describe what swarm should accomplish..."
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] text-text-muted/60 mb-1 block font-medium uppercase tracking-wider">
                Parallelism
              </span>
              <input
                type="number"
                min="1"
                max="16"
                value={parallelism}
                onChange={(e) => setParallelism(e.target.value)}
                className="w-full bg-surface-2/70 border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary font-mono focus:outline-none focus:border-accent/50 transition-all"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-text-muted/60 mb-1 block font-medium uppercase tracking-wider">
                Budget (USD)
              </span>
              <input
                type="number"
                min="1"
                step="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full bg-surface-2/70 border border-border rounded-lg px-3 py-2 text-[12px] text-text-primary font-mono focus:outline-none focus:border-accent/50 transition-all"
              />
            </label>
          </div>

          <button
            onClick={handleSave}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-[11px] font-medium hover:bg-accent/80 transition-all disabled:opacity-30"
          >
            Save
          </button>
        </div>

        {config && (
          <div className="space-y-3 pt-2">
            <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">
              Agents & Routing
            </div>
            <div className="border border-border rounded-lg overflow-hidden bg-surface-1/50">
              <ConfigRow label="planner" value={config.planner} />
              <ConfigRow label="worker" value={config.worker} />
              <ConfigRow label="quality_gate" value={config.quality_gate} />
              {config.routing && Object.entries(config.routing).map(([k, v]) => (
                <ConfigRow key={k} label={`routing.${k}`} value={String(v)} />
              ))}
            </div>

            {config.policies && Object.keys(config.policies).length > 0 && (
              <>
                <div className="text-[10px] font-medium text-text-muted/50 uppercase tracking-wider">
                  Policies
                </div>
                <div className="border border-border rounded-lg overflow-hidden bg-surface-1/50">
                  {Object.entries(config.policies).map(([k, v]) => (
                    <ConfigRow key={k} label={k} value={String(v)} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  const isBool = value === "true" || value === "false";
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/30 last:border-0">
      <span className="text-[10px] font-mono text-text-muted/60 w-36 shrink-0">{label}</span>
      <span className={`text-[11px] font-mono truncate ${isBool ? (value === "true" ? "text-success/70" : "text-text-muted/40") : "text-text-primary/70"}`}>
        {value}
      </span>
    </div>
  );
}
