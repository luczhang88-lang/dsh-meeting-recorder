import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EngineSetup,
  PYTORCH_CPU_INDEX,
  buildSetupCommand,
  isInside,
  torchInstallPlan,
} from '../host/engine-setup.js';

test('torch plan uses PyPI on macOS and the CPU index elsewhere', () => {
  assert.equal(torchInstallPlan('darwin').index, 'pypi');
  assert.deepEqual(torchInstallPlan('darwin').pipArgs, []);
  assert.equal(torchInstallPlan('linux').index, 'pytorch-cpu');
  assert.deepEqual(torchInstallPlan('win32').pipArgs, ['--index-url', PYTORCH_CPU_INDEX]);
  assert.equal(PYTORCH_CPU_INDEX, 'https://download.pytorch.org/whl/cpu');
});

test('setup command accepts only real booleans and fixed scripts', () => {
  const skipped = buildSetupCommand({
    pluginRoot: '/tmp/plugin',
    platform: 'linux',
    downloadModels: 'true; rm -rf /',
    force: 'yes',
  });
  assert.equal(skipped.command, 'bash');
  assert.equal(skipped.shell, false);
  assert.deepEqual(skipped.args, ['/tmp/plugin/scripts/setup.sh', '--skip-models']);

  const full = buildSetupCommand({
    pluginRoot: '/tmp/plugin',
    platform: 'win32',
    downloadModels: true,
    force: true,
  });
  assert.equal(full.command, 'powershell.exe');
  assert.deepEqual(full.args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    '/tmp/plugin/scripts/setup.ps1',
    '-Force',
  ]);
  assert.equal(full.args.includes('-SkipModels'), false);
});

test('isInside stays inside the plugin directory', () => {
  assert.equal(isInside('/tmp/plugin', '/tmp/plugin/scripts/setup.sh'), true);
  assert.equal(isInside('/tmp/plugin', '/tmp/plugin'), true);
  assert.equal(isInside('/tmp/plugin', '/tmp/plugin-evil/scripts/setup.sh'), false);
  assert.equal(isInside('/tmp/plugin', '/tmp/plugin/../../etc/passwd'), false);
});

test('in-plugin setup runs the stub and records a non-zero model failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-setup-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'engine'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'setup.sh'),
      `#!/bin/bash
echo "plugin-setup $*"
if [[ "$*" == *--skip-models* ]]; then
  echo "deps only"
  exit 0
fi
echo "model download failed" >&2
exit 4
`,
      'utf8',
    );

    const runner = new EngineSetup({
      pluginRoot: root,
      bundledEngineRoot: join(root, 'engine'),
      platform: 'linux',
    });

    const denied = runner.start({
      engineRoot: '/tmp/somewhere-else/engine',
      downloadModels: false,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /engine/);

    const started = runner.start({
      engineRoot: join(root, 'engine'),
      downloadModels: true,
    });
    assert.equal(started.ok, true);
    await waitUntil(() => !runner.state.running);
    assert.equal(runner.state.phase, 'failed');
    assert.equal(runner.state.exitCode, 4);
    assert.match(runner.state.log.join('\n'), /model download failed/);

    const deps = runner.start({
      engineRoot: join(root, 'engine'),
      downloadModels: false,
    });
    assert.equal(deps.ok, true);
    await waitUntil(() => !runner.state.running);
    assert.equal(runner.state.phase, 'succeeded');
    assert.match(runner.state.log.join('\n'), /--skip-models/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel stops a running setup process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-setup-cancel-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'engine'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'setup.sh'),
      '#!/bin/bash\necho started\nsleep 30\n',
      'utf8',
    );
    const runner = new EngineSetup({
      pluginRoot: root,
      bundledEngineRoot: join(root, 'engine'),
      platform: 'linux',
      spawnImpl: spawn,
    });
    runner.start({ engineRoot: join(root, 'engine'), downloadModels: false });
    await waitUntil(() => runner.state.log.some((line) => line.includes('started')));
    runner.cancel();
    await waitUntil(() => !runner.state.running);
    assert.notEqual(runner.state.phase, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function waitUntil(predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error('timed out'));
      }
    }, 20);
  });
}
