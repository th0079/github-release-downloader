import { request } from "node:https";

import type {
  ApiResult,
  ReleaseAsset,
  ReleaseSummary,
  RepositoryLookupResult,
  RepositorySuggestion,
  RepositorySummary
} from "../../shared/types.js";
import { getGithubToken } from "./settingsService.js";

interface GitHubRepositoryResponse {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
}

interface GitHubSearchRepositoriesResponse {
  items: GitHubRepositoryResponse[];
}

interface GitHubReleaseAssetResponse {
  id: number;
  name: string;
  size: number;
  content_type: string | null;
  browser_download_url: string;
  download_count: number;
  updated_at: string;
}

interface GitHubReleaseResponse {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  html_url: string;
  assets: GitHubReleaseAssetResponse[];
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const searchCache = new Map<string, { expiresAt: number; data: RepositorySuggestion[] }>();
const repositoryLookupCache = new Map<string, { expiresAt: number; data: RepositoryLookupResult }>();
let searchRateLimitedUntil = 0;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function getResetTimestamp(headers: Record<string, string | string[] | undefined>): number {
  const raw = getHeaderValue(headers["x-ratelimit-reset"]);
  const seconds = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) {
    return Date.now() + 60_000;
  }
  return seconds * 1000;
}

function formatRateLimitResetTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getMessageFromUnknownBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

function formatRequestError(error: unknown, fallbackMessage: string): string {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const errnoError = error as NodeJS.ErrnoException;
  if (errnoError.code === "ENOTFOUND") {
    return "GitHub API 주소를 찾지 못했습니다. DNS 또는 인터넷 연결을 확인해 주세요.";
  }
  if (errnoError.code === "ETIMEDOUT") {
    return "GitHub API 요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  }
  if (errnoError.code === "ECONNRESET") {
    return "GitHub API 연결이 중간에 종료되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (errnoError.code === "ECONNREFUSED") {
    return "GitHub API 연결이 거부되었습니다. 방화벽, 보안 프로그램, 프록시 설정을 확인해 주세요.";
  }
  if (errnoError.code === "EACCES") {
    return "GitHub API 연결 권한이 차단되었습니다. 방화벽, 백신, 회사/학교 네트워크 정책을 확인해 주세요.";
  }

  return error.message?.trim().length ? `${fallbackMessage} (${error.message})` : fallbackMessage;
}

async function apiRequest<T>(
  path: string,
  redirectCount = 0
): Promise<{ statusCode: number; data: T; headers: Record<string, string | string[] | undefined> }> {
  const githubToken = await getGithubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "release-downloader",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "api.github.com",
        method: "GET",
        path,
        headers
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = getHeaderValue(res.headers.location);
        if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error("Too many redirects."));
            return;
          }

          const nextUrl = new URL(location, "https://api.github.com");
          void apiRequest<T>(`${nextUrl.pathname}${nextUrl.search}`, redirectCount + 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = body ? (JSON.parse(body) as T) : ({} as T);
            resolve({ statusCode, data: parsed, headers: res.headers });
          } catch {
            resolve({ statusCode, data: {} as T, headers: res.headers });
          }
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function mapGithubError<T>(
  response: { statusCode: number; data: T; headers: Record<string, string | string[] | undefined> },
  options?: { notFoundMessage?: string; genericFailureMessage: string; rateLimitedMessage?: string }
): ApiResult<never> | null {
  if (response.statusCode < 400) {
    return null;
  }

  if (response.statusCode === 401) {
    return {
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "저장된 GitHub 토큰이 유효하지 않거나 만료되었습니다. 설정에서 토큰을 다시 저장하거나 제거해 주세요."
      }
    };
  }

  if (response.statusCode === 403) {
    const resetAt = getResetTimestamp(response.headers);
    searchRateLimitedUntil = Math.max(searchRateLimitedUntil, resetAt);
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: options?.rateLimitedMessage ?? `GitHub 요청 제한에 도달했습니다. ${formatRateLimitResetTime(resetAt)} 이후 다시 시도해 주세요.`
      }
    };
  }

  if (response.statusCode === 404 && options?.notFoundMessage) {
    return { ok: false, error: { code: "NOT_FOUND", message: options.notFoundMessage } };
  }

  const remoteMessage = getMessageFromUnknownBody(response.data);
  return {
    ok: false,
    error: {
      code: "NETWORK_ERROR",
      message: remoteMessage ? `${options?.genericFailureMessage} (${remoteMessage})` : options?.genericFailureMessage ?? "GitHub 요청에 실패했습니다."
    }
  };
}

function normalizeRepository(repository: GitHubRepositoryResponse): RepositorySummary {
  return {
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    htmlUrl: repository.html_url,
    stars: repository.stargazers_count,
    language: repository.language
  };
}

function normalizeSuggestion(repository: GitHubRepositoryResponse): RepositorySuggestion {
  return {
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    htmlUrl: repository.html_url,
    stars: repository.stargazers_count,
    language: repository.language
  };
}

function normalizeAsset(asset: GitHubReleaseAssetResponse): ReleaseAsset {
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    contentType: asset.content_type,
    downloadUrl: asset.browser_download_url,
    downloadCount: asset.download_count,
    updatedAt: asset.updated_at
  };
}

function normalizeRelease(release: GitHubReleaseResponse): ReleaseSummary {
  return {
    id: release.id,
    tagName: release.tag_name,
    name: release.name ?? release.tag_name,
    isDraft: release.draft,
    isPrerelease: release.prerelease,
    publishedAt: release.published_at,
    body: release.body,
    url: release.html_url,
    assets: release.assets.map(normalizeAsset)
  };
}

export async function searchRepositorySuggestions(queryInput: string): Promise<ApiResult<RepositorySuggestion[]>> {
  const query = queryInput.trim().toLowerCase();
  if (query.length < 2) {
    return { ok: true, data: [] };
  }

  const now = Date.now();
  if (searchRateLimitedUntil > now) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: `GitHub 검색 제한에 걸렸습니다. ${formatRateLimitResetTime(searchRateLimitedUntil)} 이후 다시 시도해 주세요.`
      }
    };
  }

  const cached = searchCache.get(query);
  if (cached && cached.expiresAt > now) {
    return { ok: true, data: cached.data };
  }

  try {
    const response = await apiRequest<GitHubSearchRepositoriesResponse>(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`);
    const mappedError = mapGithubError(response, {
      genericFailureMessage: "저장소 검색에 실패했습니다.",
      rateLimitedMessage: `GitHub 검색 제한에 걸렸습니다. ${formatRateLimitResetTime(getResetTimestamp(response.headers))} 이후 다시 시도해 주세요.`
    });
    if (mappedError) return mappedError;

    const items = Array.isArray(response.data.items) ? response.data.items : [];
    const data = items.map(normalizeSuggestion);
    searchCache.set(query, { expiresAt: Date.now() + 5 * 60_000, data });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: formatRequestError(error, "저장소 검색 중 네트워크 연결 또는 응답 처리 오류가 발생했습니다.")
      }
    };
  }
}

export async function lookupRepositoryWithReleases(repositoryInput: string): Promise<ApiResult<RepositoryLookupResult>> {
  const repository = repositoryInput.trim();

  if (!repoPattern.test(repository)) {
    return { ok: false, error: { code: "INVALID_REPOSITORY", message: "저장소를 owner/repo 형식으로 입력해 주세요." } };
  }

  const cached = repositoryLookupCache.get(repository.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, data: cached.data };
  }

  try {
    const [repositoryResponse, releasesResponse] = await Promise.all([
      apiRequest<GitHubRepositoryResponse>(`/repos/${repository}`),
      apiRequest<GitHubReleaseResponse[]>(`/repos/${repository}/releases`)
    ]);

    const repositoryError = mapGithubError(repositoryResponse, {
      notFoundMessage: "저장소를 찾을 수 없습니다.",
      genericFailureMessage: "GitHub 저장소 정보를 불러오지 못했습니다."
    });
    if (repositoryError) return repositoryError;

    const releasesError = mapGithubError(releasesResponse, {
      genericFailureMessage: "GitHub 릴리스 정보를 불러오지 못했습니다."
    });
    if (releasesError) return releasesError;

    const normalizedReleases = Array.isArray(releasesResponse.data) ? releasesResponse.data.map(normalizeRelease) : [];
    if (normalizedReleases.length === 0) {
      return { ok: false, error: { code: "NO_RELEASES", message: "이 저장소에는 공개 릴리스가 없습니다." } };
    }

    const data = { repository: normalizeRepository(repositoryResponse.data), releases: normalizedReleases };
    repositoryLookupCache.set(repository.toLowerCase(), { expiresAt: Date.now() + 5 * 60_000, data });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: formatRequestError(error, "GitHub API 연결 중 오류가 발생했습니다. 네트워크 상태와 방화벽 설정을 확인해 주세요.")
      }
    };
  }
}
