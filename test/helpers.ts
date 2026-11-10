import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseConfig, type BridgeConfig, type Env } from "../src/config.js";
import { createServer } from "../src/server.js";

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Handler = (req: Seen, res: http.ServerResponse) => void | Promise<void>;

/** Tiny upstream mock. Records every request; the handler decides the answer. */
export async function mockUpstream(handler: Handler): Promise<{ baseUrl: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      void handler(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function connect(rawCfg: unknown, env: Partial<Env> & { baseUrl: string }) {
  const cfg: BridgeConfig = parseConfig(rawCfg);
  const fullEnv: Env = { apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer ", timeoutMs: 15000, ...env };
  const server = createServer(cfg, fullEnv);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { client, call, close };
}

export const text = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

/** 1x1 transparent PNG */
export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
