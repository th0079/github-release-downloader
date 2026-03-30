import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app, safeStorage } from "electron";

import type { SettingsState } from "../../shared/types.js";

interface StoredSettings {
  lastDownloadDirectory: string | null;
  recentRepositories: string[];
  githubToken: string | null;
  githubTokenEncrypted?: string | null;
}

const defaultStoredSettings: StoredSettings = {
  lastDownloadDirectory: null,
  recentRepositories: [],
  githubToken: null
};

function getSettingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

async function ensureSettingsDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function toPublicSettings(settings: StoredSettings): SettingsState {
  return {
    lastDownloadDirectory: settings.lastDownloadDirectory,
    recentRepositories: settings.recentRepositories,
    hasGithubToken: Boolean(settings.githubToken)
  };
}

function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return token;
  }

  return safeStorage.encryptString(token).toString("base64");
}

function decryptToken(value: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return value.trim() || null;
    }

    return safeStorage.decryptString(Buffer.from(value, "base64")).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

async function loadStoredSettings(): Promise<StoredSettings> {
  const settingsPath = getSettingsPath();

  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;

    return {
      lastDownloadDirectory: parsed.lastDownloadDirectory ?? null,
      recentRepositories: Array.isArray(parsed.recentRepositories) ? parsed.recentRepositories.slice(0, 5) : [],
      githubToken:
        typeof parsed.githubTokenEncrypted === "string" && parsed.githubTokenEncrypted.trim().length > 0
          ? decryptToken(parsed.githubTokenEncrypted)
          : typeof parsed.githubToken === "string" && parsed.githubToken.trim().length > 0
            ? parsed.githubToken.trim()
            : null
    };
  } catch {
    return defaultStoredSettings;
  }
}

async function saveStoredSettings(settings: StoredSettings): Promise<void> {
  const settingsPath = getSettingsPath();
  await ensureSettingsDirectory(settingsPath);

  const serialized: StoredSettings = {
    lastDownloadDirectory: settings.lastDownloadDirectory,
    recentRepositories: settings.recentRepositories,
    githubToken: null,
    githubTokenEncrypted: settings.githubToken ? encryptToken(settings.githubToken) : null
  };

  await writeFile(settingsPath, JSON.stringify(serialized, null, 2), "utf8");
}

export async function loadSettings(): Promise<SettingsState> {
  return toPublicSettings(await loadStoredSettings());
}

export async function getGithubToken(): Promise<string | null> {
  const settings = await loadStoredSettings();
  return settings.githubToken;
}

export async function saveGithubToken(token: string): Promise<SettingsState> {
  const settings = await loadStoredSettings();
  const next: StoredSettings = {
    ...settings,
    githubToken: token.trim() || null
  };
  await saveStoredSettings(next);
  return toPublicSettings(next);
}

export async function clearGithubToken(): Promise<SettingsState> {
  const settings = await loadStoredSettings();
  const next: StoredSettings = {
    ...settings,
    githubToken: null
  };
  await saveStoredSettings(next);
  return toPublicSettings(next);
}

export async function rememberRepository(repository: string): Promise<SettingsState> {
  const settings = await loadStoredSettings();
  const recentRepositories = [repository, ...settings.recentRepositories.filter((item) => item !== repository)].slice(0, 5);
  const next: StoredSettings = { ...settings, recentRepositories };
  await saveStoredSettings(next);
  return toPublicSettings(next);
}

export async function saveLastDownloadDirectory(directory: string): Promise<SettingsState> {
  const settings = await loadStoredSettings();
  const next: StoredSettings = { ...settings, lastDownloadDirectory: directory };
  await saveStoredSettings(next);
  return toPublicSettings(next);
}
