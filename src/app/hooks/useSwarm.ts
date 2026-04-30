import { useState, useCallback, useEffect, useRef } from "react";
import { getApi } from "../api";
import type {
  OverviewResult,
  RunDetailResult,
  RunSummary,
  TaskSummary,
  SwarmEvent,
  DoctorCheck,
  SwarmConfig,
} from "../types";

export interface SwarmState {
  rootDir: string;
  hasConfig: boolean;
  config: SwarmConfig | null;
  doctor: DoctorCheck[];
  runs: RunSummary[];
  selectedRunId: string | null;
  selectedRun: RunSummary | null;
  tasks: TaskSummary[];
  events: SwarmEvent[];
  costUsd: number;
  busy: boolean;
  message: string;
}

const initialState: SwarmState = {
  rootDir: "",
  hasConfig: false,
  config: null,
  doctor: [],
  runs: [],
  selectedRunId: null,
  selectedRun: null,
  tasks: [],
  events: [],
  costUsd: 0,
  busy: false,
  message: "Loading...",
};

export function useSwarm() {
  const [state, setState] = useState<SwarmState>(initialState);
  const api = useRef(getApi());
  const pollingRef = useRef(false);

  // Core data fetcher — silent=true avoids showing busy/refreshing for background polls
  const fetchOverview = useCallback(async (silent: boolean) => {
    if (!silent) setState((s) => ({ ...s, busy: true, message: "Refreshing..." }));
    try {
      const result: OverviewResult = await api.current.overview();
      if (!result.ok) {
        if (!silent) setState((s) => ({ ...s, busy: false, message: result.error ?? "Failed to load" }));
        return;
      }
      const runs = result.runs ?? [];
      setState((s) => {
        const selected = s.selectedRunId
          ? runs.find((r) => r.id === s.selectedRunId) ?? runs[0] ?? null
          : runs[0] ?? null;
        return {
          ...s,
          rootDir: result.rootDir ?? "",
          hasConfig: result.hasConfig ?? false,
          config: result.config ?? null,
          doctor: result.doctor ?? [],
          runs,
          selectedRunId: selected?.id ?? null,
          selectedRun: selected,
          busy: silent ? s.busy : false,
          message: silent ? s.message : "Ready",
        };
      });
    } catch (err: any) {
      if (!silent) setState((s) => ({ ...s, busy: false, message: err.message }));
    }
  }, []);

  const refresh = useCallback(() => fetchOverview(false), [fetchOverview]);

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const detail: RunDetailResult = await api.current.runDetail(runId);
      if (!detail.ok) return;
      setState((s) => ({
        ...s,
        selectedRunId: runId,
        selectedRun: s.runs.find((r) => r.id === runId) ?? null,
        tasks: detail.tasks ?? [],
        events: detail.events ?? [],
        costUsd: detail.costUsd ?? 0,
      }));
    } catch {
      // silent
    }
  }, []);

  const selectRun = useCallback((runId: string) => {
    setState((s) => ({
      ...s,
      selectedRunId: runId,
      selectedRun: s.runs.find((r) => r.id === runId) ?? null,
      tasks: [],
      events: [],
      costUsd: 0,
    }));
    void loadRunDetail(runId);
  }, [loadRunDetail]);

  const initProject = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, message: "Initializing..." }));
    try {
      const result = await api.current.initProject();
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, message: result.error ?? "Init failed" }));
        return;
      }
      setState((s) => ({ ...s, message: `Created ${result.created?.length ?? 0} files` }));
      await refresh();
    } catch (err: any) {
      setState((s) => ({ ...s, busy: false, message: err.message }));
    }
  }, [refresh]);

  const saveConfig = useCallback(async (patch: Record<string, unknown>) => {
    setState((s) => ({ ...s, busy: true, message: "Saving config..." }));
    try {
      const result = await api.current.saveConfig(patch);
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, message: result.error ?? "Save failed" }));
        return;
      }
      setState((s) => ({ ...s, config: result.config ?? s.config, busy: false, message: "Config saved" }));
    } catch (err: any) {
      setState((s) => ({ ...s, busy: false, message: err.message }));
    }
  }, []);

  const plan = useCallback(async (goal?: string) => {
    setState((s) => ({ ...s, busy: true, message: "Planning with Claude..." }));
    try {
      const result = await api.current.plan(goal);
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, message: result.error ?? "Plan failed" }));
        return;
      }
      const msg = `Plan created: ${result.taskCount} tasks, $${result.costUsd?.toFixed(4)}`;
      setState((s) => ({ ...s, selectedRunId: result.runId ?? null, busy: false, message: msg }));
      await fetchOverview(true);
      if (result.runId) await loadRunDetail(result.runId);
    } catch (err: any) {
      setState((s) => ({ ...s, busy: false, message: err.message }));
    }
  }, [fetchOverview, loadRunDetail]);

  const executeRun = useCallback(async (runId: string, resumed = false) => {
    setState((s) => ({ ...s, busy: true, message: resumed ? "Resuming..." : "Running workers..." }));
    try {
      const result = await api.current.executeRun(runId, resumed);
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, message: result.error ?? "Run failed" }));
        return;
      }
      setState((s) => ({ ...s, busy: false, message: "Run complete" }));
      await fetchOverview(true);
      await loadRunDetail(runId);
    } catch (err: any) {
      setState((s) => ({ ...s, busy: false, message: err.message }));
    }
  }, [fetchOverview, loadRunDetail]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-load run detail when selectedRunId changes
  useEffect(() => {
    if (state.selectedRunId && state.tasks.length === 0) {
      void loadRunDetail(state.selectedRunId);
    }
  }, [state.selectedRunId, state.tasks.length, loadRunDetail]);

  // Background polling every 5s — silent, never blocks UI
  useEffect(() => {
    const id = setInterval(() => {
      if (state.busy || pollingRef.current) return;
      pollingRef.current = true;
      void fetchOverview(true).then(() => {
        if (state.selectedRunId) return loadRunDetail(state.selectedRunId);
      }).finally(() => { pollingRef.current = false; });
    }, 5000);
    return () => clearInterval(id);
  }, [state.busy, state.selectedRunId, fetchOverview, loadRunDetail]);

  return {
    state,
    refresh,
    selectRun,
    initProject,
    saveConfig,
    plan,
    executeRun,
  };
}
