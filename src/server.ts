/** Creates the McpServer from a config. Pure: no process.argv, no stdio, so tests can drive it over an in-memory transport. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig, Env, ToolSpec } from "./config.js";
import { buildInputSchema } from "./schema.js";
import { buildRequest, callUpstream, pick, UpstreamError, type UpstreamResult } from "./http.js";

export interface ServerOptions {
  fetchImpl?: typeof fetch;
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function toResult(tool: ToolSpec, res: UpstreamResult, disclaimer?: string): CallToolResult {
  const content: CallToolResult["content"] = [];
  const img = tool.response?.image;
  if (img) {
    const opt = typeof img === "object" ? img : {};
    let data: string | undefined;
    let mimeType = opt.mimeType;
    let summary: string | undefined;
    if (res.bytes) {
      data = res.bytes.toString("base64");
      mimeType ??= res.contentType.split(";")[0] || "image/png";
    } else if (res.json && typeof res.json === "object") {
      const j = res.json as Record<string, unknown>;
      const raw = j[opt.dataField ?? "image_base64"];
      if (typeof raw === "string") {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
        data = m ? m[2] : raw;
        mimeType ??= m ? m[1] : "image/png";
      }
      if (opt.summaryField && typeof j[opt.summaryField] === "string") summary = j[opt.summaryField] as string;
    }
    if (!data) return { isError: true, content: [textBlock(`upstream answer for ${tool.name} had no image data (expected an image/* body or a JSON field "${opt.dataField ?? "image_base64"}")`)] };
    content.push({ type: "image", data, mimeType: mimeType ?? "image/png" });
    if (summary) content.push(textBlock(summary));
  } else {
    const json = tool.response?.pick ? pick(res.json, tool.response.pick) : res.json;
    content.push(textBlock(JSON.stringify(json ?? null, null, 2)));
  }
  if (disclaimer) content.push(textBlock(disclaimer));
  return { content };
}

export function createServer(cfg: BridgeConfig, env: Env, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: cfg.name, version: cfg.version });
  for (const tool of cfg.tools) {
    const disclaimer = tool.disclaimer ?? cfg.disclaimer;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: buildInputSchema(tool), annotations: tool.annotations },
      async (args): Promise<CallToolResult> => {
        try {
          const req = await buildRequest(tool, (args ?? {}) as Record<string, unknown>, env);
          let res: UpstreamResult;
          try {
            res = await callUpstream(req, env, opts.fetchImpl);
          } catch (e) {
            if (e instanceof UpstreamError && e.retryable && tool.retryOnce) res = await callUpstream(req, env, opts.fetchImpl);
            else throw e;
          }
          return toResult(tool, res, disclaimer);
        } catch (e) {
          const msg = e instanceof UpstreamError ? e.message : `unexpected error in ${tool.name}: ${(e as Error).message}`;
          return { isError: true, content: [textBlock(msg)] };
        }
      }
    );
  }
  return server;
}
