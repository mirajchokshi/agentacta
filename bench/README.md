# Benchmarks

How AgentActa compares with other open-source tools for watching AI agents, on
the same data, measured the same way. Everything runs in Docker under one
compose project (`aabench`), bound to `127.0.0.1`, with each tool's telemetry
off, and is removed by one script.

## Tools

| Tool | License | Version | How it gets the data |
|---|---|---|---|
| AgentActa | MIT | this repo | reads the agent log files (mounted read-only) |
| [agentsview](https://github.com/kenn-io/agentsview) | MIT | 0.45.0 (`ghcr.io/kenn-io/agentsview:0.45.0`) | reads the agent log files (mounted read-only) |
| [Langfuse](https://github.com/langfuse/langfuse) | MIT (core; `ee/` directories excluded) | 4.59.0 (image `langfuse:4`, digests below) | OpenTelemetry traces sent by `langfuse/load.mjs` |

Not included: Arize Phoenix and the AgentOps dashboard are under the Elastic
License 2.0, which is not an open-source license. Other candidates surveyed:
Opik, Laminar, OpenLIT, MLflow tracing, Helicone, claude-code-history-viewer.

Langfuse image digests: web `sha256:48ecae32cd74…bb2d34`, worker `sha256:246a3a0fab57…b564175`.

## Data

`gen-dataset.js` writes a deterministic (seed 42) history shaped like a real
one: 4,400 sessions, 370,089 events (2,597 Claude Code, 1,088 Codex, 715
OpenClaw), 280 MB of logs, most sessions short, one with 7,500 events and one
with 30,000. Unique words are planted in known sessions for search checks.
The same sessions are also written as `normalized.jsonl`, which the Langfuse
loader converts to traces (one trace per session, one span per event, original
timestamps), so every tool holds the same content.

## What is measured

- **Ingest**: from an empty state until every session is queryable. AgentActa
  and agentsview parse the raw log files; Langfuse receives already-parsed
  spans from the loader (send time included), then processes them in its
  worker. Not the same work: reported for completeness.
- **Restart**: container start (existing data) until the first data request answers.
- **UI** (`ui-bench.mjs`, headless Chrome, 1280×900, cache disabled, fresh
  profile per round, median of 5): open the app; open the 7,500- and
  30,000-event sessions by URL; scroll the long one; search. "Ready" is the
  last network response before 700 ms with nothing in flight (streams and
  long polls excluded); LCP is Chrome's largest contentful paint.
- **Search**: the time from entering a word to a matching result in the UI.
  Pasted at once, and typed at 110 ms per key (AgentActa matches as you type,
  so the typed result can already be on screen when the last key lands).
  Langfuse searches on Enter. One untimed search runs first in each round.
- **Memory**: `docker stats` after the workload, summed over each tool's containers.

## Results (2026-10-15)

One machine (16 cores, 92 GB RAM, Docker 29), desktop browser at normal CPU
speed, median of 5 rounds where repeated. Times in milliseconds unless noted.

| | AgentActa | agentsview 0.45.0 | Langfuse 4.59.0 |
|---|---:|---:|---:|
| **Ingest** from empty until every session is queryable | 42.4 s | 60.1 s | 35.2 s ¹ |
| Answers HTTP after a cold start (empty) | 0.35 s | 60.7 s ² | 18.1 s |
| **Restart** (existing data) to first data | 0.28 s | 0.58 s | 13.7 s ³ |
| **Open the app**: first content (LCP) / requests settled | 80 / 262 | 588 / 1,601 | 696 / 1,238 ⁴ |
| **Open the 7,500-event session**: LCP / settled | 108 / 90 | 424 / 1,205 | 516 / 1,549 |
| **Open the 30,000-event session**: LCP / settled | 124 / 99 | 1,048 / 1,755 | 2,568 / 2,776 |
| **Scroll** the 7,500-event session: frames over 50 ms (of 300) | 0 | 4 (max 117) | 0 |
| **Search**, word in a message (pasted) | 116 | 685 | 141 ⁵ |
| **Search**, word in a session's first prompt (pasted) | 105 | 315 | 141 ⁵ |
| **Search**, word inside a tool's output (pasted) | 116 | not found | not found |
| Search, typed: last keystroke to result | 0 ⁶ | 209 | 145 ⁵ |
| **Memory** after the workload (all containers) | 125 MB | 173 MB | 3.55 GB (6 containers) |
| **Disk** (data volumes) | 524 MB | 534 MB | 665 MB |

1. Langfuse receives already-parsed spans (loader send time 6.6 s included) and
   processes them in its worker; the other two parse 280 MB of raw log files.
2. agentsview runs its initial sync before it starts serving.
3. Time until Langfuse's health endpoint answers.
4. Langfuse's traces list with its widest preset range (90 days).
5. Langfuse searches when Enter is pressed, from the box above the traces table.
6. AgentActa matches as you type, so the result was already on screen when the last key landed.

What this does and doesn't show: on this dataset and these tasks, AgentActa
was fastest on every UI task and used the least memory; Langfuse ingested
fastest, but it was handed pre-parsed data. Each tool does things the others
don't (agentsview's analytics and semantic search, Langfuse's evals, prompt
management and team features), and the timings don't account for those.
Only desktop at normal CPU speed was measured; phones were not.

Found along the way: AgentActa did not index Claude Code tool output (fixed
before these results). agentsview's first search after a page load showed no
results when driven by synthetic Ctrl+K keystrokes (it worked when clicked by
hand), so each round runs one untimed search first, for every tool.

## Run it

```bash
node bench/gen-dataset.js ~/agentacta-bench-env/data
docker compose -f bench/compose.agentacta.yml up -d --build
docker compose -f bench/compose.agentsview.yml up -d
docker compose -f bench/compose.langfuse.yml up -d && node bench/langfuse/load.mjs
WARM_SEARCH=1 node bench/ui-bench.mjs agentacta 5    # also: agentsview, langfuse
bench/teardown.sh                                      # removes all of it
```
