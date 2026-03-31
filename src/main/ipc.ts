import { stat } from "node:fs/promises";

import { BrowserWindow, dialog, ipcMain, shell } from "electron";

import { ipcChannels } from "../shared/constants.js";
import type {
  ApiErrorCode,
  ApiResult,
  DownloadAssetInput,
  DownloadProgressEvent,
  RepositoryLookupInput,
  RepositorySuggestion,
  SettingsState
} from "../shared/types.js";
import { cancelDownload, downloadAsset } from "./services/downloadService.js";
import { lookupRepositoryWithReleases, searchRepositorySuggestions } from "./services/githubService.js";
import {
  clearGithubToken,
  loadSettings,
  rememberRepository,
  saveGithubToken,
  saveLastDownloadDirectory
} from "./services/settingsService.js";

function success<T>(data: T): ApiResult<T> { return { ok: true, data }; }
function failure(message: string, code: ApiErrorCode = "UNKNOWN_ERROR"): ApiResult<never> {
  return { ok: false, error: { code, message } };
}

function isReleaseAsset(value: unknown): value is DownloadAssetInput["asset"] {
  if (!value || typeof value !== "object") return false;
  const asset = value as Record<string, unknown>;
  return typeof asset.id === "number"
    && typeof asset.name === "string"
    && typeof asset.size === "number"
    && typeof asset.downloadUrl === "string";
}

function isDownloadAssetInput(value: unknown): value is DownloadAssetInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const directory = input.directory;
  return typeof input.repository === "string"
    && isReleaseAsset(input.asset)
    && (directory === undefined || directory === null || typeof directory === "string");
}

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  const completedDownloadPaths = new Map<string, string>();

  ipcMain.handle(ipcChannels.getSettings, async () => success<SettingsState>(await loadSettings()));

  ipcMain.handle(ipcChannels.saveGithubToken, async (_event, token: string) => {
    if (typeof token !== "string" || token.trim().length === 0) return failure("Enter a GitHub token first.");
    try {
      return success(await saveGithubToken(token));
    } catch (error) {
      if (error instanceof Error && error.message === "TOKEN_STORAGE_UNAVAILABLE") {
        return failure("OS secure storage is unavailable, so the token was not saved.", "TOKEN_STORAGE_UNAVAILABLE");
      }
      throw error;
    }
  });

  ipcMain.handle(ipcChannels.clearGithubToken, async () => success(await clearGithubToken()));

  ipcMain.handle(ipcChannels.chooseDirectory, async () => {
    const window = getMainWindow();
    if (!window) return failure("No active window.");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], title: "Choose download directory" });
    if (result.canceled || result.filePaths.length === 0) return success<string | null>(null);
    await saveLastDownloadDirectory(result.filePaths[0]);
    return success(result.filePaths[0]);
  });

  ipcMain.handle(ipcChannels.searchRepositories, async (_event, query: string) => {
    if (typeof query !== "string") return failure("Invalid repository query.", "INVALID_INPUT");
    const result = await searchRepositorySuggestions(query);
    return result.ok ? success<RepositorySuggestion[]>(result.data) : result;
  });

  ipcMain.handle(ipcChannels.lookupRepository, async (_event, input: RepositoryLookupInput) => {
    if (!input || typeof input.repository !== "string") {
      return failure("Invalid repository input.", "INVALID_INPUT");
    }
    const result = await lookupRepositoryWithReleases(input.repository);
    if (result.ok) await rememberRepository(input.repository.trim());
    return result;
  });

  ipcMain.handle(ipcChannels.openExternal, async (_event, url: string) => {
    if (!/^https:\/\/github\.com\//i.test(url)) return failure("Only GitHub URLs can be opened.");
    await shell.openExternal(url);
    return success(true);
  });

  ipcMain.handle(ipcChannels.revealInFolder, async (_event, jobId: string) => {
    if (typeof jobId !== "string" || jobId.trim().length === 0) return failure("No completed download to reveal.", "INVALID_INPUT");
    const targetPath = completedDownloadPaths.get(jobId);
    if (!targetPath) return failure("The selected download is no longer available.", "INVALID_INPUT");
    await stat(targetPath);
    shell.showItemInFolder(targetPath);
    return success(true);
  });

  ipcMain.handle(ipcChannels.downloadAsset, async (_event, input: unknown) => {
    const window = getMainWindow();
    if (!window) return failure("No active window.");
    if (!isDownloadAssetInput(input)) return failure("Invalid download request.", "INVALID_INPUT");

    const settings = await loadSettings();
    const targetDirectory = input.directory ?? settings.lastDownloadDirectory;
    if (!targetDirectory) return failure("Choose a download directory first.");

    try {
      await saveLastDownloadDirectory(targetDirectory);
      const job = await downloadAsset(input, targetDirectory, (nextJob) => {
        const payload: DownloadProgressEvent = { job: nextJob };
        window.webContents.send(ipcChannels.downloadProgress, payload);
      });
      completedDownloadPaths.set(job.id, job.targetPath);
      return success(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed.";
      return { ok: false, error: { code: "DOWNLOAD_FAILED", message } };
    }
  });

  ipcMain.handle(ipcChannels.cancelDownload, async (_event, jobId: string) => success(cancelDownload(jobId)));
}
