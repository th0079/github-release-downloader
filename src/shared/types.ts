export type ApiErrorCode =
  | "INVALID_REPOSITORY"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "NO_RELEASES"
  | "DOWNLOAD_FAILED"
  | "INVALID_INPUT"
  | "TOKEN_STORAGE_UNAVAILABLE"
  | "UNKNOWN_ERROR";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string } };

export interface RepositoryLookupInput {
  repository: string;
}

export interface RepositorySummary {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  stars: number;
  language: string | null;
}

export interface RepositorySuggestion {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  stars: number;
  language: string | null;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  contentType: string | null;
  downloadUrl: string;
  downloadCount: number;
  updatedAt: string;
}

export interface ReleaseSummary {
  id: number;
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string | null;
  body: string | null;
  url: string;
  assets: ReleaseAsset[];
}

export interface RepositoryLookupResult {
  repository: RepositorySummary;
  releases: ReleaseSummary[];
}

export interface DownloadAssetInput {
  repository: string;
  asset: ReleaseAsset;
  directory?: string | null;
}

export type DownloadStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DownloadJob {
  id: string;
  repository: string;
  assetName: string;
  targetPath: string;
  receivedBytes: number;
  totalBytes: number | null;
  status: DownloadStatus;
  sha256?: string;
  errorMessage?: string;
}

export interface DownloadProgressEvent {
  job: DownloadJob;
}

export interface SettingsState {
  lastDownloadDirectory: string | null;
  recentRepositories: string[];
  hasGithubToken: boolean;
  canPersistGithubToken: boolean;
}

export interface ReleaseDownloaderApi {
  getSettings(): Promise<ApiResult<SettingsState>>;
  chooseDirectory(): Promise<ApiResult<string | null>>;
  saveGithubToken(token: string): Promise<ApiResult<SettingsState>>;
  clearGithubToken(): Promise<ApiResult<SettingsState>>;
  searchRepositories(query: string): Promise<ApiResult<RepositorySuggestion[]>>;
  lookupRepository(input: RepositoryLookupInput): Promise<ApiResult<RepositoryLookupResult>>;
  openExternal(url: string): Promise<ApiResult<boolean>>;
  revealInFolder(jobId: string): Promise<ApiResult<boolean>>;
  downloadAsset(input: DownloadAssetInput): Promise<ApiResult<DownloadJob>>;
  cancelDownload(jobId: string): Promise<ApiResult<boolean>>;
  onDownloadProgress(listener: (event: DownloadProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    releaseDownloader: ReleaseDownloaderApi;
  }
}
