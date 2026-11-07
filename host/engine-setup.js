/**
 * 在「当前加载的插件目录」里启动捆绑的 setup 脚本。
 *
 * 只允许固定脚本和固定开关，不接受调用方传入的命令、路径或 shell 字符串。
 * 默认不下载模型：权重大约 2GB+，必须由调用方把 downloadModels 设为 true。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PYTORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

const LOG_LIMIT = 200;
const LINE_LIMIT = 500;

/** PyTorch 官方 CPU 索引没有 macOS wheel，macOS 走 PyPI 默认源。 */
export function torchInstallPlan(platform) {
  if (platform === 'darwin') {
    return {
      platform,
      index: 'pypi',
      pipArgs: [],
      note: 'macOS 的 torch / torchaudio 从 PyPI 安装。download.pytorch.org/whl/cpu 不提供 macOS wheel。',
    };
  }

  return {
    platform,
    index: 'pytorch-cpu',
    pipArgs: ['--index-url', PYTORCH_CPU_INDEX],
    note: 'Linux / Windows 从 PyTorch CPU 索引安装 torch / torchaudio。',
  };
}

export function isInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = target.slice(root.length);
  if (target === root) return true;
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  const prefixWin = root.endsWith('\\') ? root : `${root}\\`;
  return target.startsWith(prefix) || target.startsWith(prefixWin) ? !rel.includes('\0') : false;
}

/**
 * 构造将要执行的命令。platform 只影响选择哪一个捆绑脚本。
 * downloadModels 只有严格的 true 才会下载模型。
 */
export function buildSetupCommand({ pluginRoot, platform, downloadModels = false, force = false }) {
  const root = resolve(pluginRoot);
  const models = downloadModels === true;
  const rewrite = force === true;

  if (platform === 'win32') {
    const script = join(root, 'scripts', 'setup.ps1');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (!models) args.push('-SkipModels');
    if (rewrite) args.push('-Force');
    return { command: 'powershell.exe', args, script, cwd: root, shell: false, downloadModels: models };
  }

  const script = join(root, 'scripts', 'setup.sh');
  const args = [script];
  if (!models) args.push('--skip-models');
  if (rewrite) args.push('--force');
  return { command: 'bash', args, script, cwd: root, shell: false, downloadModels: models };
}

export function assertBundledSetup({ pluginRoot, engineRoot, bundledEngineRoot, command }) {
  const root = resolve(pluginRoot);
  const engine = resolve(engineRoot);
  const bundled = resolve(bundledEngineRoot);

  if (engine !== bundled) {
    throw new Error(
      '当前 engineRoot 不是本插件自带的 engine/。界面不会代跑 setup，请到那个目录按 INSTALL.md 安装。',
    );
  }

  if (dirname(bundled) !== root) {
    throw new Error('插件目录与捆绑 engine 不在同一棵目录下，已拒绝执行 setup。');
  }

  if (!isInside(root, command.script)) {
    throw new Error('setup 脚本不在插件目录内，已拒绝执行。');
  }

  const allowed = new Set(['bash', 'powershell.exe']);
  if (!allowed.has(command.command) || command.shell) {
    throw new Error('拒绝以 shell 方式启动安装。');
  }

  if (!existsSync(command.script)) {
    throw new Error(`找不到安装脚本：${command.script}`);
  }
}

function emptyState() {
  return {
    phase: 'idle',
    running: false,
    downloadModels: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    log: [],
  };
}

export class EngineSetup {
  constructor({
    pluginRoot,
    bundledEngineRoot,
    platform = process.platform,
    spawnImpl = spawn,
    env = process.env,
  }) {
    this.pluginRoot = resolve(pluginRoot);
    this.bundledEngineRoot = resolve(bundledEngineRoot);
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.child = null;
    this.state = emptyState();
  }

  snapshot(extra = {}) {
    return {
      ...this.state,
      log: this.state.log.slice(),
      ...extra,
    };
  }

  start({ engineRoot, downloadModels = false, force = false } = {}) {
    if (this.state.running) {
      return { ok: true, alreadyRunning: true, setup: this.snapshot() };
    }

    const command = buildSetupCommand({
      pluginRoot: this.pluginRoot,
      platform: this.platform,
      downloadModels,
      force,
    });

    try {
      assertBundledSetup({
        pluginRoot: this.pluginRoot,
        engineRoot,
        bundledEngineRoot: this.bundledEngineRoot,
        command,
      });
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), setup: this.snapshot() };
    }

    this.state = {
      phase: 'running',
      running: true,
      downloadModels: command.downloadModels,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
      log: [
        command.downloadModels
          ? '开始安装依赖，并下载模型（约 2GB+，需要网络）。'
          : '开始安装依赖。这一步不下载模型。',
      ],
    };

    let child;
    try {
      child = this.spawnImpl(command.command, command.args, {
        cwd: command.cwd,
        shell: false,
        windowsHide: true,
        detached: this.platform !== 'win32',
        env: {
          ...this.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      });
    } catch (error) {
      this.state = {
        ...this.state,
        phase: 'failed',
        running: false,
        finishedAt: new Date().toISOString(),
        error: error?.message ?? String(error),
      };
      return { ok: false, error: this.state.error, setup: this.snapshot() };
    }

    this.child = child;
    let buffer = '';

    const push = (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) this.pushLine(line);
    };

    child.stdout?.on('data', push);
    child.stderr?.on('data', push);

    child.on('error', (error) => {
      this.finish({
        exitCode: null,
        error: error?.message ?? String(error),
      });
    });

    child.on('close', (code) => {
      if (buffer.trim()) this.pushLine(buffer);
      buffer = '';
      this.finish({ exitCode: code, error: null });
    });

    return { ok: true, alreadyRunning: false, setup: this.snapshot() };
  }

  pushLine(line) {
    const text = String(line ?? '').replace(/\u0000/g, '').slice(0, LINE_LIMIT);
    if (!text.trim()) return;
    this.state.log.push(text);
    if (this.state.log.length > LOG_LIMIT) {
      this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
    }
  }

  finish({ exitCode, error }) {
    if (!this.state.running && this.state.phase !== 'running') return;
    const failed = Boolean(error) || exitCode !== 0;
    this.child = null;
    this.state = {
      ...this.state,
      phase: failed ? 'failed' : 'succeeded',
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode,
      error,
    };
  }

  cancel() {
    const child = this.child;
    if (!child || !this.state.running) {
      return { ok: true, setup: this.snapshot() };
    }

    try {
      if (this.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGTERM');
      } else {
        child.kill();
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* 进程已经退出 */
      }
    }

    this.pushLine('已请求停止安装。');
    return { ok: true, setup: this.snapshot() };
  }
}
