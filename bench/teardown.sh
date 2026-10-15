#!/usr/bin/env bash
# Removes everything the benchmark created: containers, volumes, networks and
# images of the "aabench" compose project, the images its compose files pull,
# and the state folder.
set -u
cd "$(dirname "$0")"
BENCH_HOME="${BENCH_HOME:-$HOME/agentacta-bench-env}"
docker ps -aq --filter label=com.docker.compose.project=aabench | xargs -r docker rm -f
docker volume ls -q --filter label=com.docker.compose.project=aabench | xargs -r docker volume rm
docker network ls -q --filter label=com.docker.compose.project=aabench | xargs -r docker network rm
docker images -q --filter label=aabench=1 | xargs -r docker rmi -f
# Pulled images (and the AgentActa build's base image). Not forced: an image
# another container still uses is kept.
{
  for f in compose.agentsview.yml compose.langfuse.yml; do docker compose -f "$f" config --images 2>/dev/null; done
  sed -n 's/^FROM //p' agentacta/Dockerfile
} | sort -u | xargs -r docker rmi 2>/dev/null
# Only delete a folder that gen-dataset.js filled.
if [ -d "$BENCH_HOME" ]; then
  if [ -f "$BENCH_HOME/data/normalized.jsonl" ]; then rm -rf "$BENCH_HOME"
  else echo "Kept $BENCH_HOME: it doesn't look like a benchmark folder (no data/normalized.jsonl)." >&2
  fi
fi
echo "Benchmark environment removed."
