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

async function apiRequest<T>(path: string): Promise<{ statusCode: number; data: T; headers: Record<string, string | string[] | undefined> }> {
  const githubToken = await getGithubToken();

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "api.github.com",
        method: "GET",
        path,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: githubToken ? `Bearer ${githubToken}` : undefined,
          "User-Agent": "github-release-downloader",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = body ? (JSON.parse(body) as T) : ({} as T);
            resolve({ statusCode: res.statusCode ?? 0, data: parsed, headers: res.headers });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
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
    if (response.statusCode === 403) {
      searchRateLimitedUntil = getResetTimestamp(response.headers);
      return {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: `GitHub 검색 제한에 걸렸습니다. ${formatRateLimitResetTime(searchRateLimitedUntil)} 이후 다시 시도해 주세요.`
        }
      };
    }
    if (response.statusCode >= 400) {
      return { ok: false, error: { code: "NETWORK_ERROR", message: "저장소 검색에 실패했습니다." } };
    }

    const data = response.data.items.map(normalizeSuggestion);
    searchCache.set(query, { expiresAt: Date.now() + 5 * 60_000, data });
    return { ok: true, data };
  } catch {
    return { ok: false, error: { code: "NETWORK_ERROR", message: "저장소 검색 중 네트워크 오류가 발생했습니다." } };
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

    if (repositoryResponse.statusCode === 404) {
      return { ok: false, error: { code: "NOT_FOUND", message: "저장소를 찾을 수 없습니다." } };
    }
    if (repositoryResponse.statusCode === 403 || releasesResponse.statusCode === 403) {
      return { ok: false, error: { code: "RATE_LIMITED", message: "GitHub API rate limit에 도달했습니다. 잠시 후 다시 시도해 주세요." } };
    }
    if (repositoryResponse.statusCode >= 400 || releasesResponse.statusCode >= 400) {
      return { ok: false, error: { code: "NETWORK_ERROR", message: "GitHub 저장소 정보를 불러오지 못했습니다." } };
    }

    const normalizedReleases = releasesResponse.data.map(normalizeRelease);
    if (normalizedReleases.length === 0) {
      return { ok: false, error: { code: "NO_RELEASES", message: "이 저장소에는 공개 릴리스가 없습니다." } };
    }

    const data = { repository: normalizeRepository(repositoryResponse.data), releases: normalizedReleases };
    repositoryLookupCache.set(repository.toLowerCase(), { expiresAt: Date.now() + 5 * 60_000, data });
    return { ok: true, data };
  } catch {
    return { ok: false, error: { code: "NETWORK_ERROR", message: "네트워크 오류가 발생했습니다. 연결 상태를 확인해 주세요." } };
  }
}
