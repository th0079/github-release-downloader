import { join } from "node:path";

import { app, BrowserWindow, Menu } from "electron";

import { registerIpc } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const preloadPath = join(__dirname, "../preload/index.js");
  const htmlPath = join(__dirname, "../renderer/index.html");
  const iconPath = join(app.getAppPath(), "assets", "app-icon.png");

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: "Release Downloader",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath
    }
  });

  window.setMenuBarVisibility(false);
  void window.loadFile(htmlPath);
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  return window;
}

app.whenReady().then(() => {
  app.setAppUserModelId("release-downloader.app");
  Menu.setApplicationMenu(null);
  registerIpc(() => mainWindow);
  mainWindow = createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
