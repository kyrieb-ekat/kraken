#!/bin/bash
# Start the Kraken Training Interface
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Activate conda environment
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate kraken

echo "Starting Kraken Training Interface at http://localhost:8000"
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
