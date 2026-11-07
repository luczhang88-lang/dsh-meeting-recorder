import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('setup.sh fails when pip or the model download fails, and macOS avoids the CPU index', async () => {
  const cases = [
    {
      name: 'skip models succeeds without claiming weights are present',
      env: { FAKE_PIP_EXIT: '0', FAKE_MODELS_EXIT: '0', FAKE_SELFCHECK_EXIT: '0' },
      args: ['--skip-models'],
      exit: 0,
      includes: ['Model weights were NOT downloaded'],
      excludes: ['model download step succeeded'],
    },
    {
      name: 'model download failure is not success',
      env: { FAKE_PIP_EXIT: '0', FAKE_MODELS_EXIT: '7', FAKE_SELFCHECK_EXIT: '0' },
      args: [],
      exit: 1,
      includes: ['setup is NOT complete'],
      excludes: ['model download step succeeded'],
    },
    {
      name: 'pip failure stops setup',
      env: { FAKE_PIP_EXIT: '9', FAKE_MODELS_EXIT: '0', FAKE_SELFCHECK_EXIT: '0' },
      args: ['--skip-models'],
      exit: 9,
      includes: [],
      excludes: ['Setup script finished'],
    },
    {
      name: 'linux requests the pytorch cpu index',
      env: { FAKE_PIP_EXIT: '0', FAKE_SELFCHECK_EXIT: '0', SETUP_UNAME_S: 'Linux' },
      args: ['--skip-models'],
      exit: 0,
      includes: ['download.pytorch.org/whl/cpu'],
      excludes: [],
    },
    {
      name: 'darwin does not request the pytorch cpu index',
      env: { FAKE_PIP_EXIT: '0', FAKE_SELFCHECK_EXIT: '0', SETUP_UNAME_S: 'Darwin' },
      args: ['--skip-models'],
      exit: 0,
      includes: ['Installing torch / torchaudio from PyPI'],
      excludes: ['download.pytorch.org/whl/cpu'],
    },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-setup-sh-'));
    const log = join(root, 'pip.log');
    try {
      await mkdir(join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, 'engine'), { recursive: true });
      await writeFile(join(root, 'engine', 'requirements.txt'), '# test\n', 'utf8');
      const script = await readFile(join(repoRoot, 'scripts', 'setup.sh'));
      await writeFile(join(root, 'scripts', 'setup.sh'), script);
      const fake = join(root, 'fake-python.sh');
      await writeFile(fake, FAKE_PYTHON, 'utf8');
      await chmod(fake, 0o755);
      const { code, output } = await runBash(join(root, 'scripts', 'setup.sh'), item.args, {
        ...item.env,
        FAKE_LOG: log,
        PATH: process.env.PATH,
      }, fake);
      assert.equal(code, item.exit, item.name);
      for (const text of item.includes) assert.match(output, new RegExp(escapeRegExp(text)), item.name);
      for (const text of item.excludes) assert.equal(output.includes(text), false, item.name);
      if (item.env.SETUP_UNAME_S === 'Darwin') {
        const pipLog = await readFile(log, 'utf8');
        assert.equal(pipLog.includes('download.pytorch.org/whl/cpu'), false, item.name);
      }
      if (item.env.SETUP_UNAME_S === 'Linux') {
        const pipLog = await readFile(log, 'utf8');
        assert.match(pipLog, /download\.pytorch\.org\/whl\/cpu/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('setup.ps1 checks native exit codes and does not treat a model failure as done', async () => {
  const text = await readFile(join(repoRoot, 'scripts', 'setup.ps1'), 'utf8');
  assert.match(text, /function Invoke-Native/);
  assert.match(text, /LASTEXITCODE -ne 0/);
  assert.match(text, /model download failed/);
  assert.match(text, /setup is NOT complete/);
  assert.equal(text.includes('Write-Warning "Model download failed'), false);
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runBash(script, args, env, python) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, '--python', python, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

const FAKE_PYTHON = `#!/bin/bash
if [[ "\${1:-}" == "-c" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "-m" && "\${2:-}" == "venv" ]]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
if [[ "\${1:-}" == "-m" && "\${2:-}" == "pip" ]]; then
  printf '%s\\n' "$*" >> "\${FAKE_LOG:?}"
  exit "\${FAKE_PIP_EXIT:-0}"
fi
if [[ "\${1:-}" == "-m" && "\${2:-}" == "speech_engine" ]]; then
  printf '%s\\n' "$*" >> "\${FAKE_LOG:?}"
  if [[ "\${3:-}" == "models" ]]; then
    exit "\${FAKE_MODELS_EXIT:-0}"
  fi
  exit "\${FAKE_SELFCHECK_EXIT:-0}"
fi
echo "unexpected python args: $*" >&2
exit 99
`;
