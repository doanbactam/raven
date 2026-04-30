// Preload script — intentionally minimal.
// The React app communicates with the backend via HTTP API (src/ui.ts),
// not through Electron IPC. This keeps the architecture unified:
// the same HTTP client works in both browser and Electron.
export {};
