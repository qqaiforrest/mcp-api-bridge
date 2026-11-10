# 60-second demo script (screen recording)

Goal: a client sees, without narration, that the bridge is real, tested, and works in Claude Desktop. One take, no cuts needed.

| Time | Show | Say (optional caption) |
|---|---|---|
| 0:00 | Terminal in the repo. Run `pnpm test`. Wait for `pass 11`. | "Eleven tests against a mock upstream." |
| 0:10 | Open `examples/open-meteo.json`, scroll once. | "Every tool is one config block. No code." |
| 0:18 | Run the Inspector `tools/call` command from the README. Output shows a real forecast. | "Verified through the official MCP Inspector." |
| 0:30 | Switch to Claude Desktop. Click the tools icon, show the two tools listed. | "Same server in Claude Desktop." |
| 0:36 | Ask: "What is the weather in Victoria, BC right now and tomorrow?" Approve the tool call. | |
| 0:48 | The answer appears with the Open-Meteo disclaimer line. | "Disclaimer attached to every response." |
| 0:54 | Back to terminal: `wc -l src/*.ts` (about 440 lines). End on the GitHub repo page. | "Small enough to audit before you trust it." |

Prep: `pnpm build`, add the Claude Desktop config from the README with absolute paths, restart Claude Desktop, confirm the tools appear before recording. Window size 1280x720, dark terminal, font 16pt.

For the image example (`examples/image-classifier.json`) a second 30-second clip can show `explain_prediction` returning a heatmap inline in Claude Desktop once a real or mock classifier is running on `API_BASE_URL`.


## Recorded 2026-11-10
`docs/demo.mp4` (60 s, 1280x720, 0.6 MB). Built from real captures: `pnpm test` output, `examples/open-meteo.json`, MCP Inspector 2.14 (connect, form, live result with disclaimer), the Claude Desktop config block, and the GitHub page. Claude Desktop itself was not recorded because restarting it would have killed the working session; redo that scene when a second machine is available.
