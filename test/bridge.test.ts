import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, mockUpstream, json, text, PNG_1X1_BASE64 } from "./helpers.js";
import openMeteo from "../examples/open-meteo.json" with { type: "json" };
import classifier from "../examples/image-classifier.json" with { type: "json" };
import { parseConfig } from "../src/config.js";

const itemsCfg = {
  name: "t",
  tools: [
    {
      name: "get_item",
      description: "one item",
      method: "GET",
      path: "/items/{id}",
      fixedQuery: { v: "2" },
      inputs: {
        id: { type: "string", in: "path" },
        verbose: { type: "boolean", in: "query", optional: true },
        limit: { type: "integer", in: "query", min: 1, max: 50, optional: true }
      },
      response: { pick: ["id", "nested.value"] },
      annotations: { readOnlyHint: true }
    },
    {
      name: "create_item",
      description: "create",
      method: "POST",
      path: "/items",
      fixedBody: { source: "mcp" },
      inputs: { title: { type: "string", in: "body", maxLength: 10 }, qty: { type: "number", in: "body", optional: true, fieldName: "quantity" } },
      disclaimer: "per-tool note"
    },
    { name: "flaky", description: "retry me", method: "GET", path: "/flaky", retryOnce: true },
    { name: "flaky_no_retry", description: "no retry", method: "GET", path: "/flaky" }
  ]
};

test("tools/list advertises names, descriptions, schemas and annotations", async () => {
  const up = await mockUpstream((_, res) => json(res, 200, {}));
  const { client, close } = await connect(openMeteo, { baseUrl: up.baseUrl });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_current_weather", "get_daily_forecast"]);
  const t = tools.find((x) => x.name === "get_current_weather")!;
  assert.equal(t.annotations?.readOnlyHint, true);
  const props = (t.inputSchema as { properties: Record<string, unknown>; required?: string[] }).properties;
  assert.ok("latitude" in props && "temperature_unit" in props);
  assert.deepEqual((t.inputSchema as { required?: string[] }).required?.sort(), ["latitude", "longitude"]);
  await close();
  await up.close();
});

test("schema validation: missing required, wrong type, out of range, unknown key", async () => {
  const up = await mockUpstream((_, res) => json(res, 200, {}));
  const { call, close } = await connect(openMeteo, { baseUrl: up.baseUrl });
  for (const args of [{}, { latitude: "48", longitude: -123 }, { latitude: 99, longitude: 0 }, { latitude: 48, longitude: -123, extra: 1 }, { latitude: 48, longitude: -123, temperature_unit: "kelvin" }]) {
    const r = await call("get_current_weather", args as Record<string, unknown>);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(up.seen.length, 0, "no upstream call on invalid input");
  await close();
  await up.close();
});

test("exactly-one-of: none or both given is rejected with a specific message", async () => {
  const up = await mockUpstream((_, res) => json(res, 200, { label: "x", confidence: 1, model_version: "1" }));
  const { call, close } = await connect(classifier, { baseUrl: up.baseUrl });
  const none = await call("classify_image", {});
  assert.equal(none.isError, true);
  assert.match(text(none), /exactly one of image_path, image_base64/);
  const both = await call("classify_image", { image_path: "/tmp/x.png", image_base64: PNG_1X1_BASE64 });
  assert.equal(both.isError, true);
  assert.match(text(both), /got image_path, image_base64/);
  assert.equal(up.seen.length, 0);
  await close();
  await up.close();
});

test("path, query and body mapping, fieldName rename, pick with dot paths, API key header", async () => {
  const up = await mockUpstream((req, res) => {
    if (req.method === "GET") return json(res, 200, { id: "a b", nested: { value: 42, other: 1 }, noise: true });
    return json(res, 201, { ok: true, got: JSON.parse(req.body.toString()) });
  });
  const { call, close } = await connect(itemsCfg, { baseUrl: up.baseUrl, apiKey: "k123", apiKeyHeader: "X-Api-Key", apiKeyPrefix: "" });
  const r1 = await call("get_item", { id: "a b", verbose: true, limit: 5 });
  assert.equal(r1.isError, undefined);
  assert.equal(up.seen[0].url, "/items/a%20b?v=2&verbose=true&limit=5");
  assert.equal(up.seen[0].headers["x-api-key"], "k123");
  assert.deepEqual(JSON.parse(text(r1)), { id: "a b", "nested.value": 42 });
  const r2 = await call("create_item", { title: "hello", qty: 3 });
  assert.equal(up.seen[1].method, "POST");
  assert.equal(up.seen[1].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(up.seen[1].body.toString()), { source: "mcp", title: "hello", quantity: 3 });
  assert.match(text(r2), /per-tool note/);
  await close();
  await up.close();
});

test("timeout maps to a retry hint and aborts the request", async () => {
  const up = await mockUpstream((_, res) => setTimeout(() => json(res, 200, {}), 500));
  const { call, close } = await connect(itemsCfg, { baseUrl: up.baseUrl, timeoutMs: 100 });
  const r = await call("get_item", { id: "1" });
  assert.equal(r.isError, true);
  assert.match(text(r), /did not answer within 100 ms/);
  await close();
  await up.close();
});

test("4xx and 5xx map to specific messages; 4xx is never retried", async () => {
  const answers = [400, 401, 404, 429, 503];
  let i = 0;
  const up = await mockUpstream((_, res) => {
    res.writeHead(answers[i++] ?? 200, { "content-type": "text/plain" });
    res.end("detail here");
  });
  const { call, close } = await connect(itemsCfg, { baseUrl: up.baseUrl });
  const msgs: string[] = [];
  for (let k = 0; k < 5; k++) msgs.push(text(await call("flaky_no_retry")));
  assert.match(msgs[0], /rejected the input \(400\).*detail here/);
  assert.match(msgs[1], /refused authentication \(401\)/);
  assert.match(msgs[2], /not found \(404\)/);
  assert.match(msgs[3], /rate limit \(429\)/);
  assert.match(msgs[4], /server error \(503\)/);
  assert.equal(up.seen.length, 5, "one request per call, no retries");
  await close();
  await up.close();
});

test("retryOnce retries exactly once on 5xx and then succeeds", async () => {
  let n = 0;
  const up = await mockUpstream((_, res) => (n++ === 0 ? json(res, 502, {}) : json(res, 200, { fine: true })));
  const { call, close } = await connect(itemsCfg, { baseUrl: up.baseUrl });
  const r = await call("flaky");
  assert.equal(r.isError, undefined);
  assert.equal(up.seen.length, 2);
  await close();
  await up.close();
});

test("network failure maps to a reachability message", async () => {
  const { call, close } = await connect(itemsCfg, { baseUrl: "http://127.0.0.1:9" });
  const r = await call("get_item", { id: "1" });
  assert.equal(r.isError, true);
  assert.match(text(r), /could not reach upstream at 127.0.0.1:9/);
  await close();
});

test("multipart: file path and base64 inputs both upload the bytes; disclaimer appended", async () => {
  const up = await mockUpstream((req, res) => json(res, 200, { label: "healthy", confidence: 0.97, model_version: "pcam-1", extra: "x" }));
  const dir = await mkdtemp(join(tmpdir(), "bridge-"));
  const file = join(dir, "patch.png");
  await writeFile(file, Buffer.from(PNG_1X1_BASE64, "base64"));
  const { call, close } = await connect(classifier, { baseUrl: up.baseUrl });
  const r1 = await call("classify_image", { image_path: file });
  assert.equal(r1.isError, undefined, text(r1));
  assert.match(String(up.seen[0].headers["content-type"]), /^multipart\/form-data/);
  assert.match(up.seen[0].body.toString("latin1"), /name="file"; filename="patch.png"/);
  assert.deepEqual(JSON.parse(text(r1).split("\n").slice(0, -1).join("\n")), { label: "healthy", confidence: 0.97, model_version: "pcam-1" });
  assert.match(text(r1), /Research prototype/);
  const r2 = await call("classify_image", { image_base64: `data:image/png;base64,${PNG_1X1_BASE64}` });
  assert.equal(r2.isError, undefined, text(r2));
  assert.match(up.seen[1].body.toString("latin1"), /filename="image.png"/);
  const missing = await call("classify_image", { image_path: join(dir, "nope.png") });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /cannot read file .*ENOENT/);
  const bad = await call("classify_image", { image_base64: "@@not base64@@" });
  assert.equal(bad.isError, true);
  await close();
  await up.close();
});

test("image response: JSON base64 field becomes an image block with summary, image/* body too", async () => {
  const up = await mockUpstream((req, res) => {
    if (req.url === "/v1/explain") return json(res, 200, { heatmap_png_base64: PNG_1X1_BASE64, summary: "attention on the upper left" });
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1X1_BASE64, "base64"));
  });
  const { call, close } = await connect(classifier, { baseUrl: up.baseUrl });
  const r = await call("explain_prediction", { image_base64: PNG_1X1_BASE64 });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(r.content[0].type, "image");
  assert.equal((r.content[0] as { mimeType: string }).mimeType, "image/png");
  assert.equal((r.content[0] as { data: string }).data, PNG_1X1_BASE64);
  assert.equal((r.content[1] as { text: string }).text, "attention on the upper left");
  assert.match((r.content[2] as { text: string }).text, /Research prototype/);
  const rawCfg = { name: "raw", tools: [{ name: "pic", description: "raw image", method: "GET", path: "/raw.png", response: { image: true } }] };
  const raw = await connect(rawCfg, { baseUrl: up.baseUrl });
  const r2 = await raw.call("pic");
  assert.equal(r2.content[0].type, "image");
  assert.equal((r2.content[0] as { mimeType: string }).mimeType, "image/png");
  await raw.close();
  await close();
  await up.close();
});

test("config validation refuses inconsistent tool definitions", () => {
  const base = { name: "c", tools: [{ name: "x", description: "d", method: "GET", path: "/a/{id}", inputs: {} }] };
  assert.throws(() => parseConfig(base), /path parameter \{id\} has no input/);
  assert.throws(() => parseConfig({ name: "c", tools: [{ name: "x", description: "d", method: "GET", path: "/a", inputs: { f: { type: "file", in: "multipart" } } }] }), /GET cannot carry multipart/);
  assert.throws(() => parseConfig({ name: "c", tools: [{ name: "x", description: "d", method: "POST", path: "/a", inputs: { a: { type: "string", in: "body" }, b: { type: "string", in: "body", optional: true } }, exactlyOneOf: [["a", "b"]] }] }), /must be optional/);
  assert.throws(() => parseConfig({ name: "c", tools: [{ name: "x", description: "d", method: "GET", path: "/a" }, { name: "x", description: "d", method: "GET", path: "/b" }] }), /duplicate tool name/);
  assert.throws(() => parseConfig({ name: "c", tools: [{ name: "bad name!", description: "d", method: "GET", path: "/a" }] }));
});
