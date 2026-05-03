import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Download,
  Eye,
  FileCode,
  GitBranch,
  ListChecks,
  Play,
  RotateCcw,
  ShieldCheck,
  XCircle,
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
  if (props.view === "doctor") return <DoctorView doctor={props.doctor} />;
  if (props.view === "settings") {
    return (
      <SettingsView
        config={props.config}
        hasConfig={props.hasConfig}
        onInit={props.onInit}
        onSaveConfig={props.onSaveConfig}
        busy={props.busy}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {!props.run ? (
          <WelcomeMessage hasConfig={props.hasConfig} onInit={props.onInit} />
        ) : (
          <>
            <RunHeader run={props.run} costUsd={props.costUsd} />

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
              <div className="space-y-4 min-w-0">
                <Pipeline run={props.run} tasks={props.tasks} />
                <TaskPanel tasks={props.tasks} />
                <EventPanel events={props.events} />
              </div>

              <div className="space-y-4 lg:sticky lg:top-5">
                <ActionPanel
                  run={props.run}
                  tasks={props.tasks}
                  busy={props.busy}
                  costUsd={props.costUsd}
                  onRun={props.onRun}
                  onResume={props.onResume}
                />
                <EvidencePanel run={props.run} tasks={props.tasks} events={props.events} />
              </div>
            </div>
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
          swarm control plane
        </h2>
        <p className="text-[12px] text-text-muted max-w-xs leading-relaxed">
          Create a plan, run workers, then review the evidence before moving on.
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

function RunHeader({ run, costUsd }: { run: RunSummary; costUsd: number }) {
  const goal =
    run.goal.trim().toLowerCase() === "describe your goal here"
      ? "Untitled run"
      : run.goal;
  const done = run.counts.done ?? 0;
  const failed = (run.counts.failed ?? 0) + (run.counts.needs_arbitration ?? 0);
  const running = run.counts.running ?? 0;
  const pending = Math.max(run.taskCount - done - failed - running, 0);

  return (
    <section className="animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <StatusBadge status={run.status} />
        <span className="text-[10px] text-text-muted/50 font-mono">
          {run.id.slice(0, 12)}
        </span>
        <span className="text-[10px] text-text-muted/40 ml-auto">
          updated {relativeTime(run.updated_at)} ago
        </span>
      </div>
      <h1 className="text-[18px] leading-snug font-semibold text-text-primary tracking-tight max-w-3xl">
        {goal}
      </h1>
      <div className="flex items-center gap-2 flex-wrap mt-3 text-[11px]">
        <Chip color="muted" label={`${run.taskCount} task${run.taskCount === 1 ? "" : "s"}`} />
        {done > 0 && <Chip color="success" label={`${done} done`} />}
        {running > 0 && <Chip color="info" label={`${running} running`} />}
        {failed > 0 && <Chip color="danger" label={`${failed} attention`} />}
        {pending > 0 && <Chip color="muted" label={`${pending} pending`} />}
        {costUsd > 0 && <Chip color="warning" label={`$${costUsd.toFixed(4)} spent`} />}
      </div>
    </section>
  );
}

function Pipeline({ run, tasks }: { run: RunSummary; tasks: TaskSummary[] }) {
  const failed = tasks.filter((task) => isAttentionStatus(task.status)).length;
  const hasTasks = run.taskCount > 0;
  const running = run.status === "running";
  const done = run.status === "done";
  const blocked = run.status === "failed" || run.status === "incomplete" || failed > 0;

  const steps = [
    {
      label: "Plan",
      detail: hasTasks ? `${run.taskCount} tasks created` : "waiting for task plan",
      state: hasTasks ? "done" : blocked ? "blocked" : "active",
      icon: <GitBranch size={13} />,
    },
    {
      label: "Run",
      detail: running
        ? "workers in progress"
        : done
          ? "all workers finished"
          : blocked
            ? `${failed || "some"} task${failed === 1 ? "" : "s"} need attention`
            : hasTasks
              ? "ready to start workers"
              : "starts after planning",
      state: running ? "active" : done ? "done" : blocked ? "blocked" : hasTasks ? "ready" : "idle",
      icon: <Activity size={13} />,
    },
    {
      label: "Review",
      detail: done ? "inspect changed files" : "available after workers finish",
      state: done ? "active" : "idle",
      icon: <Eye size={13} />,
    },
  ];

  return (
    <section className="animate-fade-in rounded-lg border border-border bg-surface-1/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2">
        <ListChecks size={12} className="text-text-muted/60" />
        <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
          Run pipeline
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3">
        {steps.map((step, index) => (
          <PipelineStep
            key={step.label}
            {...step}
            last={index === steps.length - 1}
          />
        ))}
      </div>
    </section>
  );
}

function PipelineStep({
  label,
  detail,
  state,
  icon,
  last,
}: {
  label: string;
  detail: string;
  state: string;
  icon: React.ReactNode;
  last: boolean;
}) {
  const tone =
    state === "done"
      ? "text-success bg-success-soft"
      : state === "active"
        ? "text-info bg-info-soft"
        : state === "blocked"
          ? "text-danger bg-danger-soft"
          : state === "ready"
            ? "text-accent bg-accent-soft"
            : "text-text-muted bg-surface-2";

  return (
    <div className={`px-3 py-3 ${last ? "" : "border-b md:border-b-0 md:border-r border-border/50"}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-6 h-6 rounded-md flex items-center justify-center ${tone}`}>
          {icon}
        </span>
        <span className="text-[12px] font-medium text-text-primary">{label}</span>
      </div>
      <p className="text-[11px] text-text-muted leading-snug">{detail}</p>
    </div>
  );
}

function ActionPanel({
  run,
  tasks,
  busy,
  costUsd,
  onRun,
  onResume,
}: {
  run: RunSummary;
  tasks: TaskSummary[];
  busy: boolean;
  costUsd: number;
  onRun: (runId: string) => void;
  onResume: (runId: string) => void;
}) {
  const failedTasks = tasks.filter((task) => isAttentionStatus(task.status)).length;
  const pendingTasks = tasks.filter((task) => task.status === "pending" || task.status === "ready").length;
  const canExecute = run.taskCount > 0 && run.status === "ready";
  const canResume = run.taskCount > 0 && (run.status === "incomplete" || run.status === "failed");
  const isTerminal = run.status === "done";
  const isRunning = run.status === "running";
  const planningFailed = run.status === "failed" && run.taskCount === 0;

  let body = "Create a plan first. Workers can only run after tasks exist.";
  if (planningFailed) body = "Planning failed before tasks were created. Refine the goal or check Doctor.";
  else if (isRunning) body = "Workers are running. Keep this run selected to watch status and evidence update.";
  else if (isTerminal) body = "Run finished. Review changed files and task evidence before starting another pass.";
  else if (canExecute) body = "Tasks are planned and ready. Start workers when the scope looks correct.";
  else if (canResume && failedTasks > 0) body = "One or more tasks need attention. Resume only the unfinished work.";
  else if (canResume) body = "Some planned work did not finish. Resume the pending tasks.";

  return (
    <aside className="animate-fade-in rounded-lg border border-border bg-surface-1/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2">
        <ShieldCheck size={12} className="text-text-muted/60" />
        <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
          Next action
        </span>
      </div>
      <div className="p-3">
        <p className="text-[12px] text-text-secondary leading-relaxed mb-3">{body}</p>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <Metric label="failed" value={failedTasks} tone={failedTasks > 0 ? "danger" : "muted"} />
          <Metric label="pending" value={pendingTasks} tone={pendingTasks > 0 ? "warning" : "muted"} />
          <Metric label="cost" value={costUsd > 0 ? `$${costUsd.toFixed(2)}` : "$0"} tone="muted" />
        </div>
        {canExecute && (
          <button
            onClick={() => onRun(run.id)}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-[11px] font-medium hover:bg-accent/80 transition-all disabled:opacity-30"
          >
            <Play size={12} />
            Run workers
          </button>
        )}
        {canResume && (
          <button
            onClick={() => onResume(run.id)}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-2 border border-border text-[11px] text-text-secondary hover:text-text-primary hover:border-border-active transition-all disabled:opacity-30"
          >
            <RotateCcw size={12} />
            {failedTasks > 0 ? "Resume failed tasks" : "Resume pending work"}
          </button>
        )}
      </div>
    </aside>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: "danger" | "warning" | "muted";
}) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : "text-text-secondary";
  return (
    <div className="rounded-md bg-surface-2/60 px-2 py-1.5">
      <div className={`text-[12px] font-mono font-medium tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-text-muted uppercase tracking-wider">{label}</div>
    </div>
  );
}

function EvidencePanel({
  run,
  tasks,
  events,
}: {
  run: RunSummary;
  tasks: TaskSummary[];
  events: SwarmEvent[];
}) {
  const files = Array.from(new Set(tasks.flatMap((task) => task.owned_files))).slice(0, 5);
  const lastEvent = events[events.length - 1];

  return (
    <aside className="animate-fade-in rounded-lg border border-border bg-surface-1/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2">
        <FileCode size={12} className="text-text-muted/60" />
        <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
          Evidence
        </span>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <div className="text-[10px] text-text-muted/60 uppercase tracking-wider mb-1">
            touched files
          </div>
          {files.length === 0 ? (
            <p className="text-[11px] text-text-muted">No file ownership reported yet.</p>
          ) : (
            <div className="space-y-1">
              {files.map((file) => (
                <div key={file} className="text-[10px] text-text-secondary font-mono truncate">
                  {file}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="pt-3 border-t border-border/50">
          <div className="text-[10px] text-text-muted/60 uppercase tracking-wider mb-1">
            latest signal
          </div>
          <p className="text-[11px] text-text-secondary leading-snug">
            {lastEvent ? eventLabel(lastEvent).label : statusMessage(run)}
          </p>
        </div>
      </div>
    </aside>
  );
}

function TaskPanel({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) {
    return (
      <section className="animate-fade-in rounded-lg border border-border bg-surface-1/50 p-4">
        <div className="flex items-center gap-2 mb-1">
          <FileCode size={12} className="text-text-muted/60" />
          <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
            Tasks
          </span>
        </div>
        <p className="text-[12px] text-text-muted">
          No tasks yet. Planning may still be running or the goal needs refinement.
        </p>
      </section>
    );
  }

  return (
    <section className="animate-fade-in rounded-lg border border-border bg-surface-1/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2">
        <FileCode size={12} className="text-text-muted/60" />
        <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
          Task evidence
        </span>
        <span className="text-[10px] text-text-muted/40 ml-auto tabular-nums font-mono">
          {tasks.length}
        </span>
      </div>
      <div className="divide-y divide-border/40">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const icon =
    task.status === "done" ? (
      <CheckCircle2 size={12} className="text-success/80" />
    ) : isAttentionStatus(task.status) ? (
      <XCircle size={12} className="text-danger/80" />
    ) : task.status === "running" ? (
      <Clock size={12} className="text-info animate-spin-slow" />
    ) : (
      <Circle size={12} className="text-text-muted/40" />
    );
  const riskColor =
    task.risk_level === "high"
      ? "text-danger"
      : task.risk_level === "medium"
        ? "text-warning"
        : "text-text-muted";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_110px_68px_88px] gap-2 xl:gap-3 px-3 py-2.5 hover:bg-surface-2/30 transition-colors items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          {icon}
          <span className="text-[11px] font-mono font-medium text-text-primary/90">
            {task.id}
          </span>
        </div>
        <div className="text-[11px] text-text-secondary/80 leading-snug">{task.summary}</div>
      </div>
      <div className="text-[10px] text-text-muted/50 font-mono truncate">
        {task.owned_files.length > 0 ? task.owned_files.join(", ") : "none"}
      </div>
      <div className={`text-[10px] font-mono ${riskColor}`}>{task.risk_level}</div>
      <div className="text-[10px] font-mono text-text-muted">{task.status}</div>
    </div>
  );
}

function EventPanel({ events }: { events: SwarmEvent[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const recent = events.slice(-30).reverse();
  const shown = expanded ? recent : recent.slice(0, 8);

  return (
    <section className="animate-fade-in rounded-lg border border-border bg-surface-1/50 overflow-hidden">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="w-full px-3 py-2 border-b border-border/60 flex items-center gap-2 hover:bg-surface-2/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-muted/60" />
        ) : (
          <ChevronRight size={12} className="text-text-muted/60" />
        )}
        <Clock size={12} className="text-text-muted/60" />
        <span className="text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
          Activity timeline
        </span>
        <span className="text-[10px] text-text-muted/40 ml-auto tabular-nums font-mono">
          {events.length}
        </span>
      </button>
      {shown.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-text-muted">
          No events recorded yet.
        </div>
      ) : (
        <div className="divide-y divide-border/30">
          {shown.map((event, i) => (
            <EventRow key={`${event.ts}-${i}`} event={event} />
          ))}
          {!expanded && recent.length > 8 && (
            <button
              onClick={() => setExpanded(true)}
              className="w-full px-3 py-2 text-[10px] text-text-muted/50 hover:text-text-muted hover:bg-surface-2/30 transition-colors"
            >
              Show {recent.length - 8} more events
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function EventRow({ event }: { event: SwarmEvent }) {
  const mapped = eventLabel(event);

  return (
    <div className="grid grid-cols-[86px_minmax(0,1fr)_72px] gap-3 px-3 py-2 hover:bg-surface-2/30 transition-colors">
      <span className="text-[10px] text-text-muted/50 font-mono">
        {formatTime(event.ts)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] font-medium ${mapped.color}`}>{mapped.label}</span>
          {event.task_id && (
            <span className="text-[10px] text-text-muted/40 font-mono truncate">
              {event.task_id}
            </span>
          )}
        </div>
        {mapped.detail && (
          <div className="text-[10px] text-text-muted/50 truncate mt-0.5">
            {mapped.detail}
          </div>
        )}
      </div>
      <span className="text-[10px] text-text-muted/40 font-mono truncate text-right">
        {event.type}
      </span>
    </div>
  );
}

function eventLabel(event: SwarmEvent): { label: string; detail: string; color: string } {
  const detail =
    typeof event.payload.reason === "string"
      ? event.payload.reason
      : typeof event.payload.error === "string"
        ? event.payload.error
        : typeof event.payload.toolName === "string"
          ? event.payload.toolName
          : typeof event.payload.goal === "string"
            ? event.payload.goal
            : "";
  const cost =
    typeof event.payload.costUsd === "number"
      ? `$${event.payload.costUsd.toFixed(4)}`
      : "";
  const labels: Record<string, string> = {
    plan_started: "Plan started",
    plan_completed: "Plan ready",
    run_started: "Workers started",
    task_started: "Task started",
    task_completed: "Task done",
    task_failed: "Task failed",
    resume_started: "Resume started",
    quality_gate_started: "Review started",
    quality_gate_completed: "Review complete",
  };
  const color = event.type.includes("fail")
    ? "text-danger"
    : event.type.includes("completed") || event.type.includes("done")
      ? "text-success"
      : event.type.includes("started")
        ? "text-info"
        : "text-accent";

  return {
    label: labels[event.type] ?? event.type.replaceAll("_", " "),
    detail: cost ? [detail, cost].filter(Boolean).join(" · ") : detail,
    color,
  };
}

function StatusBadge({ status }: { status: string }) {
  const style: Record<string, string> = {
    done: "bg-success-soft text-success",
    ready: "bg-accent-soft text-accent",
    running: "bg-info-soft text-info",
    failed: "bg-danger-soft text-danger",
    incomplete: "bg-warning-soft text-warning",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${style[status] ?? "bg-surface-2 text-text-muted"}`}>
      {status}
    </span>
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

function isAttentionStatus(status: string) {
  return status === "failed" || status === "needs_arbitration";
}

function statusMessage(run: RunSummary) {
  if (run.status === "ready") return "Tasks are planned and waiting for workers.";
  if (run.status === "running") return "Workers are running.";
  if (run.status === "done") return "Run completed.";
  if (run.status === "failed") return "Run needs attention.";
  return "No activity yet.";
}

function relativeTime(iso: string): string {
  const ms = Math.max(Date.now() - new Date(iso).getTime(), 0);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
