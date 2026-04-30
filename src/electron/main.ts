import { app, BrowserWindow } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let apiUrl = "";

async function startApiServer(): Promise<string> {
  const base = resolve(__dirname, "../dist");
  const uiModule = await import(`${base}/ui.js`);
  const rootDir = process.cwd();
  const url: string = await uiModule.startUiServer(rootDir, {
    host: "127.0.0.1",
    port: 8787,
    open: false,
  });
  console.log(`[electron] API server at ${url}`);
  return url;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#09090b",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    frame: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(join(__dirname, "../dist-app/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App Lifecycle ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  apiUrl = await startApiServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
