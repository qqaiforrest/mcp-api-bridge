/** Builds the upstream request from tool inputs, runs it with a timeout, and maps failures to short messages. */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Env, ToolSpec } from "./config.js";

export class UpstreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface BuiltRequest {
  url: string;
  init: RequestInit;
}

function snippet(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "..." : t;
}

export async function buildRequest(tool: ToolSpec, args: Record<string, unknown>, env: Env): Promise<BuiltRequest> {
  let path = tool.path;
  const query = new URLSearchParams(tool.fixedQuery ?? {});
  const body: Record<string, unknown> = { ...(tool.fixedBody ?? {}) };
  let form: FormData | undefined;
  for (const [k, spec] of Object.entries(tool.inputs)) {
    const v = args[k];
    if (v === undefined) continue;
    const field = spec.fieldName ?? k;
    switch (spec.in) {
      case "path":
        path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
        break;
      case "query":
        query.set(field, String(v));
        break;
      case "body":
        body[field] = v;
        break;
      case "multipart": {
        form ??= new FormData();
        if (spec.type === "file") {
          const p = String(v);
          let bytes: Buffer;
          try {
            bytes = await readFile(p);
          } catch (e) {
            throw new UpstreamError(`cannot read file "${p}" for input ${k}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, false);
          }
          form.set(field, new Blob([new Uint8Array(bytes)], { type: spec.mimeType ?? "application/octet-stream" }), spec.fileName ?? basename(p));
        } else if (spec.type === "base64") {
          const raw = String(v).replace(/^data:[^;]+;base64,/, "");
          if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw new UpstreamError(`input ${k} is not valid base64`, false);
          const bytes = Buffer.from(raw, "base64");
          form.set(field, new Blob([new Uint8Array(bytes)], { type: spec.mimeType ?? "application/octet-stream" }), spec.fileName ?? `${k}.bin`);
        } else {
          form.set(field, String(v));
        }
        break;
      }
    }
  }
  const qs = query.toString();
  const url = `${env.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json, image/*;q=0.9, */*;q=0.1" };
  if (env.apiKey) headers[env.apiKeyHeader] = `${env.apiKeyPrefix}${env.apiKey}`;
  const init: RequestInit = { method: tool.method, headers };
  if (form) init.body = form;
  else if (Object.keys(body).length > 0) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return { url, init };
}

export interface UpstreamResult {
  status: number;
  contentType: string;
  json?: unknown;
  bytes?: Buffer;
}

export async function callUpstream(req: BuiltRequest, env: Env, fetchImpl: typeof fetch = fetch): Promise<UpstreamResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(req.url, { ...req.init, signal: ctrl.signal });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "AbortError") throw new UpstreamError(`upstream did not answer within ${env.timeoutMs} ms (${req.init.method} ${new URL(req.url).pathname}); retry once, and reduce the input size if it is large`, true);
    const host = new URL(req.url).host;
    throw new UpstreamError(`could not reach upstream at ${host}: ${err.cause?.code ?? err.message}; check API_BASE_URL and the network`, true);
  } finally {
    clearTimeout(timer);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const text = snippet(await res.text().catch(() => ""));
    const where = `${req.init.method} ${new URL(req.url).pathname}`;
    const s = res.status;
    if (s === 400 || s === 422) throw new UpstreamError(`upstream rejected the input (${s}) for ${where}: ${text || "no detail"}; fix the argument it names and call again`, false);
    if (s === 401 || s === 403) throw new UpstreamError(`upstream refused authentication (${s}); API_KEY is missing or wrong in the server environment, it cannot be fixed from the chat`, false);
    if (s === 404) throw new UpstreamError(`upstream path not found (404): ${where}; the API may have moved, do not retry with the same arguments`, false);
    if (s === 429) throw new UpstreamError(`upstream rate limit (429) for ${where}; wait before calling again`, true);
    if (s >= 500) throw new UpstreamError(`upstream server error (${s}) for ${where}; retry later, and if it persists the API is down`, true);
    throw new UpstreamError(`upstream returned ${s} for ${where}: ${text || "no detail"}`, false);
  }
  if (contentType.startsWith("image/")) return { status: res.status, contentType, bytes: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  if (text.length === 0) return { status: res.status, contentType, json: null };
  try {
    return { status: res.status, contentType, json: JSON.parse(text) };
  } catch {
    return { status: res.status, contentType, json: { text } };
  }
}

export function pick(json: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    let cur: unknown = json;
    for (const part of p.split(".")) {
      if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined) out[p] = cur;
  }
  return out;
}
