import React, { useCallback, useEffect, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execa } from "execa";
import { stringify as stringifyYaml } from "yaml";
import { initProject } from "./init.js";
import { loadConfig } from "./config.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { SwarmStore, type RunRow } from "./store.js";
import { ClaudeRunner } from "./runner.js";
import { Planner } from "./planner.js";
import { executeRun } from "./run-control.js";
import { loadReplay } from "./replay.js";
import { SwarmConfigSchema, type SwarmConfig, type SwarmEvent } from "./schema.js";

type DetailTab = "guide" | "runs" | "tasks" | "replay" | "doctor" | "help";
type Mode = "normal" | "goal" | "config" | "confirm-run" | "confirm-resume";
type ConfigField = "parallelism" | "budget";

interface RunSummary extends RunRow {
  taskCount: number;
  counts: Record<string, number>;
}

interface TaskSummary {
  id: string;
  status: string;
  summary: string;
  owned_files: string[];
  risk_level: "low" | "medium" | "high";
}

interface SelectedRunDetail {
  tasks: TaskSummary[];
  events: SwarmEvent[];
  costUsd: number;
}

interface Snapshot {
  runs: RunSummary[];
  doctor: DoctorCheck[];
  detail: SelectedRunDetail | null;
  config: SwarmConfig | null;
}

interface ShellResult {
  command: string;
  output: string;
  exitCode: number | null;
}

interface AppState {
  selected: number;
  tab: DetailTab;
  mode: Mode;
  configField: ConfigField;
  draftGoal: string;
  draftParallelism: string;
  draftBudget: string;
  promptHistory: string[];
  historyIndex: number | null;
  snapshot: Snapshot;
  shellResult: ShellResult | null;
  busy: boolean;
  message: string;
}

const h = React.createElement;

// ── Box-drawing characters ──────────────────────────────────────────
const BOX = {
  tl: "\u256D", tr: "\u256E", bl: "\u2570", br: "\u256F",
  h: "\u2500", v: "\u2502", vr: "\u251C", vl: "\u2524",
  dot: "\u00B7", diamond: "\u25C6", circle: "\u25CF",
  ring: "\u25CB", check: "\u2713", cross: "\u2717",
  arrow: "\u25B6", ellipsis: "\u2026", bar: "\u2588",
} as const;

interface CommandSpec {
  name: string;
  aliases: string[];
  category: "Plan" | "Run" | "View" | "System";
  description: string;
}

const COMMANDS: CommandSpec[] = [
  { name: "run", aliases: ["start"], category: "Run", description: "Run the selected plan after confirmation" },
  { name: "resume", aliases: [], category: "Run", description: "Continue an interrupted selected run" },
  { name: "runs", aliases: ["sessions"], category: "View", description: "Show recent plans and their status" },
  { name: "tasks", aliases: ["plan"], category: "View", description: "Show the task plan for the selected run" },
  { name: "replay", aliases: ["log"], category: "View", description: "Show the event timeline and cost rollup" },
  { name: "env", aliases: ["doctor"], category: "System", description: "Show environment and config checks" },
  { name: "settings", aliases: ["config"], category: "System", description: "Edit parallelism and budget" },
  { name: "refresh", aliases: [], category: "System", description: "Reload runs, tasks, config, and checks" },
  { name: "init", aliases: [], category: "Plan", description: "Scaffold swarm config in this repo" },
  { name: "new", aliases: ["home"], category: "Plan", description: "Return to the request-first guide" },
  { name: "clear", aliases: [], category: "System", description: "Clear shell output and return to the guide" },
  { name: "help", aliases: ["?"], category: "System", description: "Show this command reference" },
  { name: "quit", aliases: ["exit"], category: "System", description: "Close the TUI" },
];

export async function startTui(rootDir: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("swarm tui requires an interactive terminal");
  }

  const instance = render(h(SwarmTui, { rootDir }), {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}

function SwarmTui({ rootDir }: { rootDir: string }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 100;
  const rows = stdout.rows ?? 32;
  const [state, setState] = useState<AppState>({
    selected: 0,
    tab: "guide",
    mode: "normal",
    configField: "parallelism",
    draftGoal: "",
    draftParallelism: "",
    draftBudget: "",
    promptHistory: [],
    historyIndex: null,
    snapshot: { runs: [], doctor: [], detail: null, config: null },
    shellResult: null,
    busy: true,
    message: "Loading...",
  });

  const refresh = useCallback(async (selected = state.selected, preferRunnable = false) => {
    setState((prev) => ({ ...prev, busy: true, message: "Refreshing..." }));
    try {
      const snapshot = await loadSnapshot(rootDir, selected);
      const nextSelected = preferRunnable
        ? preferredRunIndex(snapshot.runs, selected)
        : clamp(selected, 0, Math.max(0, snapshot.runs.length - 1));
      const nextSnapshot = nextSelected === selected ? snapshot : await loadSnapshot(rootDir, nextSelected);
      setState((prev) => ({
        ...prev,
        selected: nextSelected,
        draftGoal: prev.draftGoal,
        draftParallelism: prev.draftParallelism || String(nextSnapshot.config?.parallelism ?? 2),
        draftBudget: prev.draftBudget || String(nextSnapshot.config?.budget_usd ?? 5),
        snapshot: nextSnapshot,
        busy: false,
        message: "Ready",
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        busy: false,
        message: errorMessage(err),
      }));
    }
  }, [rootDir, state.selected]);

  useEffect(() => {
    void refresh(0, true);
    // Initial load only. Input handlers call refresh with the latest selected
    // index so the callback dependency does not create a polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDir]);

  const selectedRun = state.snapshot.runs[state.selected];
  const selectedRunUsable = hasRunnablePlan(selectedRun);

  const runAction = useCallback(async (resumed: boolean) => {
    if (!selectedRun) {
      setState((prev) => ({ ...prev, message: "No run selected" }));
      return;
    }
    setState((prev) => ({ ...prev, busy: true, message: resumed ? "Resuming run..." : "Running workers..." }));
    try {
      const result = await executeRun(rootDir, selectedRun.id, { resumed });
      const snapshot = await loadSnapshot(rootDir, state.selected);
      setState((prev) => ({
        ...prev,
        snapshot,
        busy: false,
        message: `${resumed ? "Resume" : "Run"} complete: done=${result.summary.done} failed=${result.summary.failed} blocked=${result.summary.blocked}`,
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, busy: false, message: errorMessage(err) }));
    }
  }, [rootDir, selectedRun, state.selected]);

  const saveGoal = useCallback(async (goal: string) => {
    const current = await loadConfigOrDefault(rootDir);
    const next = SwarmConfigSchema.parse({ ...current, goal: goal.trim() || current.goal });
    await writeFile(join(rootDir, "swarm.yaml"), stringifyYaml(next), "utf8");
    return next;
  }, [rootDir]);

  const saveConfigDraft = useCallback(async (parallelism: string, budget: string) => {
    const current = await loadConfigOrDefault(rootDir);
    const next = SwarmConfigSchema.parse({
      ...current,
      parallelism: parsePositiveInt(parallelism, current.parallelism),
      budget_usd: parsePositiveNumber(budget, current.budget_usd),
    });
    await writeFile(join(rootDir, "swarm.yaml"), stringifyYaml(next), "utf8");
    return next;
  }, [rootDir]);

  const planRun = useCallback(async (goal?: string) => {
    setState((prev) => ({ ...prev, busy: true, message: "Planning with Claude..." }));
    let runId = "";
    let usedFallback = false;
    try {
      const expandedGoal = goal !== undefined ? await expandFileReferences(rootDir, goal) : undefined;
      const cfg = expandedGoal !== undefined ? await saveGoal(expandedGoal) : await loadConfig(rootDir);
      runId = randomUUID();
      const store = new SwarmStore(rootDir);
      try {
        store.insertRun(runId, cfg.goal);
        const planner = new Planner(new ClaudeRunner(), cfg);
        const { plan, costUsd, attempts, fallbackUsed, fallbackReason } = await planner.plan(rootDir);
        usedFallback = fallbackUsed;
        store.appendEvent({
          run_id: runId,
          type: "PlanCreated",
          ts: new Date().toISOString(),
          payload: { goal: cfg.goal, taskCount: plan.tasks.length, costUsd, attempts, fallbackUsed },
        });
        if (fallbackUsed) {
          store.appendEvent({
            run_id: runId,
            type: "PlanFallbackUsed",
            ts: new Date().toISOString(),
            payload: { reason: fallbackReason ?? "planner output was not usable", attempts },
          });
        }
        for (const task of plan.tasks) store.insertTask(runId, task);
        store.setRunStatus(runId, "ready");
      } catch (err) {
        store.setRunStatus(runId, "failed");
        throw err;
      } finally {
        store.close();
      }
      const snapshot = await loadSnapshot(rootDir, 0);
      const selected = Math.max(0, snapshot.runs.findIndex((run) => run.id === runId));
      setState((prev) => ({
        ...prev,
        selected,
        snapshot,
        draftGoal: "",
        promptHistory: goal ? appendPromptHistory(prev.promptHistory, goal) : prev.promptHistory,
        historyIndex: null,
        busy: false,
        message: usedFallback ? `Fallback plan saved: ${runId.slice(0, 8)}` : `Plan saved: ${runId.slice(0, 8)}`,
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, busy: false, message: errorMessage(err) }));
    }
  }, [rootDir, saveGoal]);

  const init = useCallback(async () => {
    setState((prev) => ({ ...prev, busy: true, message: "Initializing project..." }));
    try {
      const result = await initProject(rootDir);
      const snapshot = await loadSnapshot(rootDir, state.selected);
      setState((prev) => ({
        ...prev,
        snapshot,
        busy: false,
        message: `Init done: ${result.created.length} created, ${result.skipped.length} skipped`,
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, busy: false, message: errorMessage(err) }));
    }
  }, [rootDir, state.selected]);

  const executeShell = useCallback(async (raw: string) => {
    const command = raw.trim().replace(/^!/, "").trim();
    if (!command) {
      setState((prev) => ({ ...prev, message: "Type a shell command after !" }));
      return;
    }
    setState((prev) => ({ ...prev, busy: true, mode: "normal", draftGoal: "", message: `Running !${command}` }));
    try {
      const result = await execa(command, {
        cwd: rootDir,
        shell: true,
        reject: false,
        timeout: 30_000,
        all: true,
      });
      setState((prev) => ({
        ...prev,
        busy: false,
        shellResult: {
          command,
          output: trimShellOutput(result.all || result.stdout || result.stderr || "(no output)"),
          exitCode: result.exitCode ?? null,
        },
        promptHistory: appendPromptHistory(prev.promptHistory, `!${command}`),
        historyIndex: null,
        message: result.exitCode === 0 ? `Shell command complete: !${command}` : `Shell command exited ${result.exitCode}`,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        busy: false,
        shellResult: { command, output: errorMessage(err), exitCode: null },
        promptHistory: appendPromptHistory(prev.promptHistory, `!${command}`),
        historyIndex: null,
        message: errorMessage(err),
      }));
    }
  }, [rootDir]);

  const runCommand = useCallback((raw: string): boolean => {
    const command = resolveCommand(raw);
    if (!command) return false;
    setState((prev) => ({ ...prev, draftGoal: "", historyIndex: null }));
    if (command === "help" || command === "?") {
      setState((prev) => ({ ...prev, tab: "help", message: "Showing command reference" }));
      return true;
    }
    if (command === "run" || command === "start") {
      if (!selectedRunUsable) {
        setState((prev) => ({ ...prev, tab: "guide", message: "Create a plan with tasks first" }));
        return true;
      }
      setState((prev) => ({ ...prev, mode: "confirm-run", message: "Confirm run: y/Enter to run, Esc to cancel" }));
      return true;
    }
    if (command === "resume") {
      if (!selectedRunUsable) {
        setState((prev) => ({ ...prev, tab: "guide", message: "No runnable plan selected" }));
        return true;
      }
      setState((prev) => ({ ...prev, mode: "confirm-resume", message: "Confirm resume: y/Enter to resume, Esc to cancel" }));
      return true;
    }
    if (command === "runs") {
      setState((prev) => ({ ...prev, tab: "runs", message: "Showing recent runs" }));
      return true;
    }
    if (command === "tasks" || command === "plan") {
      setState((prev) => ({ ...prev, tab: "tasks", message: "Showing task plan" }));
      return true;
    }
    if (command === "replay" || command === "log") {
      setState((prev) => ({ ...prev, tab: "replay", message: "Showing replay timeline" }));
      return true;
    }
    if (command === "env" || command === "doctor") {
      setState((prev) => ({ ...prev, tab: "doctor", message: "Showing environment checks" }));
      return true;
    }
    if (command === "settings" || command === "config") {
      setState((prev) => ({
        ...prev,
        mode: "config",
        configField: "parallelism",
        draftParallelism: prev.draftParallelism || String(prev.snapshot.config?.parallelism ?? 2),
        draftBudget: prev.draftBudget || String(prev.snapshot.config?.budget_usd ?? 5),
        message: "Edit settings, Tab switches field, Enter saves",
      }));
      return true;
    }
    if (command === "refresh") {
      void refresh(state.selected);
      return true;
    }
    if (command === "init") {
      void init();
      return true;
    }
    if (command === "new") {
      setState((prev) => ({ ...prev, tab: "guide", shellResult: null, message: "Ready for a new request" }));
      return true;
    }
    if (command === "clear") {
      setState((prev) => ({ ...prev, tab: "guide", shellResult: null, message: "Cleared" }));
      return true;
    }
    if (command === "quit" || command === "exit") {
      exit();
      return true;
    }
    setState((prev) => ({ ...prev, tab: "help", message: `Unknown command: /${command}` }));
    return true;
  }, [exit, init, refresh, selectedRunUsable, state.selected]);

  useInput((input, key) => {
    if (state.mode === "confirm-run" || state.mode === "confirm-resume") {
      if (key.escape || input === "n" || input === "q") {
        setState((prev) => ({ ...prev, mode: "normal", message: "Run canceled" }));
        return;
      }
      if (input === "y" || key.return) {
        const resumed = state.mode === "confirm-resume";
        setState((prev) => ({ ...prev, mode: "normal" }));
        void runAction(resumed);
      }
      return;
    }

    if (state.mode === "goal") {
      if (key.escape) {
        setState((prev) => ({ ...prev, mode: "normal", message: "Goal edit canceled" }));
        return;
      }
      if (key.return) {
        const goal = state.draftGoal.trim();
        if (!hasMeaningfulGoal(goal)) {
          setState((prev) => ({ ...prev, message: "Type a request before planning" }));
          return;
        }
        setState((prev) => ({ ...prev, mode: "normal" }));
        if (isShellCommand(goal)) {
          void executeShell(goal);
          return;
        }
        if (isSlashCommand(goal)) {
          void runCommand(goal);
          return;
        }
        void planRun(goal);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setState((prev) => recallPromptHistory(prev, key.upArrow ? -1 : 1));
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => ({ ...prev, draftGoal: prev.draftGoal.slice(0, -1), historyIndex: null }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setState((prev) => ({ ...prev, draftGoal: `${prev.draftGoal}${input}`, historyIndex: null }));
      }
      return;
    }

    if (state.mode === "config") {
      if (key.escape) {
        setState((prev) => ({ ...prev, mode: "normal", message: "Config edit canceled" }));
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        setState((prev) => ({ ...prev, configField: prev.configField === "parallelism" ? "budget" : "parallelism" }));
        return;
      }
      if (key.return) {
        setState((prev) => ({ ...prev, busy: true, mode: "normal", message: "Saving config..." }));
        void saveConfigDraft(state.draftParallelism, state.draftBudget)
          .then(async () => {
            const snapshot = await loadSnapshot(rootDir, state.selected);
            setState((prev) => ({ ...prev, snapshot, busy: false, message: "Config saved" }));
          })
          .catch((err) => setState((prev) => ({ ...prev, busy: false, message: errorMessage(err) })));
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => editConfigDraft(prev, (value) => value.slice(0, -1)));
        return;
      }
      if (/^[0-9.]$/.test(input)) {
        setState((prev) => editConfigDraft(prev, (value) => `${value}${input}`));
      }
      return;
    }

    if (state.busy) return;
    if (input === "q") exit();
    if (key.return && hasMeaningfulGoal(state.draftGoal)) {
      if (isShellCommand(state.draftGoal)) {
        void executeShell(state.draftGoal);
        return;
      }
      if (isSlashCommand(state.draftGoal)) {
        void runCommand(state.draftGoal);
        return;
      }
      void planRun(state.draftGoal);
      return;
    }
    if (input === "1") {
      setState((prev) => ({
        ...prev,
        mode: "goal",
        draftGoal: "",
        historyIndex: null,
        message: "Describe the work, then press Enter to plan",
      }));
    }
    if (input === "2") {
      if (!selectedRunUsable) {
        setState((prev) => ({ ...prev, tab: "guide", message: "Create a plan with tasks first" }));
        return;
      }
      setState((prev) => ({ ...prev, mode: "confirm-run", message: "Confirm run: y/Enter to run, Esc to cancel" }));
    }
    if (input === "3") setState((prev) => ({ ...prev, tab: prev.tab === "tasks" ? "replay" : "tasks" }));
    if (input === "4") {
      setState((prev) => ({
        ...prev,
        mode: "config",
        configField: "parallelism",
        draftParallelism: prev.draftParallelism || String(prev.snapshot.config?.parallelism ?? 2),
        draftBudget: prev.draftBudget || String(prev.snapshot.config?.budget_usd ?? 5),
        message: "Edit config, Tab switches field, Enter saves, Esc cancels",
      }));
    }
    if (input === "5") void refresh(state.selected);
    if (input === "j" || key.downArrow) {
      const next = clamp(state.selected + 1, 0, Math.max(0, state.snapshot.runs.length - 1));
      setState((prev) => ({ ...prev, selected: next, message: "Ready" }));
      void refresh(next);
    }
    if (input === "k" || key.upArrow) {
      const next = clamp(state.selected - 1, 0, Math.max(0, state.snapshot.runs.length - 1));
      setState((prev) => ({ ...prev, selected: next, message: "Ready" }));
      void refresh(next);
    }
    if (input === "r") void refresh(state.selected);
    if (input === "i") void init();
    if (input === "c") {
      setState((prev) => ({
        ...prev,
        mode: "config",
        configField: "parallelism",
        draftParallelism: prev.draftParallelism || String(prev.snapshot.config?.parallelism ?? 2),
        draftBudget: prev.draftBudget || String(prev.snapshot.config?.budget_usd ?? 5),
        message: "Edit config, Tab switches field, Enter saves, Esc cancels",
      }));
    }
    if (input === "g" || input === "p") {
      setState((prev) => ({
        ...prev,
        mode: "goal",
        draftGoal: "",
        historyIndex: null,
        message: "Type goal, Enter to plan, Esc to cancel",
      }));
    }
    if (input === "\u0010" || (input === "p" && key.ctrl)) void planRun();
    if (input === "n") {
      if (!selectedRunUsable) {
        setState((prev) => ({ ...prev, tab: "guide", message: "Create a plan with tasks first" }));
        return;
      }
      setState((prev) => ({ ...prev, mode: "confirm-run", message: "Confirm run: y/Enter to run, Esc to cancel" }));
    }
    if (input === "s") {
      if (!selectedRunUsable) {
        setState((prev) => ({ ...prev, tab: "guide", message: "No runnable plan selected" }));
        return;
      }
      setState((prev) => ({ ...prev, mode: "confirm-resume", message: "Confirm resume: y/Enter to resume, Esc to cancel" }));
    }
    if (input === "d") setState((prev) => ({ ...prev, tab: "doctor" }));
    if (input === "l") setState((prev) => ({ ...prev, tab: "runs", message: "Showing recent runs" }));
    if (input === "t") setState((prev) => ({ ...prev, tab: prev.tab === "tasks" ? "replay" : "tasks" }));
    if (shouldStartComposer(input, key)) {
      setState((prev) => ({
        ...prev,
        mode: "goal",
        draftGoal: input,
        historyIndex: null,
        message: "Enter to plan, Esc to cancel",
      }));
    }
  });

  const chatHeight = Math.max(8, rows - 10);

  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows },
    h(HeaderBar, {
      rootDir,
      busy: state.busy,
      doctor: state.snapshot.doctor,
      run: selectedRun,
      runIndex: state.selected,
      runCount: state.snapshot.runs.length,
      width: columns,
    }),
    h(Divider, { width: columns }),
    h(ChatArea, {
      width: columns,
      height: chatHeight,
      run: selectedRun,
      detail: state.snapshot.detail,
      doctor: state.snapshot.doctor,
      tab: state.tab,
      runs: state.snapshot.runs,
      selected: state.selected,
      shellResult: state.shellResult,
      busy: state.busy,
      message: state.message,
    }),
    h(Divider, { width: columns }),
    h(ConfirmOverlay, { mode: state.mode, run: selectedRun, width: columns }),
    h(PromptBar, {
      goal: state.draftGoal,
      mode: state.mode,
      width: columns,
      rootDir,
      config: state.snapshot.config,
      field: state.configField,
      parallelism: state.draftParallelism,
      budget: state.draftBudget,
    }),
    h(StatusBar, {
      width: columns,
      busy: state.busy,
      message: state.message,
      run: selectedRun,
      detail: state.snapshot.detail,
      tab: state.tab,
      mode: state.mode,
    }),
  );
}

function editConfigDraft(prev: AppState, edit: (value: string) => string): AppState {
  return prev.configField === "parallelism"
    ? { ...prev, draftParallelism: edit(prev.draftParallelism) }
    : { ...prev, draftBudget: edit(prev.draftBudget) };
}

// ══════════════════════════════════════════════════════════════════════
//  UI COMPONENTS — opencode-inspired design
// ══════════════════════════════════════════════════════════════════════

function Divider({ width, label }: { width: number; label?: string }): React.ReactElement {
  if (label) {
    const pad = Math.max(0, width - label.length - 4);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return h(Text, { color: "gray", dimColor: true }, `${BOX.h.repeat(left)} ${label} ${BOX.h.repeat(right)}`);
  }
  return h(Text, { color: "gray", dimColor: true }, BOX.h.repeat(width));
}

function HeaderBar(props: {
  rootDir: string;
  busy: boolean;
  doctor: DoctorCheck[];
  run: RunSummary | undefined;
  runIndex: number;
  runCount: number;
  width: number;
}): React.ReactElement {
  const health = healthSummary(props.doctor);
  const sessionLabel = props.run
    ? `session ${props.run.id.slice(0, 8)} (${props.runIndex + 1}/${props.runCount})`
    : props.runCount > 0 ? `${props.runCount} session${props.runCount === 1 ? "" : "s"}` : "no sessions";
  const statusIcon = props.busy ? BOX.ring : BOX.diamond;
  const statusText = props.busy ? "working" : health.label;
  const statusColor = props.busy ? "yellow" : health.color;

  const leftContent = `${statusIcon} swarm-cp`;
  const midContent = `claude ${BOX.dot} ${statusText}`;
  const rightContent = sessionLabel;
  const gap = Math.max(1, props.width - leftContent.length - midContent.length - rightContent.length - 6);
  const leftGap = Math.floor(gap / 2);
  const rightGap = gap - leftGap;

  return h(
    Box,
    { paddingX: 1 },
    h(Text, { bold: true, color: "white" }, statusIcon),
    h(Text, { bold: true, color: "white" }, " swarm-cp"),
    h(Text, { color: "gray" }, " ".repeat(leftGap)),
    h(Text, { color: statusColor }, midContent),
    h(Text, { color: "gray" }, " ".repeat(rightGap)),
    h(Text, { color: "gray" }, rightContent),
  );
}

function ChatArea(props: {
  width: number;
  height: number;
  run: RunSummary | undefined;
  detail: SelectedRunDetail | null;
  doctor: DoctorCheck[];
  tab: DetailTab;
  runs: RunSummary[];
  selected: number;
  shellResult: ShellResult | null;
  busy: boolean;
  message: string;
}): React.ReactElement {
  const innerWidth = props.width - 4;
  const shellMessages = props.shellResult ? shellBubbles(props.shellResult, innerWidth) : [];

  if (props.tab === "doctor") {
    const maxChecks = Math.max(2, props.height - 4);
    return h(
      Box,
      { flexDirection: "column", height: props.height, paddingX: 2 },
      ...shellMessages,
      h(AssistantBubble, { text: "Environment checks that affect planning, isolation, and replay.", width: innerWidth }),
      ...props.doctor.slice(0, maxChecks).map((check) =>
        h(DoctorCard, { key: check.name, check, width: innerWidth }),
      ),
    );
  }

  if (props.tab === "help") {
    return h(
      Box,
      { flexDirection: "column", height: props.height, paddingX: 2 },
      ...shellMessages,
      h(AssistantBubble, { text: "Commands and keybinds. Type naturally, or prefix with /, !, @.", width: innerWidth }),
      h(HelpGrid, { width: innerWidth, height: props.height - 3 }),
    );
  }

  if (props.tab === "runs") {
    return h(
      Box,
      { flexDirection: "column", height: props.height, paddingX: 2 },
      ...shellMessages,
      h(AssistantBubble, { text: "Sessions. Use j/k to navigate, then /tasks, /replay, or /run.", width: innerWidth }),
      h(SessionList, { runs: props.runs, selected: props.selected, width: innerWidth, height: props.height - 3 }),
    );
  }

  if (!props.run) {
    return h(
      Box,
      { flexDirection: "column", height: props.height, paddingX: 2 },
      ...shellMessages,
      h(AssistantBubble, { text: "What would you like to build?", width: innerWidth }),
      h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { color: "gray" }, "  Type a request and press Enter to create a plan."),
        h(Text, { color: "gray" }, "  Use @file to attach context, !cmd for shell, /help for commands."),
        h(Text, null, ""),
        h(Text, { color: "gray", dimColor: true }, "  Example:"),
        h(Text, { color: "gray" }, "  Refactor the auth module and add comprehensive tests."),
      ),
    );
  }

  const run = props.run;
  const goal = displayGoal(run.goal);
  const unusable = isUnusablePlan(run);
  const activeTab = props.tab === "guide" ? "tasks" : props.tab;

  if (unusable) {
    return h(
      Box,
      { flexDirection: "column", height: props.height, paddingX: 2 },
      ...shellMessages,
      h(UserBubble, { text: goal, width: innerWidth }),
      h(AssistantBubble, { text: "Could not create runnable tasks for this request.", width: innerWidth, tone: "warn" }),
      h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { color: "gray" }, "  Rephrase your request and try again. Use /env to check environment."),
        h(Text, { color: "gray", dimColor: true }, `  Last: ${run.id.slice(0, 8)} ${BOX.dot} ${run.status} ${BOX.dot} ${run.taskCount} tasks`),
      ),
    );
  }

  const costStr = `$${(props.detail?.costUsd ?? 0).toFixed(4)}`;
  const planText = `Plan ready ${BOX.dot} ${progressSummary(run)} ${BOX.dot} ${costStr}`;

  const contentRows = activeTab === "tasks"
    ? (props.detail?.tasks ?? []).slice(0, Math.max(2, props.height - 7)).map((task) =>
        h(TaskCard, { key: task.id, task, width: innerWidth }),
      )
    : (props.detail?.events ?? []).slice(-Math.max(2, props.height - 7)).map((event, index) =>
        h(EventCard, { key: `${event.ts}-${event.type}-${index}`, event, width: innerWidth }),
      );

  const tabLabel = activeTab === "tasks" ? "Tasks" : "Timeline";
  const emptyLabel = activeTab === "tasks" ? "No tasks to show." : "No events yet.";

  return h(
    Box,
    { flexDirection: "column", height: props.height, paddingX: 2 },
    ...shellMessages,
    h(UserBubble, { text: goal, width: innerWidth }),
    h(AssistantBubble, { text: planText, width: innerWidth }),
    h(PanelHeader, { label: tabLabel, width: innerWidth }),
    ...(contentRows.length ? contentRows : [h(Text, { key: "empty", color: "gray" }, `  ${emptyLabel}`)]),
  );
}

// ── Chat Bubbles ────────────────────────────────────────────────────

function UserBubble({ text, width }: { text: string; width: number }): React.ReactElement {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, null,
      h(Text, { color: "#5B9BD5", bold: true }, `${BOX.circle} `),
      h(Text, { color: "#5B9BD5", bold: true }, "you"),
    ),
    h(Text, null, `  ${trim(text, width - 2)}`),
  );
}

function AssistantBubble({ text, width, tone }: { text: string; width: number; tone?: "warn" }): React.ReactElement {
  const color = tone === "warn" ? "#E5A84B" : "#6BCB77";
  const icon = tone === "warn" ? "!" : BOX.diamond;
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, null,
      h(Text, { color, bold: true }, `${icon} `),
      h(Text, { color, bold: true }, "swarm"),
    ),
    h(Text, null, `  ${trim(text, width - 2)}`),
  );
}

function shellBubbles(result: ShellResult, width: number): React.ReactElement[] {
  const exitLabel = result.exitCode === 0 ? "exit 0" : `exit ${result.exitCode ?? "?"}`;
  const outputLines = result.output.split("\n").slice(0, 8);
  const outputText = outputLines.join("\n");
  const shellProps = result.exitCode === 0
    ? { key: "shell-result", text: `${exitLabel}\n  ${outputText}`, width }
    : { key: "shell-result", text: `${exitLabel}\n  ${outputText}`, width, tone: "warn" as const };
  return [
    h(UserBubble, { key: "shell-user", text: `!${result.command}`, width }),
    h(AssistantBubble, shellProps),
  ];
}

// ── Panel Header ────────────────────────────────────────────────────

function PanelHeader({ label, width }: { label: string; width: number }): React.ReactElement {
  const lineLen = Math.max(0, width - label.length - 5);
  return h(
    Box,
    { marginTop: 1 },
    h(Text, { color: "gray", dimColor: true }, `${BOX.tl}${BOX.h} `),
    h(Text, { color: "white", bold: true }, label),
    h(Text, { color: "gray", dimColor: true }, ` ${BOX.h.repeat(lineLen)}${BOX.tr}`),
  );
}

// ── Task & Event Cards ──────────────────────────────────────────────

function TaskCard({ task, width }: { task: TaskSummary; width: number }): React.ReactElement {
  const icon = task.status === "done" ? BOX.check
    : task.status === "failed" || task.status === "needs_arbitration" ? BOX.cross
    : task.status === "running" ? BOX.arrow
    : BOX.ring;
  const color = statusColor(task.status);
  const scopeText = task.owned_files.length ? task.owned_files.join(", ") : "no files";
  const riskColor = task.risk_level === "high" ? "red" : task.risk_level === "medium" ? "yellow" : "green";
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null,
      h(Text, { color: "gray", dimColor: true }, `${BOX.v} `),
      h(Text, { color, bold: true }, icon),
      h(Text, { color: "white" }, ` ${task.id} `),
      h(Text, null, trim(task.summary, Math.max(10, width - task.id.length - 8))),
    ),
    h(Text, null,
      h(Text, { color: "gray", dimColor: true }, `${BOX.v}   `),
      h(Text, { color: "gray" }, trim(scopeText, Math.max(10, width - 20))),
      h(Text, { color: "gray" }, "  "),
      h(Text, { color: riskColor }, task.risk_level),
    ),
  );
}

function EventCard({ event, width }: { event: SwarmEvent; width: number }): React.ReactElement {
  const task = event.task_id ? ` ${event.task_id}` : "";
  const cost = typeof event.payload.costUsd === "number" ? ` $${event.payload.costUsd.toFixed(4)}` : "";
  const detail = eventDetail(event);
  return h(
    Text,
    null,
    h(Text, { color: "gray", dimColor: true }, `${BOX.v} `),
    h(Text, { color: "#5B9BD5" }, event.type.padEnd(20)),
    h(Text, { color: "gray" }, trim(`${task}${cost}  ${detail}`, Math.max(10, width - 22))),
  );
}

// ── Doctor Card ─────────────────────────────────────────────────────

function DoctorCard({ check, width }: { check: DoctorCheck; width: number }): React.ReactElement {
  const icon = check.level === "ok" ? BOX.check : check.level === "warn" ? "!" : BOX.cross;
  const color = check.level === "ok" ? "green" : check.level === "warn" ? "yellow" : "red";
  return h(
    Text,
    null,
    h(Text, { color: "gray", dimColor: true }, `${BOX.v} `),
    h(Text, { color, bold: check.level === "fail" }, `${icon} `),
    h(Text, { bold: true }, `${check.name} `),
    h(Text, { color: "gray" }, trim(check.message, Math.max(10, width - check.name.length - 6))),
  );
}

// ── Help Grid ───────────────────────────────────────────────────────

function HelpGrid({ width, height }: { width: number; height: number }): React.ReactElement {
  const visibleCommands = COMMANDS.slice(0, Math.max(3, height - 3));
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: "gray" }, `  Requests: type naturally ${BOX.dot} Shell: !command ${BOX.dot} Context: @path/to/file`),
    h(Text, { color: "gray" }, `  History: Up/Down ${BOX.dot} Config goal: Ctrl+P`),
    h(Text, null, ""),
    ...visibleCommands.map((command) => {
      const alias = command.aliases.length ? ` ${command.aliases.map((a) => `/${a}`).join(" ")}` : "";
      const catColor = command.category === "Run" ? "#6BCB77" : command.category === "Plan" ? "#5B9BD5" : command.category === "View" ? "#BB86FC" : "#E5A84B";
      return h(
        Text,
        { key: command.name },
        h(Text, { color: "gray", dimColor: true }, `${BOX.v} `),
        h(Text, { color: catColor, bold: true }, `/${command.name}`.padEnd(12)),
        h(Text, { color: "gray", dimColor: true }, alias.padEnd(14)),
        h(Text, { color: "gray" }, trim(command.description, Math.max(10, width - 30))),
      );
    }),
  );
}

// ── Session List ────────────────────────────────────────────────────

function SessionList(props: {
  runs: RunSummary[];
  selected: number;
  width: number;
  height: number;
}): React.ReactElement {
  const limit = Math.max(1, props.height - 1);
  if (!props.runs.length) {
    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, { color: "gray" }, "  No sessions yet. Type a request to start."),
    );
  }
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    ...props.runs.slice(0, limit).map((run, index) =>
      h(SessionRow, { key: run.id, run, active: index === props.selected, width: props.width }),
    ),
  );
}

function SessionRow({ run, active, width }: { run: RunSummary; active: boolean; width: number }): React.ReactElement {
  const marker = active ? BOX.arrow : " ";
  const id = run.id.slice(0, 8);
  const sColor = statusColor(run.status);
  const goalWidth = Math.max(10, width - 50);
  return h(
    Text,
    { bold: active },
    h(Text, { color: active ? "#5B9BD5" : "gray" }, `  ${marker} `),
    h(Text, { color: active ? "white" : "gray" }, id),
    h(Text, { color: "gray" }, "  "),
    h(Text, { color: sColor }, run.status.padEnd(10)),
    h(Text, { color: "gray" }, "  "),
    h(Text, { color: active ? "white" : "gray" }, trim(displayGoal(run.goal), goalWidth)),
  );
}

// ── Confirm Overlay ─────────────────────────────────────────────────

function ConfirmOverlay({ mode, run, width }: { mode: Mode; run: RunSummary | undefined; width: number }): React.ReactElement | null {
  if (mode !== "confirm-run" && mode !== "confirm-resume") return null;
  const action = mode === "confirm-run" ? "Run" : "Resume";
  const runLabel = run ? `${run.id.slice(0, 8)} ${BOX.dot} ${trim(displayGoal(run.goal), Math.max(10, width - 40))}` : "no run selected";
  return h(
    Box,
    { paddingX: 2 },
    h(Text, { color: "#E5A84B", bold: true }, `${BOX.diamond} ${action}: `),
    h(Text, null, runLabel),
    h(Text, { color: "gray" }, `  y/Enter ${BOX.dot} Esc cancel`),
  );
}

// ── Prompt Bar ──────────────────────────────────────────────────────

function PromptBar(props: {
  goal: string;
  mode: Mode;
  width: number;
  rootDir: string;
  config: SwarmConfig | null;
  field: ConfigField;
  parallelism: string;
  budget: string;
}): React.ReactElement {
  if (props.mode === "config") {
    return h(ConfigEditor, {
      config: props.config,
      field: props.field,
      parallelism: props.parallelism,
      budget: props.budget,
      width: props.width,
    });
  }

  const active = props.mode === "goal";
  const value = active ? props.goal : "";
  const cursorChar = active ? BOX.bar : "";
  const promptColor = active ? "#5B9BD5" : "gray";
  const hintText = active
    ? (props.goal.trim().startsWith("/") ? "slash command" : props.goal.trim().startsWith("!") ? "shell" : "Enter to plan, Esc to cancel")
    : "type to start, / commands, ! shell, @ files";
  const maxValueLen = Math.max(0, props.width - 12);

  const fileRefs = extractFileReferences(props.goal).slice(0, 4);
  const suggestions = props.goal.trim().startsWith("/") ? commandSuggestions(props.goal.trim()).slice(0, 4) : [];

  return h(
    Box,
    { flexDirection: "column", paddingX: 2 },
    h(Box, null,
      h(Text, { color: promptColor, bold: true }, `${BOX.arrow} `),
      h(Text, { color: active ? "white" : "gray" }, trim(value, maxValueLen)),
      h(Text, { color: "#5B9BD5" }, cursorChar),
    ),
    suggestions.length > 0
      ? h(Text, { color: "gray" }, `  ${suggestions.map((c) => `/${c.name}`).join("  ")}`)
      : fileRefs.length > 0
        ? h(Text, { color: "gray" }, `  ${fileRefs.map((ref) => `${existsSync(resolve(props.rootDir, ref)) ? BOX.check : BOX.cross} @${ref}`).join("  ")}`)
        : h(Text, { color: "gray", dimColor: true }, `  ${hintText}`),
  );
}

function ConfigEditor(props: {
  config: SwarmConfig | null;
  field: ConfigField;
  parallelism: string;
  budget: string;
  width: number;
}): React.ReactElement {
  const pActive = props.field === "parallelism";
  const bActive = props.field === "budget";
  return h(
    Box,
    { paddingX: 2 },
    h(Text, { color: "#E5A84B", bold: true }, `${BOX.diamond} Settings `),
    h(Text, { color: pActive ? "#5B9BD5" : "gray", bold: pActive, underline: pActive }, `parallelism=${props.parallelism || "_"}`),
    h(Text, { color: "gray" }, `  `),
    h(Text, { color: bActive ? "#5B9BD5" : "gray", bold: bActive, underline: bActive }, `budget=$${props.budget || "_"}`),
    h(Text, { color: "gray", dimColor: true }, `  Tab switch ${BOX.dot} Enter save ${BOX.dot} Esc cancel`),
  );
}

// ── Status Bar ──────────────────────────────────────────────────────

function StatusBar(props: {
  width: number;
  busy: boolean;
  message: string;
  run: RunSummary | undefined;
  detail: SelectedRunDetail | null;
  tab: DetailTab;
  mode: Mode;
}): React.ReactElement {
  const costStr = props.detail ? `$${props.detail.costUsd.toFixed(4)}` : "$0";
  const taskStr = props.run ? `${props.run.counts.done ?? 0}/${props.run.taskCount}` : "0/0";

  const leftParts = [
    props.busy ? "working..." : props.message,
  ];
  const rightParts = [
    `cost ${costStr}`,
    `tasks ${taskStr}`,
    `j/k nav`,
    `Enter plan`,
    `q quit`,
  ];

  const left = leftParts.join("");
  const right = rightParts.join(` ${BOX.dot} `);
  const gap = Math.max(1, props.width - left.length - right.length - 4);

  return h(
    Box,
    { paddingX: 2 },
    h(Text, { color: props.busy ? "yellow" : "gray", dimColor: !props.busy }, trim(left, Math.max(10, props.width - right.length - 6))),
    h(Text, null, " ".repeat(gap)),
    h(Text, { color: "gray", dimColor: true }, right),
  );
}

async function loadSnapshot(rootDir: string, selected: number): Promise<Snapshot> {
  const [doctor, config] = await Promise.all([runDoctor(rootDir), readConfigSafe(rootDir)]);
  const store = new SwarmStore(rootDir);
  try {
    const runs = store.listRuns().map((run) => {
      const tasks = store.listTasks(run.id);
      return {
        ...run,
        taskCount: tasks.length,
        counts: countStatuses(tasks.map((task) => task.status)),
      };
    });
    const picked = runs[clamp(selected, 0, Math.max(0, runs.length - 1))];
    const detail = picked ? loadDetail(rootDir, store, picked.id) : null;
    return { runs, doctor, detail, config };
  } finally {
    store.close();
  }
}

async function readConfigSafe(rootDir: string): Promise<SwarmConfig | null> {
  try {
    return await loadConfig(rootDir);
  } catch {
    return null;
  }
}

async function loadConfigOrDefault(rootDir: string): Promise<SwarmConfig> {
  const current = await readConfigSafe(rootDir);
  if (current) return current;
  return SwarmConfigSchema.parse({
    version: "0.1",
    goal: "Describe your goal here",
    parallelism: 2,
    budget_usd: 5,
  });
}

function loadDetail(rootDir: string, store: SwarmStore, runId: string): SelectedRunDetail {
  const replay = loadReplay(rootDir, runId);
  return {
    tasks: store.listTasks(runId).map((task) => ({
      id: task.id,
      status: task.status,
      summary: task.summary,
      owned_files: task.owned_files,
      risk_level: task.risk_level,
    })),
    events: replay.events,
    costUsd: replay.costUsd,
  };
}

function countStatuses(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const status of statuses) out[status] = (out[status] ?? 0) + 1;
  return out;
}

function eventDetail(event: SwarmEvent): string {
  if (typeof event.payload.reason === "string") return event.payload.reason;
  if (typeof event.payload.error === "string") return event.payload.error;
  if (typeof event.payload.toolName === "string") return `tool=${event.payload.toolName}`;
  if (typeof event.payload.subagentName === "string") return `subagent=${event.payload.subagentName}`;
  if (typeof event.payload.goal === "string") return event.payload.goal;
  return "";
}

function statusColor(status: string): "green" | "yellow" | "red" | "blue" | "gray" {
  if (status === "done" || status === "ready") return "green";
  if (status === "running" || status === "planning") return "blue";
  if (status === "pending" || status === "blocked") return "yellow";
  if (status === "failed" || status === "needs_arbitration" || status === "incomplete") return "red";
  return "gray";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function trim(value: string, width: number): string {
  if (width <= 3) return value.slice(0, Math.max(0, width));
  return value.length <= width ? value : `${value.slice(0, width - 3)}...`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlaceholderGoal(goal: string): boolean {
  return goal.trim().toLowerCase() === "describe your goal here";
}

function hasMeaningfulGoal(goal: string): boolean {
  return !!goal.trim() && !isPlaceholderGoal(goal);
}

function isSlashCommand(value: string): boolean {
  return value.trim().startsWith("/");
}

function isShellCommand(value: string): boolean {
  return value.trim().startsWith("!");
}

function resolveCommand(value: string): string {
  const raw = value.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!raw) return "";
  const found = COMMANDS.find((command) => command.name === raw || command.aliases.includes(raw));
  return found?.name ?? raw;
}

function commandSuggestions(value: string): CommandSpec[] {
  const query = value.trim().replace(/^\//, "").toLowerCase();
  if (!query) return COMMANDS.filter((command) => command.name !== "quit");
  return COMMANDS.filter((command) =>
    command.name.startsWith(query) || command.aliases.some((alias) => alias.startsWith(query)),
  );
}

function preferredRunIndex(runs: RunSummary[], fallback: number): number {
  if (!runs.length) return 0;
  const runnable = runs.findIndex(hasRunnablePlan);
  if (runnable >= 0) return runnable;
  return clamp(fallback, 0, runs.length - 1);
}

function displayGoal(goal: string): string {
  const clean = goal.trim();
  if (!clean || isPlaceholderGoal(clean)) return "No request set";
  return clean;
}

function shouldStartComposer(input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  if (!input || key.ctrl || key.meta) return false;
  if (!/^[\x20-\x7E]+$/.test(input)) return false;
  if (input.length > 1) return true;
  return !new Set(["1", "2", "3", "4", "5", "c", "d", "g", "i", "j", "k", "l", "n", "p", "q", "r", "s", "t"]).has(input);
}

function hasRunnablePlan(run: RunSummary | undefined): boolean {
  return !!run && run.taskCount > 0 && run.status !== "failed";
}

function isUnusablePlan(run: RunSummary | undefined): boolean {
  return !!run && (run.taskCount === 0 || run.status === "failed");
}

async function expandFileReferences(rootDir: string, goal: string): Promise<string> {
  const refs = extractFileReferences(goal);
  if (!refs.length) return goal;

  const blocks: string[] = [];
  for (const ref of refs.slice(0, 6)) {
    const abs = resolve(rootDir, ref);
    const rel = relative(rootDir, abs);
    if (rel.startsWith("..") || resolve(rootDir, rel) !== abs) continue;
    try {
      const content = await readFile(abs, "utf8");
      blocks.push(`--- ${rel} ---\n${content.slice(0, 8_000)}`);
    } catch {
      // Missing or binary references are left as plain text in the prompt.
    }
  }
  if (!blocks.length) return goal;
  return `${goal.trim()}\n\nReferenced files:\n${blocks.join("\n\n")}`;
}

function extractFileReferences(goal: string): string[] {
  return Array.from(goal.matchAll(/@([^\s]+)/g))
    .map((match) => match[1]?.replace(/^["']|["']$/g, ""))
    .filter((value): value is string => !!value);
}

function appendPromptHistory(history: string[], value: string): string[] {
  const clean = value.trim();
  if (!clean) return history;
  const next = history.filter((item) => item !== clean);
  next.push(clean);
  return next.slice(-30);
}

function recallPromptHistory(prev: AppState, direction: -1 | 1): AppState {
  if (!prev.promptHistory.length) return { ...prev, message: "No prompt history yet" };
  const last = prev.promptHistory.length - 1;
  const current = prev.historyIndex ?? (direction === -1 ? prev.promptHistory.length : -1);
  const next = clamp(current + direction, 0, last);
  return {
    ...prev,
    draftGoal: prev.promptHistory[next] ?? prev.draftGoal,
    historyIndex: next,
    message: "Prompt history",
  };
}

function trimShellOutput(output: string): string {
  const clean = output.replace(/\r\n/g, "\n").trim();
  if (!clean) return "(no output)";
  return clean.length <= 3_000 ? clean : `${clean.slice(0, 3_000)}\n... output truncated`;
}

function healthSummary(checks: DoctorCheck[]): { label: string; color: "green" | "yellow" | "red"; fail: number; warn: number } {
  const fail = checks.filter((check) => check.level === "fail").length;
  const warn = checks.filter((check) => check.level === "warn").length;
  if (fail > 0) return { label: `${fail} issue${fail === 1 ? "" : "s"} need attention`, color: "red", fail, warn };
  if (warn > 0) return { label: `${warn} warning${warn === 1 ? "" : "s"}`, color: "yellow", fail, warn };
  return { label: "ready", color: "green", fail, warn };
}

function progressSummary(run: RunSummary): string {
  const done = run.counts.done ?? 0;
  const failed = (run.counts.failed ?? 0) + (run.counts.needs_arbitration ?? 0);
  const running = run.counts.running ?? 0;
  return `Tasks: ${done}/${run.taskCount} done, ${running} running, ${failed} attention`;
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
