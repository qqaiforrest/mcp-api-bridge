/** Spawns the real stdio server with the Open-Meteo example and asks for the current weather in Victoria, BC. Needs network. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["--import", "tsx", "src/cli.ts", "--config", "examples/open-meteo.json"], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const r = await client.callTool({ name: "get_current_weather", arguments: { latitude: 48.4284, longitude: -123.3656 } });
console.log(JSON.stringify(r, null, 2));
await client.close();
