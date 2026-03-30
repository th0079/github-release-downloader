import { createWriteStream } from "node:fs";
import { constants } from "node:fs";
import { access, mkdir, unlink } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { join, parse } from "node:path";

import type { DownloadAssetInput, DownloadJob } from "../../shared/types.js";

type ProgressListener = (job: DownloadJob) => void;

const activeRequests = new Map<string, ClientRequest>();
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);

function safeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function findAvailableTargetPath(directory: string, fileName: string): Promise<string> {
  const { name, ext } = parse(fileName);
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const candidate = join(directory, `${name}${suffix}${ext}`);

    try {
      await access(candidate, constants.F_OK);
      attempt += 1;
    } catch {
      return candidate;
    }
  }
}

function performRequest(url: string, jobId: string, handleResponse: (response: IncomingMessage) => void): ClientRequest {
  const req = request(
    url,
    {
      headers: {
        "User-Agent": "github-release-downloader"
      }
    },
    handleResponse
  );

  activeRequests.set(jobId, req);
  req.end();
  return req;
}

async function removePartialFile(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch {
    // Ignore cleanup failures so the original download error can surface.
  }
}

function getDownloadErrorMessage(errorMessage: string, fileError = false): string {
  if (errorMessage === "cancelled") return "다운로드가 취소되었습니다.";
  if (errorMessage === "redirect_limit") return "리다이렉트가 너무 많아 다운로드를 중단했습니다.";
  if (/^http_403$/.test(errorMessage)) return "다운로드 권한이 없거나 일시적으로 차단되었습니다.";
  if (/^http_404$/.test(errorMessage)) return "다운로드 파일을 찾을 수 없습니다.";
  if (/^http_/.test(errorMessage)) return "다운로드 중 서버 오류가 발생했습니다.";
  if (fileError) return "파일 저장 중 오류가 발생했습니다.";
  return "다운로드 중 오류가 발생했습니다.";
}

export function cancelDownload(jobId: string): boolean {
  const requestRef = activeRequests.get(jobId);
  if (!requestRef) {
    return false;
  }

  requestRef.destroy(new Error("cancelled"));
  activeRequests.delete(jobId);
  return true;
}

export async function downloadAsset(
  input: DownloadAssetInput,
  directory: string,
  onProgress: ProgressListener
): Promise<DownloadJob> {
  await ensureDirectory(directory);

  const jobId = `${Date.now()}-${input.asset.id}`;
  const targetPath = await findAvailableTargetPath(directory, safeFileName(input.asset.name));

  const job: DownloadJob = {
    id: jobId,
    repository: input.repository,
    assetName: input.asset.name,
    targetPath,
    receivedBytes: 0,
    totalBytes: input.asset.size || null,
    status: "queued"
  };

  onProgress({ ...job });

  return await new Promise<DownloadJob>((resolve, reject) => {
    const fileStream = createWriteStream(targetPath, { flags: "w" });
    let redirectCount = 0;
    let settled = false;

    const failJob = async (error: Error, fileError = false): Promise<void> => {
      if (settled) return;
      settled = true;
      activeRequests.delete(job.id);
      job.status = error.message === "cancelled" ? "cancelled" : "failed";
      job.errorMessage = getDownloadErrorMessage(error.message, fileError);
      onProgress({ ...job });
      fileStream.destroy();
      await removePartialFile(targetPath);
      reject(error);
    };

    const requestWithRedirects = (url: string): void => {
      const req = performRequest(url, job.id, (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = res.headers.location;

        if (redirectStatusCodes.has(statusCode) && location) {
          if (redirectCount >= 5) {
            req.destroy(new Error("redirect_limit"));
            return;
          }

          redirectCount += 1;
          res.resume();
          requestWithRedirects(new URL(location, url).toString());
          return;
        }

        if (statusCode >= 400) {
          req.destroy(new Error(`http_${statusCode}`));
          return;
        }

        const totalHeader = res.headers["content-length"];
        const totalBytes = totalHeader ? Number(totalHeader) : job.totalBytes;

        job.totalBytes = Number.isFinite(totalBytes) ? totalBytes : null;
        job.status = "running";
        onProgress({ ...job });

        res.on("data", (chunk: Buffer) => {
          job.receivedBytes += Buffer.byteLength(chunk);
          onProgress({ ...job });
        });

        res.on("error", (error: Error) => {
          void failJob(error);
        });

        res.pipe(fileStream, { end: true });
      });

      req.on("error", (error) => {
        void failJob(error);
      });
    };

    fileStream.on("finish", () => {
      if (settled) return;
      settled = true;
      activeRequests.delete(job.id);
      job.status = "completed";
      onProgress({ ...job });
      resolve({ ...job });
    });

    fileStream.on("error", (error: Error) => {
      void failJob(error, true);
    });

    requestWithRedirects(input.asset.downloadUrl);
  });
}
