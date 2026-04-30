import type { SwarmAPI } from "./types";

/**
 * Resolves the API base URL.
 * - In Electron with IPC: uses window.swarm directly (no HTTP needed)
 * - In browser: connects to the real backend HTTP API server
 */
const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8787";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Real HTTP API client — connects to the backend server (src/ui.ts).
 * Zero mock data. Every call hits the live backend.
 */
const httpApi: SwarmAPI = {
  overview: async () => {
    try {
      const data = await fetchJson<Record<string, unknown>>("/api/overview");
      const runs = ((data.runs ?? []) as any[]).map((r) => ({
        id: r.id,
        goal: r.goal,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at ?? r.created_at,
        taskCount: r.task_count ?? r.taskCount ?? 0,
        counts: r.counts ?? {},
      }));
      return {
        ok: true,
        rootDir: (data.rootDir as string) ?? "",
        hasConfig: (data.hasConfig as boolean) ?? false,
        config: (data.config as any) ?? null,
        doctor: (data.doctor as any[]) ?? [],
        runs,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  runDetail: async (runId: string) => {
    try {
      const data = await fetchJson<Record<string, unknown>>(`/api/runs/${encodeURIComponent(runId)}`);
      if ((data as any).error) return { ok: false, error: (data as any).error };
      const tasks = ((data.tasks ?? []) as any[]).map((t) => ({
        id: t.id,
        status: t.status,
        summary: t.summary,
        owned_files: typeof t.owned_files === "string" ? JSON.parse(t.owned_files) : t.owned_files ?? [],
        risk_level: t.risk_level ?? "low",
      }));
      const replay = (data.replay ?? {}) as any;
      const events = (replay.events ?? []) as any[];
      return {
        ok: true,
        run: data.run as any,
        tasks,
        events,
        costUsd: replay.cost_usd ?? 0,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  initProject: async () => {
    try {
      const data = await fetchJson<any>("/api/init", { method: "POST" });
      return { ok: true, created: data.created ?? [], skipped: data.skipped ?? [] };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  saveConfig: async (patch) => {
    try {
      const data = await fetchJson<any>("/api/config", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      return { ok: !data.error, config: data.config, error: data.error };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  plan: async (goal) => {
    try {
      const data = await fetchJson<any>("/api/plan", {
        method: "POST",
        body: JSON.stringify({ goal }),
      });
      return {
        ok: !data.error,
        runId: data.runId ?? data.run_id,
        taskCount: data.taskCount ?? data.task_count,
        costUsd: data.costUsd ?? data.cost_usd,
        error: data.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  executeRun: async (runId, resumed) => {
    try {
      const action = resumed ? "resume" : "run";
      const data = await fetchJson<any>(`/api/runs/${encodeURIComponent(runId)}/${action}`, {
        method: "POST",
      });
      return { ok: !data.error, error: data.error };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },
};

/**
 * Returns the API client. Always uses HTTP against the backend server.
 */
export function getApi(): SwarmAPI {
  return httpApi;
}
