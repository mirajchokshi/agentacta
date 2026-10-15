#!/usr/bin/env bash
# Removes everything the benchmark created: containers, volumes, networks and
# images of the "aabench" compose project, plus the state folder.
set -u
BENCH_HOME="${BENCH_HOME:-$HOME/agentacta-bench-env}"
docker ps -aq --filter label=com.docker.compose.project=aabench | xargs -r docker rm -f
docker volume ls -q --filter label=com.docker.compose.project=aabench | xargs -r docker volume rm
docker network ls -q --filter label=com.docker.compose.project=aabench | xargs -r docker network rm
docker images -q --filter label=aabench=1 | xargs -r docker rmi -f
# Third-party images pulled for the benchmark are listed here as they are pulled.
[ -f "$BENCH_HOME/images.txt" ] && sort -u "$BENCH_HOME/images.txt" | xargs -r docker rmi -f
rm -rf "$BENCH_HOME"
echo "Benchmark environment removed."
