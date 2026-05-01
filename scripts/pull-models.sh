#!/usr/bin/env bash
# Pull the Qwen 3 model into Ollama.
# Run after: docker compose up -d ollama

set -euo pipefail

MODEL=${OLLAMA_MODEL:-qwen3:14b}

echo "Pulling model: $MODEL"
docker compose exec ollama ollama pull "$MODEL"
echo "Done. Model $MODEL is ready."
