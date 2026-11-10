#!/usr/bin/env node
/** stdio entry point: mcp-api-bridge --config tools.config.json */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, readEnv } from "./config.js";
import { createServer } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = arg("--config") ?? process.env.MCP_API_BRIDGE_CONFIG;
if (!configPath) {
  console.error("usage: mcp-api-bridge --config <tools.config.json>   (or set MCP_API_BRIDGE_CONFIG)");
  process.exit(2);
}

try {
  const cfg = loadConfig(configPath);
  const env = readEnv(cfg);
  const server = createServer(cfg, env);
  await server.connect(new StdioServerTransport());
  console.error(`[mcp-api-bridge] ${cfg.name}: ${cfg.tools.length} tool(s) on stdio, upstream ${env.baseUrl}, timeout ${env.timeoutMs} ms`);
} catch (e) {
  console.error(`[mcp-api-bridge] ${(e as Error).message}`);
  process.exit(1);
}
