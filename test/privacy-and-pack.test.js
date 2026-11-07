import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'models', 'test-output']);

test('tracked source has no local paths, placeholders, or secret material', async () => {
  const files = await walk(repoRoot);
  const findings = [];
  const patterns = [
    { name: 'local-market-path', re: /[A-Za-z]:[\\/]+AI[\\/]+DeepSeek[\\/]+dsh-market/i },
    { name: 'local-publish-path', re: /[A-Za-z]:[\\/]+AI[\\/]+DeepSeek[\\/]+speech-engine/i },
    { name: 'windows-user-path', re: /[A-Za-z]:\\Users\\/ },
    { name: 'posix-user-path', re: /\/Users\/[A-Za-z0-9._-]+\// },
    { name: 'todo-repo', re: /TODO_USER|TODO: after GitHub/ },
    { name: 'private-key', re: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/ },
    { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'generic-secret', re: /(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}/i },
  ];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.re.test(text)) findings.push(`${pattern.name}: ${relative(repoRoot, file)}`);
    }
  }

  assert.deepEqual(findings, []);
});

test('npm pack contains the engine sources and setup scripts, not weights or a venv', async () => {
  const { code, stdout, stderr } = await run('npm', ['pack', '--dry-run', '--json'], repoRoot);
  assert.equal(code, 0, stderr);
  const packed = JSON.parse(stdout);
  const names = new Set(packed[0].files.map((file) => file.path));
  for (const required of [
    'engine/speech_engine/cli.py',
    'engine/speech_engine/pipeline.py',
    'engine/speech_engine/docx_writers.py',
    'engine/requirements.txt',
    'scripts/setup.sh',
    'scripts/setup.ps1',
    'scripts/setup.cmd',
    'host/engine-setup.js',
    'INSTALL.md',
    'THIRD_PARTY.md',
  ]) {
    assert.equal(names.has(required), true, required);
  }
  for (const name of names) {
    assert.equal(name.includes('.venv'), false, name);
    assert.equal(name.startsWith('engine/models/'), false, name);
    assert.equal(/\.(wav|mp3|m4a|flac|ogg|docx|pem|key)$/i.test(name), false, name);
    assert.equal(name.includes('.env'), false, name);
  }
});

async function walk(dir, found = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found);
    } else if (entry.isFile()) {
      if (entry.name === 'privacy-and-pack.test.js') continue;
      const info = await stat(path);
      if (info.size > 2_000_000) continue;
      if (/\.(png|jpg|jpeg|gif|webp|zip|woff2?)$/i.test(entry.name)) continue;
      found.push(path);
    }
  }
  return found;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
