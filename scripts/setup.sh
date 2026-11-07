#!/usr/bin/env bash
# 为本插件目录里的 engine/ 创建虚拟环境并安装依赖。
# 用法:
#   bash scripts/setup.sh
#   bash scripts/setup.sh --skip-models
#   bash scripts/setup.sh --force --python /usr/bin/python3.12
#
# 不带 --skip-models 时会下载模型（约 2GB+）。下载失败则整个脚本失败，
# 不会打印“安装完成”。macOS 不使用 PyTorch CPU 索引（该索引没有 macOS wheel）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$ROOT/engine"
VENV="$ENGINE/.venv"
REQ="$ENGINE/requirements.txt"
MODELS="$ENGINE/models"
SKIP_MODELS=0
FORCE=0
PYTHON_BIN="${PYTHON:-}"
# 仅测试用来模拟 uname。正常安装不要设置。
OS_NAME="${SETUP_UNAME_S:-$(uname -s)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-models) SKIP_MODELS=1; shift ;;
    --force) FORCE=1; shift ;;
    --python) PYTHON_BIN="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "== dsh-meeting-recorder engine setup =="
echo "Plugin root: $ROOT"
echo "Engine: $ENGINE"
echo "OS: $OS_NAME"

pick_python() {
  if [[ -n "$PYTHON_BIN" ]]; then
    if ! "$PYTHON_BIN" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
      echo "Python is not 3.10+: $PYTHON_BIN" >&2
      exit 1
    fi
    echo "$PYTHON_BIN"
    return
  fi
  local c
  for c in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$c" >/dev/null 2>&1; then
      if "$c" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
        command -v "$c"
        return
      fi
    fi
  done
  echo "Need Python 3.10+ on PATH" >&2
  exit 1
}

PY="$(pick_python)"
echo "Using Python: $PY"

if [[ -d "$VENV" && "$FORCE" -eq 1 ]]; then
  echo "Removing existing .venv (--force)..."
  rm -rf "$VENV"
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating venv..."
  "$PY" -m venv "$VENV"
fi

VENV_PY="$VENV/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  echo "venv python missing: $VENV_PY" >&2
  exit 1
fi

"$VENV_PY" -m pip install -U pip wheel setuptools

case "$OS_NAME" in
  Darwin)
    echo "Installing torch / torchaudio from PyPI."
    echo "macOS wheels are not published on the PyTorch CPU index."
    "$VENV_PY" -m pip install torch torchaudio
    ;;
  *)
    echo "Installing CPU torch / torchaudio from ${PYTORCH_CPU_INDEX:-https://download.pytorch.org/whl/cpu}"
    "$VENV_PY" -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
    ;;
esac

echo "Installing FunASR stack from requirements.txt..."
"$VENV_PY" -m pip install -r "$REQ"

echo "Running selfcheck..."
( cd "$ENGINE" && "$VENV_PY" -m speech_engine selfcheck )

if [[ "$SKIP_MODELS" -eq 0 ]]; then
  echo "Downloading FunASR models into engine/models (about 2GB+, needs network)..."
  mkdir -p "$MODELS"
  if ! ( cd "$ENGINE" && "$VENV_PY" -m speech_engine models --model-cache "$MODELS" ); then
    echo "ERROR: model download failed. Python dependencies may be present, but setup is NOT complete." >&2
    echo "Re-run this script, or transcribe later to retry the download. Do not treat this run as finished." >&2
    exit 1
  fi
  echo "Python dependencies are installed and the model download step succeeded."
else
  echo "Skipped model download (--skip-models)."
  echo "Python dependencies are installed. Model weights were NOT downloaded."
  echo "The first transcription will try to download them (about 2GB+), or re-run without --skip-models."
fi

echo "Setup script finished. This does not install the plugin into Harness."
echo "If Harness loaded a copy of this folder, run setup in that copy, or use the in-plugin installer."
