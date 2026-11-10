/**
 * Config file shape. One JSON file declares the upstream API and every tool.
 * Nothing here is executed; the server reads it at start and refuses anything it does not understand.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const inputSpec = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "enum", "file", "base64"]),
  description: z.string().optional(),
  in: z.enum(["path", "query", "body", "multipart"]),
  /** Name used in the request when it differs from the tool argument name. */
  fieldName: z.string().optional(),
  optional: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  /** For type "file" or "base64": file name sent in the multipart part. */
  fileName: z.string().optional(),
  /** For type "file" or "base64": MIME type of the uploaded part. */
  mimeType: z.string().optional()
});

const imageResponse = z.object({
  /** JSON field holding base64 image data. Ignored when the upstream answers with an image/* body. */
  dataField: z.string().optional(),
  /** MIME type for the image block when the upstream does not say. */
  mimeType: z.string().optional(),
  /** Optional JSON field whose value becomes the text summary next to the image. */
  summaryField: z.string().optional()
});

const toolSpec = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "tool name: letters, digits, _ or -, max 64"),
  description: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Path template, e.g. "/v1/items/{id}". Braces name path inputs. */
  path: z.string().startsWith("/"),
  inputs: z.record(z.string(), inputSpec).default({}),
  /** Constant query parameters sent on every call, e.g. {"current_weather": "true"}. */
  fixedQuery: z.record(z.string(), z.string()).optional(),
  /** Constant JSON body fields merged under the caller's inputs. */
  fixedBody: z.record(z.string(), z.unknown()).optional(),
  /** Each inner list names inputs of which exactly one must be given. */
  exactlyOneOf: z.array(z.array(z.string()).min(2)).optional(),
  response: z
    .object({
      /** Keep only these top-level JSON fields (dot paths allowed). Omit to return the whole JSON. */
      pick: z.array(z.string()).optional(),
      /** Return the upstream answer as an MCP image content block. */
      image: z.union([z.boolean(), imageResponse]).optional()
    })
    .optional(),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional()
    })
    .optional(),
  /** Appended to every response of this tool. Overrides the top-level disclaimer. */
  disclaimer: z.string().optional(),
  /** Retry once on timeout or 5xx. Never on 4xx. Default false. */
  retryOnce: z.boolean().optional()
});

export const bridgeConfigSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
  /** Default base URL when API_BASE_URL is not set. */
  baseUrl: z.string().url().optional(),
  /** Appended to every tool response unless the tool sets its own. */
  disclaimer: z.string().optional(),
  tools: z.array(toolSpec).min(1)
});

export type InputSpec = z.infer<typeof inputSpec>;
export type ToolSpec = z.infer<typeof toolSpec>;
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

export function parseConfig(raw: unknown): BridgeConfig {
  const cfg = bridgeConfigSchema.parse(raw);
  const names = new Set<string>();
  for (const t of cfg.tools) {
    if (names.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    names.add(t.name);
    const pathParams = [...t.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
    for (const p of pathParams) {
      const spec = t.inputs[p];
      if (!spec) throw new Error(`${t.name}: path parameter {${p}} has no input`);
      if (spec.in !== "path") throw new Error(`${t.name}: input ${p} must have "in": "path"`);
      if (spec.optional) throw new Error(`${t.name}: path input ${p} cannot be optional`);
    }
    for (const [k, spec] of Object.entries(t.inputs)) {
      if (spec.in === "path" && !pathParams.includes(k)) throw new Error(`${t.name}: input ${k} is "path" but {${k}} is not in the path`);
      if (spec.type === "enum" && (!spec.enum || spec.enum.length === 0)) throw new Error(`${t.name}: enum input ${k} needs "enum" values`);
      if ((spec.type === "file" || spec.type === "base64") && spec.in !== "multipart") throw new Error(`${t.name}: ${k} of type ${spec.type} must be sent as multipart`);
      if (t.method === "GET" && (spec.in === "body" || spec.in === "multipart")) throw new Error(`${t.name}: GET cannot carry ${spec.in} inputs`);
    }
    for (const group of t.exactlyOneOf ?? []) {
      for (const k of group) {
        if (!t.inputs[k]) throw new Error(`${t.name}: exactlyOneOf names unknown input ${k}`);
        if (!t.inputs[k].optional) throw new Error(`${t.name}: exactlyOneOf member ${k} must be optional`);
      }
    }
  }
  return cfg;
}

export function loadConfig(path: string): BridgeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

export interface Env {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  timeoutMs: number;
}

export function readEnv(cfg: BridgeConfig, env: NodeJS.ProcessEnv = process.env): Env {
  const baseUrl = (env.API_BASE_URL ?? cfg.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("API_BASE_URL is not set and the config has no baseUrl");
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("REQUEST_TIMEOUT_MS must be a positive number");
  return {
    baseUrl,
    apiKey: env.API_KEY || undefined,
    apiKeyHeader: env.API_KEY_HEADER || "Authorization",
    apiKeyPrefix: env.API_KEY_PREFIX ?? "Bearer ",
    timeoutMs
  };
}
