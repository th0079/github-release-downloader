import type {
  DownloadJob,
  ReleaseAsset,
  ReleaseDownloaderApi,
  ReleaseSummary,
  RepositoryLookupResult,
  RepositorySuggestion,
  SettingsState
} from "../shared/types.js";

type PlatformFilter = "all" | "windows" | "mac" | "linux" | "source";
type LogType = "ok" | "dl" | "warn" | "err";

interface LogEntry {
  time: string;
  type: LogType;
  text: string;
}

const text = {
  appTitle: "Release Downloader",
  badge: "UNOFFICIAL",
  settingsButton: "SETTINGS",
  settingsTitle: "Settings",
  searchLabel: "Repository Search",
  tokenPlaceholder: "Paste GitHub PAT to raise rate limits",
  tokenSave: "SAVE TOKEN",
  tokenClear: "CLEAR TOKEN",
  tokenSaved: "Token saved",
  tokenMissing: "No token saved",
  tokenStorageSecure: "PAT is stored only when OS secure storage is available.",
  tokenStorageUnavailable: "Secure storage is unavailable on this device, so PAT saving is disabled.",
  legalNotice: "Unofficial app. Downloaded files are third-party software; verify licenses, publisher trust, and SHA256 before running.",
  searchPlaceholder: "Search repository or owner/repo",
  searchButton: "FETCH",
  repoPrefix: "github.com/",
  selectAll: "select all",
  clearLog: "clear",
  logTitle: "output log",
  noRepository: "Search a repository to load releases and assets.",
  noAssets: "No assets in the selected release.",
  copyUrls: "Copy URLs",
  wgetScript: "wget script",
  startDownload: "DOWNLOAD",
  downloads: "downloads",
  totalSelected: "selected",
  preloadMissing: "Preload API is missing. Fully close the app and start it again.",
  invalidSelection: "Select at least one asset to download.",
  filterAll: "all",
  filterWindows: "windows",
  filterMac: "macOS",
  filterLinux: "linux",
  filterSource: "source",
  suggestions: "suggestions",
  noSuggestions: "No results",
  openRepository: "Open on GitHub",
  revealFolder: "Open folder",
  complete: "complete",
  fail: "fail",
  active: "active",
  latest: "latest",
  preRelease: "pre-release"
} as const;

function getApi(): ReleaseDownloaderApi | null {
  return typeof window === "undefined" ? null : window.releaseDownloader ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(size: number): string {
  if (size === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function currentTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function fileExtension(name: string): string {
  const match = name.match(/\.([a-z0-9.]+)$/i);
  return match ? match[1].toLowerCase() : "bin";
}

function classifyPlatform(asset: ReleaseAsset): PlatformFilter {
  const lower = asset.name.toLowerCase();
  if (lower.includes("windows") || lower.includes("win") || lower.endsWith(".exe") || lower.endsWith(".msi")) return "windows";
  if (lower.includes("darwin") || lower.includes("mac") || lower.includes("osx") || lower.endsWith(".dmg") || lower.endsWith(".pkg")) return "mac";
  if (lower.includes("linux") || lower.endsWith(".appimage") || lower.endsWith(".deb") || lower.endsWith(".rpm")) return "linux";
  return "source";
}

function platformLabel(platform: PlatformFilter): string {
  if (platform === "windows") return "win";
  if (platform === "source") return "source";
  return platform;
}

function releaseDotClass(release: ReleaseSummary): string {
  if (release.isDraft) return "draft";
  if (release.isPrerelease) return "pre";
  return "stable";
}

export function createApp(root: HTMLDivElement): void {
  let shouldRestoreRepositoryFocus = false;
  let repositorySelectionStart: number | null = null;
  let repositorySelectionEnd: number | null = null;
  let renderScheduled = false;
  let lastMarkup = "";
  let suggestionDebounceId: ReturnType<typeof setTimeout> | null = null;
  let releaseTabsScrollLeft = 0;

  const state: {
    settings: SettingsState;
    repositoryInput: string;
    tokenInput: string;
    result: RepositoryLookupResult | null;
    loading: boolean;
    errorMessage: string | null;
    jobs: DownloadJob[];
    selectedReleaseIndex: number;
    selectedAssetIds: Set<number>;
    filter: PlatformFilter;
    logs: LogEntry[];
    downloading: boolean;
    suggestions: RepositorySuggestion[];
    dropdownOpen: boolean;
    focusedSuggestionIndex: number;
    searchRequestId: number;
    lastSuggestionQuery: string;
    settingsOpen: boolean;
  } = {
    settings: { lastDownloadDirectory: null, recentRepositories: [], hasGithubToken: false, canPersistGithubToken: false },
    repositoryInput: "",
    tokenInput: "",
    result: null,
    loading: false,
    errorMessage: null,
    jobs: [],
    selectedReleaseIndex: 0,
    selectedAssetIds: new Set<number>(),
    filter: "all",
    logs: [],
    downloading: false,
    suggestions: [],
    dropdownOpen: false,
    focusedSuggestionIndex: -1,
    searchRequestId: 0,
    lastSuggestionQuery: "",
    settingsOpen: false
  };

  function scheduleRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderNow();
    });
  }

  function addLog(type: LogType, message: string): void {
    state.logs = [...state.logs, { time: currentTime(), type, text: message }];
  }

  function clearLogs(): void {
    state.logs = [];
  }

  function upsertJob(job: DownloadJob): void {
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index === -1) state.jobs = [job, ...state.jobs];
    else state.jobs[index] = job;
  }

  function resetDownloadState(): void {
    state.jobs = [];
    state.selectedAssetIds = new Set<number>();
    state.downloading = false;
  }

  function currentRelease(): ReleaseSummary | null {
    return state.result?.releases[state.selectedReleaseIndex] ?? null;
  }

  function latestStableReleaseId(): number | null {
    if (!state.result) return null;
    const stableRelease = state.result.releases.find((release) => !release.isDraft && !release.isPrerelease);
    return stableRelease?.id ?? state.result.releases[0]?.id ?? null;
  }

  function visibleAssets(): ReleaseAsset[] {
    const release = currentRelease();
    if (!release) return [];
    return release.assets.filter((asset) => state.filter === "all" || classifyPlatform(asset) === state.filter);
  }

  function selectedAssets(): ReleaseAsset[] {
    const release = currentRelease();
    if (!release) return [];
    return release.assets.filter((asset) => state.selectedAssetIds.has(asset.id));
  }

  function totalSelectedBytes(): number {
    return selectedAssets().reduce((sum, asset) => sum + asset.size, 0);
  }

  function renderSearchMode(): string {
    const value = state.repositoryInput.trim();
    if (!value) return "any";
    return value.includes("/") ? "exact" : "search";
  }

  function closeDropdown(): void {
    state.dropdownOpen = false;
    state.focusedSuggestionIndex = -1;
  }

  function openDropdown(items: RepositorySuggestion[]): void {
    state.suggestions = items;
    state.dropdownOpen = true;
    state.focusedSuggestionIndex = items.length > 0 ? 0 : -1;
  }

  async function searchSuggestions(queryInput: string): Promise<void> {
    const api = getApi();
    const normalizedQuery = queryInput.trim().toLowerCase();
    const requestId = ++state.searchRequestId;

    if (!api || normalizedQuery.length < 2) {
      state.lastSuggestionQuery = "";
      state.suggestions = [];
      closeDropdown();
      scheduleRender();
      return;
    }

    if (normalizedQuery === state.lastSuggestionQuery) return;

    if (normalizedQuery.includes("/") && normalizedQuery.split("/")[1]?.length) {
      state.lastSuggestionQuery = normalizedQuery;
      state.suggestions = [];
      closeDropdown();
      scheduleRender();
      return;
    }

    state.lastSuggestionQuery = normalizedQuery;
    const result = await api.searchRepositories(normalizedQuery);
    if (requestId !== state.searchRequestId) return;

    if (!result.ok) {
      state.suggestions = [];
      state.dropdownOpen = true;
      state.focusedSuggestionIndex = -1;
      state.errorMessage = result.error.message;
      scheduleRender();
      return;
    }

    openDropdown(result.data);
    scheduleRender();
  }

  function queueSuggestionSearch(queryInput: string): void {
    const normalizedQuery = queryInput.trim().toLowerCase();
    if (suggestionDebounceId) clearTimeout(suggestionDebounceId);

    if (normalizedQuery.length < 2 || (normalizedQuery.includes("/") && normalizedQuery.split("/")[1]?.length)) {
      state.lastSuggestionQuery = normalizedQuery;
      state.suggestions = [];
      closeDropdown();
      scheduleRender();
      return;
    }

    if (normalizedQuery === state.lastSuggestionQuery) return;

    suggestionDebounceId = setTimeout(() => {
      void searchSuggestions(normalizedQuery);
    }, 220);
  }

  function selectSuggestion(index: number): void {
    const item = state.suggestions[index];
    if (!item) return;
    state.repositoryInput = item.fullName;
    state.lastSuggestionQuery = item.fullName.toLowerCase();
    state.suggestions = [];
    closeDropdown();
    scheduleRender();
  }

  function renderSettingsModal(): string {
    if (!state.settingsOpen) return "";
    const statusClass = state.settings.hasGithubToken ? "active" : "idle";
    const statusText = state.settings.hasGithubToken ? text.tokenSaved : text.tokenMissing;
    const storageMessage = state.settings.canPersistGithubToken ? text.tokenStorageSecure : text.tokenStorageUnavailable;
    const saveDisabled = state.settings.canPersistGithubToken ? "" : "disabled";

    return `<div class="settings-backdrop" data-action="close-settings"><section class="settings-modal" data-stop-click="true"><div class="settings-header"><div class="settings-title">${text.settingsTitle}</div><button class="settings-close" data-action="close-settings">X</button></div><div class="token-bar"><input class="token-input" name="github-token" value="${escapeHtml(state.tokenInput)}" placeholder="${text.tokenPlaceholder}" /><button class="btn-secondary" data-action="save-token" ${saveDisabled}>${text.tokenSave}</button><button class="btn-secondary" data-action="clear-token">${text.tokenClear}</button></div><div class="token-status ${statusClass}">${statusText}</div><div class="settings-note">${escapeHtml(storageMessage)}</div></section></div>`;
  }

  function renderDropdown(): string {
    if (!state.dropdownOpen) return "";
    if (state.suggestions.length === 0) {
      return `<div class="dropdown"><div class="dropdown-empty">${text.noSuggestions}</div></div>`;
    }

    return `<div class="dropdown"><div class="dropdown-header"><span>${text.suggestions}</span><span>${state.suggestions.length}</span></div><div class="dropdown-list">${state.suggestions.map((item, index) => `<button class="dropdown-item ${index === state.focusedSuggestionIndex ? "focused" : ""}" data-action="select-suggestion" data-suggestion-index="${index}"><div class="di-avatar repo-icon">#</div><div class="di-body"><div class="di-name">${escapeHtml(item.fullName)}</div><div class="di-desc">${escapeHtml(item.description ?? "No description")}</div></div><div class="di-meta"><div class="di-stars">*${formatCount(item.stars)}</div>${item.language ? `<span class="di-lang">${escapeHtml(item.language)}</span>` : ""}</div></button>`).join("")}</div></div>`;
  }

  function renderRepoCard(): string {
    if (!state.result) return "";
    const { repository } = state.result;
    return `<section class="repo-card"><div class="repo-avatar repo-avatar-fallback">${escapeHtml(repository.owner.slice(0, 2).toUpperCase())}</div><div class="repo-info"><button class="repo-link" type="button" data-action="open-repository" data-url="${escapeHtml(repository.htmlUrl)}"><span class="repo-name">${escapeHtml(repository.fullName)}</span><span class="repo-link-hint">${text.openRepository}</span></button><div class="repo-desc">${escapeHtml(repository.description ?? "No description")}</div></div><div class="repo-stats"><div class="stat">*${formatCount(repository.stars)}</div><div class="stat">${escapeHtml(repository.language ?? "unknown")}</div></div></section>`;
  }

  function renderReleaseTabs(): string {
    if (!state.result) return "";
    const latestId = latestStableReleaseId();
    return `<div class="release-tabs-wrap"><button class="release-scroll-btn" data-action="scroll-release-tabs" data-direction="left" aria-label="Scroll releases left"><</button><div class="release-tabs" data-release-tabs="true">${state.result.releases.map((release, index) => {
      const badges = [
        release.id === latestId ? `<span class="release-pill latest">${text.latest}</span>` : "",
        release.isPrerelease ? `<span class="release-pill pre-release">${text.preRelease}</span>` : ""
      ].filter(Boolean).join("");
      return `<button class="release-tab ${index === state.selectedReleaseIndex ? "active" : ""}" data-action="select-release" data-release-index="${index}"><span class="tag-dot ${releaseDotClass(release)}"></span><span class="release-tag">${escapeHtml(release.tagName)}</span>${badges}</button>`;
    }).join("")}</div><button class="release-scroll-btn" data-action="scroll-release-tabs" data-direction="right" aria-label="Scroll releases right">></button></div>`;
  }

  function renderFilters(): string {
    const items: Array<{ key: PlatformFilter; label: string }> = [
      { key: "all", label: text.filterAll },
      { key: "windows", label: text.filterWindows },
      { key: "mac", label: text.filterMac },
      { key: "linux", label: text.filterLinux },
      { key: "source", label: text.filterSource }
    ];
    return `<div class="filter-bar">${items.map((item) => `<button class="filter-chip ${state.filter === item.key ? "active" : ""}" data-action="set-filter" data-filter="${item.key}">${item.label}</button>`).join("")}<div class="spacer"></div><button class="select-all-btn" data-action="toggle-all">${text.selectAll}</button></div>`;
  }

  function renderAssets(): string {
    const release = currentRelease();
    if (!release) return `<div class="empty-state"><div class="empty-title">Ready</div><div class="empty-desc">${text.noRepository}</div></div>`;
    const assets = visibleAssets();
    if (assets.length === 0) return `<div class="empty-state"><div class="empty-title">No Assets</div><div class="empty-desc">${text.noAssets}</div></div>`;

    return `<div class="assets-header"><span>asset</span><span>platform</span><span>size</span><span>${text.downloads}</span></div><div class="assets-list">${assets.map((asset) => {
      const selected = state.selectedAssetIds.has(asset.id);
      const platform = classifyPlatform(asset);
      return `<div class="asset-row ${selected ? "selected" : ""}" data-action="toggle-asset" data-asset-id="${asset.id}"><div class="asset-name-wrap"><div class="asset-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="asset-icon">${escapeHtml(fileExtension(asset.name).slice(0, 3))}</div><div><div class="asset-filename">${escapeHtml(asset.name)}</div><div class="asset-ext">.${escapeHtml(fileExtension(asset.name))}</div></div></div><div><span class="platform-tag platform-${platform}">${platformLabel(platform)}</span></div><div class="asset-size">${formatBytes(asset.size)}</div><div class="asset-dl">${formatCount(asset.downloadCount)}</div></div>`;
    }).join("")}</div>`;
  }

  function renderJobRows(jobs: DownloadJob[], variant: "active" | "complete" | "fail"): string {
    return jobs.map((job) => {
      const percent = job.totalBytes ? Math.round((job.receivedBytes / job.totalBytes) * 100) : (job.status === "completed" ? 100 : 0);
      const safePercent = Math.max(0, Math.min(100, percent));
      const statusText = variant === "complete" ? text.complete : variant === "fail" ? text.fail : text.active;
      const clickable = variant !== "active" ? 'job-row-clickable' : '';
      const action = variant !== "active" ? 'data-action="reveal-download-folder"' : '';
      const jobIdAttr = variant !== "active" ? `data-job-id="${escapeHtml(job.id)}"` : '';
      const checksum = job.sha256 ? `<div class="job-hash">SHA256 ${escapeHtml(job.sha256)}</div>` : "";

      return `<button class="job-row ${variant} ${clickable}" ${action} ${jobIdAttr}><div class="job-main"><span class="prog-name">${escapeHtml(job.assetName)}</span><span class="job-badge ${variant}">${statusText}</span></div><div class="prog-bar-wrap"><div class="prog-bar ${variant === "complete" ? "done" : variant === "fail" ? "fail" : ""}" style="width:${safePercent}%"></div></div><div class="job-meta"><span class="prog-pct">${safePercent}%</span>${job.errorMessage ? `<span class="job-error">${escapeHtml(job.errorMessage)}</span>` : variant !== "active" ? `<span class="job-open-hint">${text.revealFolder}</span>` : ""}</div>${checksum}</button>`;
    }).join("");
  }

  function renderDownloadSection(title: string, variant: "active" | "complete" | "fail", jobs: DownloadJob[]): string {
    if (jobs.length === 0) return "";
    return `<div class="job-group"><div class="job-group-title ${variant === "active" ? "" : variant}">${title}</div><div class="progress-files">${renderJobRows(jobs, variant)}</div></div>`;
  }

  function renderDownloadPanel(): string {
    const selectedCount = selectedAssets().length;
    const dirText = state.settings.lastDownloadDirectory ?? "~/Downloads";
    const activeJobs = state.jobs.filter((job) => job.status === "queued" || job.status === "running").slice(0, 5);
    const completedJobs = state.jobs.filter((job) => job.status === "completed").slice(0, 5);
    const failedJobs = state.jobs.filter((job) => job.status === "failed" || job.status === "cancelled").slice(0, 5);

    return `<div class="download-panel"><div class="dl-top"><div class="dl-summary"><div class="dl-count">${selectedCount} file${selectedCount === 1 ? "" : "s"}</div><div class="dl-label">${text.totalSelected} ${formatBytes(totalSelectedBytes())}</div></div><button class="dir-selector" data-action="choose-directory"><span class="dir-path">${escapeHtml(dirText)}</span><span class="dir-arrow">></span></button></div><div class="progress-section">${renderDownloadSection(text.active, "active", activeJobs)}${renderDownloadSection(text.complete, "complete", completedJobs)}${renderDownloadSection(text.fail, "fail", failedJobs)}<div class="prog-status"><div class="status-dot ${state.downloading ? "active" : "done"}"></div><span>${state.downloading ? `Downloading... ${activeJobs.length} active` : "Idle"}</span></div></div><div class="actions"><button class="btn-primary" data-action="start-download">${text.startDownload}</button><button class="btn-secondary" data-action="copy-urls">${text.copyUrls}</button><button class="btn-secondary" data-action="show-wget">${text.wgetScript}</button></div></div>`;
  }

  function renderLogs(): string {
    if (state.logs.length === 0) return "";
    return `<div class="log-section"><div class="log-header"><span>// ${text.logTitle}</span><button class="log-clear-btn" data-action="clear-log">${text.clearLog}</button></div><div class="log-body">${state.logs.map((line) => `<div class="log-line"><span class="log-time">${line.time}</span><span class="log-${line.type}">${escapeHtml(line.text)}</span></div>`).join("")}</div></div>`;
  }

  function renderDynamicContent(): string {
    return `${state.result ? renderFilters() : ""}${renderAssets()}${state.result ? renderDownloadPanel() : ""}${renderLogs()}`;
  }

  function renderReleaseDynamicInPlace(): void {
    const dynamicContent = root.querySelector<HTMLElement>("[data-dynamic-content='true']");
    if (dynamicContent) {
      dynamicContent.innerHTML = renderDynamicContent();
    }
  }

  function updateActiveReleaseTabInPlace(): void {
    const releaseTabs = root.querySelector<HTMLElement>("[data-release-tabs='true']");
    if (!releaseTabs) return;

    const releaseButtons = releaseTabs.querySelectorAll<HTMLElement>(".release-tab");
    releaseButtons.forEach((button, index) => {
      button.classList.toggle("active", index === state.selectedReleaseIndex);
    });
  }

  function centerSelectedReleaseTabInPlace(): void {
    const releaseTabs = root.querySelector<HTMLElement>("[data-release-tabs='true']");
    const activeReleaseTab = releaseTabs?.querySelector<HTMLElement>(".release-tab.active");
    if (!releaseTabs || !activeReleaseTab) return;

    activeReleaseTab.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
    releaseTabsScrollLeft = releaseTabs.scrollLeft;
  }

  function renderNow(): void {
    const activeElement = document.activeElement;
    const repositoryActiveElement = activeElement instanceof HTMLInputElement && activeElement.name === "repository" ? activeElement : null;
    shouldRestoreRepositoryFocus = repositoryActiveElement !== null;
    if (repositoryActiveElement) {
      repositorySelectionStart = repositoryActiveElement.selectionStart;
      repositorySelectionEnd = repositoryActiveElement.selectionEnd;
    }

    const markup = `<div class="app-shell"><main class="app"><header><div class="logo"><img class="logo-image" src="../../assets/logo.svg" alt="Release Downloader logo" /><div class="logo-text">${text.appTitle}</div></div><div class="header-actions"><button class="header-settings-btn" data-action="open-settings">${text.settingsButton}</button><div class="badge">${text.badge}</div></div></header><div class="notice-banner">${escapeHtml(text.legalNotice)}</div>${renderSettingsModal()}<div class="section-label">${text.searchLabel}</div><div class="search-wrap"><div class="search-bar"><div class="search-prefix"><span>${text.repoPrefix}</span><span class="mode-badge mode-${renderSearchMode()}">${renderSearchMode()}</span></div><input class="search-input" name="repository" value="${escapeHtml(state.repositoryInput)}" placeholder="${text.searchPlaceholder}" /><button class="search-btn" data-action="search" ${state.loading ? "disabled" : ""}>${text.searchButton}</button></div>${renderDropdown()}</div>${state.errorMessage ? `<div class="error-banner">${escapeHtml(state.errorMessage)}</div>` : ""}${renderRepoCard()}${renderReleaseTabs()}<div data-dynamic-content="true">${renderDynamicContent()}</div></main></div>`;

    if (markup !== lastMarkup) {
      root.innerHTML = markup;
      lastMarkup = markup;
    }

    const releaseTabs = root.querySelector<HTMLElement>("[data-release-tabs='true']");
    if (releaseTabs) {
      releaseTabs.scrollLeft = releaseTabsScrollLeft;
    }

    if (shouldRestoreRepositoryFocus) {
      const repositoryInput = root.querySelector<HTMLInputElement>(".search-input[name='repository']");
      if (repositoryInput) {
        repositoryInput.focus();
        if (repositorySelectionStart !== null && repositorySelectionEnd !== null) {
          repositoryInput.setSelectionRange(repositorySelectionStart, repositorySelectionEnd);
        }
      }
    }
  }

  async function refreshSettings(): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.getSettings();
    if (!result.ok) { state.errorMessage = result.error.message; scheduleRender(); return; }
    state.settings = result.data;
    scheduleRender();
  }

  async function saveToken(): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.saveGithubToken(state.tokenInput);
    if (!result.ok) { state.errorMessage = result.error.message; scheduleRender(); return; }
    state.settings = result.data;
    state.tokenInput = "";
    state.settingsOpen = false;
    state.errorMessage = null;
    addLog("ok", "GitHub token saved.");
    scheduleRender();
  }

  async function clearToken(): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.clearGithubToken();
    if (!result.ok) { state.errorMessage = result.error.message; scheduleRender(); return; }
    state.settings = result.data;
    state.tokenInput = "";
    state.errorMessage = null;
    addLog("warn", "GitHub token cleared.");
    scheduleRender();
  }

  async function searchRepository(): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }

    let repositoryToLookup = state.repositoryInput.trim();
    if (!repositoryToLookup.includes("/")) {
      const suggestionsResult = await api.searchRepositories(repositoryToLookup);
      if (suggestionsResult.ok && suggestionsResult.data.length > 0) {
        repositoryToLookup = suggestionsResult.data[0].fullName;
        state.repositoryInput = repositoryToLookup;
        state.suggestions = suggestionsResult.data;
      }
    }

    state.loading = true;
    state.errorMessage = null;
    state.result = null;
    state.selectedReleaseIndex = 0;
    state.filter = "all";
    resetDownloadState();
    closeDropdown();
    addLog("dl", `Fetching releases for ${repositoryToLookup}...`);
    scheduleRender();

    const result = await api.lookupRepository({ repository: repositoryToLookup });
    state.loading = false;
    if (!result.ok) {
      state.errorMessage = result.error.message;
      addLog("err", result.error.message);
      scheduleRender();
      return;
    }

    state.result = result.data;
    addLog("ok", `Loaded ${result.data.releases.length} releases for ${result.data.repository.fullName}`);
    await refreshSettings();
    scheduleRender();
  }

  async function chooseDirectory(): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.chooseDirectory();
    if (!result.ok) { state.errorMessage = result.error.message; scheduleRender(); return; }
    if (result.data) {
      state.settings.lastDownloadDirectory = result.data;
      addLog("ok", `Directory selected: ${result.data}`);
    }
    scheduleRender();
  }

  async function revealDownloadFolder(jobId: string): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.revealInFolder(jobId);
    if (!result.ok) {
      state.errorMessage = result.error.message;
      scheduleRender();
      return;
    }
    addLog("ok", "Opened download folder.");
  }

  function toggleAsset(assetId: number): void {
    if (state.selectedAssetIds.has(assetId)) state.selectedAssetIds.delete(assetId);
    else state.selectedAssetIds.add(assetId);
    state.selectedAssetIds = new Set(state.selectedAssetIds);
    scheduleRender();
  }

  function toggleAllVisibleAssets(): void {
    const assets = visibleAssets();
    const everySelected = assets.length > 0 && assets.every((asset) => state.selectedAssetIds.has(asset.id));
    for (const asset of assets) {
      if (everySelected) state.selectedAssetIds.delete(asset.id);
      else state.selectedAssetIds.add(asset.id);
    }
    state.selectedAssetIds = new Set(state.selectedAssetIds);
    scheduleRender();
  }

  async function startDownload(): Promise<void> {
    const api = getApi();
    if (!api || !state.result) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const assets = selectedAssets();
    if (assets.length === 0) { state.errorMessage = text.invalidSelection; scheduleRender(); return; }

    state.downloading = true;
    state.errorMessage = null;
    addLog("dl", `Starting download of ${assets.length} file(s)...`);
    scheduleRender();

    for (const asset of assets) {
      const result = await api.downloadAsset({ repository: state.result.repository.fullName, asset, directory: state.settings.lastDownloadDirectory });
      if (!result.ok) {
        addLog("err", `${asset.name}: ${result.error.message}`);
        continue;
      }
      upsertJob(result.data);
      scheduleRender();
    }

    state.downloading = false;
    state.selectedAssetIds = new Set<number>();
    addLog("ok", "All downloads finished.");
    scheduleRender();
  }

  async function copyUrls(): Promise<void> {
    const assets = selectedAssets();
    if (assets.length === 0) { state.errorMessage = text.invalidSelection; scheduleRender(); return; }
    try {
      await navigator.clipboard.writeText(assets.map((asset) => asset.downloadUrl).join("\n"));
      addLog("ok", `Copied ${assets.length} URL(s) to clipboard.`);
    } catch {
      state.errorMessage = "Clipboard copy failed.";
      addLog("warn", "Clipboard copy failed.");
    }
    scheduleRender();
  }

  async function openRepositoryPage(url: string): Promise<void> {
    const api = getApi();
    if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
    const result = await api.openExternal(url);
    if (!result.ok) {
      state.errorMessage = result.error.message;
      addLog("err", result.error.message);
      scheduleRender();
      return;
    }
    addLog("ok", `Opened ${url}`);
  }

  function showWget(): void {
    const assets = selectedAssets();
    if (assets.length === 0) { state.errorMessage = text.invalidSelection; scheduleRender(); return; }
    addLog("warn", "# wget script:");
    for (const asset of assets) addLog("dl", `wget ${asset.downloadUrl}`);
    scheduleRender();
  }

  root.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    const actionTarget = target.closest<HTMLElement>("[data-action='select-release']");
    if (actionTarget) {
      event.preventDefault();
    }
  });

  root.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const actionTarget = target.closest<HTMLElement>("[data-action]");
    const action = actionTarget?.dataset.action;

    if (!actionTarget || !action) {
      if (!target.closest(".search-wrap") && state.dropdownOpen) {
        closeDropdown();
        scheduleRender();
      }
      return;
    }

    if (target.closest("[data-stop-click='true']") && action !== "close-settings") {
      return;
    }

    if (action === "open-settings") { state.settingsOpen = true; scheduleRender(); return; }
    if (action === "close-settings") { state.settingsOpen = false; scheduleRender(); return; }
    if (action === "save-token") return void (await saveToken());
    if (action === "clear-token") return void (await clearToken());
    if (action === "search") return void (await searchRepository());
    if (action === "choose-directory") return void (await chooseDirectory());
    if (action === "open-repository") return void (await openRepositoryPage(actionTarget.dataset.url ?? ""));
    if (action === "reveal-download-folder") return void (await revealDownloadFolder(actionTarget.dataset.jobId ?? ""));
    if (action === "scroll-release-tabs") {
      const releaseTabs = root.querySelector<HTMLElement>("[data-release-tabs='true']");
      const direction = actionTarget.dataset.direction === "left" ? -1 : 1;
      releaseTabs?.scrollBy({ left: direction * 280, behavior: "smooth" });
      if (releaseTabs) {
        releaseTabsScrollLeft = releaseTabs.scrollLeft + (direction * 280);
      }
      return;
    }
    if (action === "select-release") {
      state.selectedReleaseIndex = Number(actionTarget.dataset.releaseIndex ?? 0);
      state.selectedAssetIds = new Set<number>();
      state.filter = "all";
      updateActiveReleaseTabInPlace();
      centerSelectedReleaseTabInPlace();
      renderReleaseDynamicInPlace();
      requestAnimationFrame(() => {
        centerSelectedReleaseTabInPlace();
      });
      return;
    }
    if (action === "set-filter") { state.filter = (actionTarget.dataset.filter as PlatformFilter) ?? "all"; scheduleRender(); return; }
    if (action === "toggle-all") return void toggleAllVisibleAssets();
    if (action === "toggle-asset") return void toggleAsset(Number(actionTarget.dataset.assetId));
    if (action === "start-download") return void (await startDownload());
    if (action === "copy-urls") return void (await copyUrls());
    if (action === "show-wget") return void showWget();
    if (action === "clear-log") { clearLogs(); scheduleRender(); return; }
    if (action === "select-suggestion") { selectSuggestion(Number(actionTarget.dataset.suggestionIndex)); return; }
  });

  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "repository") {
      state.repositoryInput = target.value;
      state.result = null;
      state.errorMessage = null;
      scheduleRender();
      queueSuggestionSearch(target.value);
      return;
    }

    if (target.name === "github-token") {
      state.tokenInput = target.value;
    }
  });

  root.addEventListener("wheel", (event) => {
    const tabs = (event.target as HTMLElement).closest<HTMLElement>("[data-release-tabs='true']");
    if (!tabs) return;
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault();
    tabs.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, { passive: false });

  root.addEventListener("scroll", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-release-tabs='true']")) {
      releaseTabsScrollLeft = target.scrollLeft;
    }
  }, true);

  root.addEventListener("keydown", async (event) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("name") !== "repository") return;

    if (event.key === "ArrowDown" && state.dropdownOpen && state.suggestions.length > 0) {
      event.preventDefault();
      state.focusedSuggestionIndex = Math.min(state.focusedSuggestionIndex + 1, state.suggestions.length - 1);
      scheduleRender();
      return;
    }
    if (event.key === "ArrowUp" && state.dropdownOpen && state.suggestions.length > 0) {
      event.preventDefault();
      state.focusedSuggestionIndex = Math.max(state.focusedSuggestionIndex - 1, 0);
      scheduleRender();
      return;
    }
    if (event.key === "Escape") {
      if (state.settingsOpen) {
        state.settingsOpen = false;
        scheduleRender();
        return;
      }
      closeDropdown();
      scheduleRender();
      return;
    }
    if (event.key === "Enter") {
      if (state.dropdownOpen && state.focusedSuggestionIndex >= 0) {
        event.preventDefault();
        selectSuggestion(state.focusedSuggestionIndex);
        return;
      }
      await searchRepository();
    }
  });

  renderNow();
  const api = getApi();
  if (!api) { state.errorMessage = text.preloadMissing; scheduleRender(); return; }
  api.onDownloadProgress((payload) => {
    const data = payload as { job: DownloadJob };
    upsertJob(data.job);
    if (data.job.status === "completed" && data.job.sha256) {
      addLog("ok", `${data.job.assetName}: SHA256 ${data.job.sha256}`);
    }
    scheduleRender();
  });
  void refreshSettings();
}
