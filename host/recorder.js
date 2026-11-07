/**
 * 会议录音插件 · Host 半边核心。
 *
 * 职责边界（重要设计决定）：
 *   - 浏览器负责采集麦克风（只有浏览器能拿到音频输入设备）
 *   - Host 负责落盘、调度本地 Python 引擎、生成 Word 交付物
 *   - 录音数据以 32-bit float 单声道 16 kHz 原始 PCM 从 Client 流到 Host，
 *     边到边写盘。不做编码：省一次转码、音质无损，且格式正是引擎要吃的格式。
 *
 * 为什么用原始 PCM 而不是 WAV：
 *   WAV 头里的长度字段只有在录制结束后才知道，边写边改头容易写坏文件。
 *   所以先写纯 PCM，收尾时再补 WAV 头（见 finalizeRecording）。
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { MEDIA_PATH } from './paths.js';
import { EngineSetup } from './engine-setup.js';

/** 采集格式：必须与 Client 半边的 AudioWorklet 保持一致。 */
export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 4; // float32
export const CHANNELS = 1;

/** 当前加载的插件根目录，以及它旁边的 engine/。本机 @local 插件不走这份文件。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_ENGINE_ROOT = join(PLUGIN_ROOT, 'engine');


/** 单次录音的上限保护：1 小时 PCM 约 230 MB，超过这个量级说明采集出错了。 */
const MAX_RECORDING_BYTES = 8 * 1024 * 1024 * 1024;

let counter = 0;

function nextId(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** 生成适合做文件夹名的时间戳：20261105_1830 */
export function folderStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** 去掉文件名里不允许出现的字符。中文、括号、空格都保留。 */
export function sanitizeSegment(text, fallback = '') {
  const cleaned = String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');

  return cleaned.length > 0 ? cleaned.slice(0, 60) : fallback;
}

export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${secs} 秒`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

/** 判断 child 是否位于 parent 之内。用于音频路由的路径边界校验。 */
/**
 * 读一个 JSON 文件；读不到、内容坏了都返回 null，不抛异常。
 *
 * 首页列清单时会逐场会议试探若干文件是否存在，用异常控制流程会很难读，
 * 所以统一收敛成 null。调用方只需判断"有没有"。
 */
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !resolve(child).includes('\u0000');
}

/**
 * 解析 HTTP Range 头。
 *
 * 只接受单段形式 `bytes=a-b` 及其两种省略写法（`bytes=a-`、`bytes=-n`）。
 * 多段 Range 不实现：浏览器的 <audio> 只发单段，为它写一个多段响应没有收益。
 *
 * 三种返回值刻意分开，避免调用方用 null / undefined / 对象混着判断而出错：
 *   undefined   —— 请求没带 Range，应回整段（200）
 *   null        —— Range 不合法或落在文件外，应回 416
 *   { start, end } —— 命中区间（206）
 */
function parseByteRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start;
  let end;

  if (match[1] === '') {
    // bytes=-n：最后 n 个字节
    const tail = Number(match[2]);
    if (!Number.isSafeInteger(tail) || tail <= 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 0 || start >= size || start > end) return null;

  return { start, end };
}


/** 取第一个非空字符串（trim 后）。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

/** 用户主目录下的相对路径。 */
function pathJoinHome(rel) {
  try {
    return join(homedir(), rel);
  } catch {
    return rel;
  }
}

export class MeetingRecorder {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** 输出根目录：每次录制先落在这里，交付时再复制到用户选定目录。 */
    this.root = resolve(
      firstNonEmpty(
        config.meetingsRoot,
        process.env.MEETING_RECORDER_MEETINGS_ROOT,
        process.env.DSH_MEETING_RECORDS,
        pathJoinHome('meeting-records'),
      ),
    );
    /** 引擎脚本目录（含 .venv 与 speech_engine 包）。 */
    this.engineRoot = resolve(
      firstNonEmpty(
        config.engineRoot,
        process.env.MEETING_RECORDER_ENGINE_ROOT,
        process.env.DSH_SPEECH_ENGINE_ROOT,
        BUNDLED_ENGINE_ROOT,
      ),
    );
    this.modelCacheDir = String(
      firstNonEmpty(
        config.modelCacheDir,
        process.env.MEETING_RECORDER_MODEL_CACHE,
        process.env.MODELSCOPE_CACHE,
        join(this.engineRoot, 'models'),
      ),
    );
    this.pythonPath = String(
      firstNonEmpty(
        config.pythonPath,
        process.env.MEETING_RECORDER_PYTHON,
        process.env.DSH_MEETING_PYTHON,
        '',
      ),
    ).trim();
    this.defaultOutputDir = String(config.defaultOutputDir || '');
    this.maxRecordingHours = Number(config.maxRecordingHours || 6);

    /**
     * 会话按插件实例持有，不放在模块作用域。
     * 模块级 Map 会让两个插件实例共享状态，也让 ctx.effect 的清理语义失效。
     */
    this.sessions = new Map();
    /** 由 index.js 注入的转写任务表，供交付物模块复用同一份任务数据。 */
    this.jobs = null;

    this.started = false;
    this.engineSetup = new EngineSetup({
      pluginRoot: PLUGIN_ROOT,
      bundledEngineRoot: BUNDLED_ENGINE_ROOT,
    });
  }

  // ---------------------------------------------------------------- 生命周期

  async start() {
    if (this.started) return;
    await mkdir(this.root, { recursive: true });
    this.started = true;
  }

  async stop() {
    for (const session of this.sessions.values()) {
      await this.closeSessionStream(session);
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------- 录音

  async beginRecording(payload) {
    const { title = '', sampleRate = SAMPLE_RATE, channels = CHANNELS } = payload ?? {};

    if (sampleRate !== SAMPLE_RATE || channels !== CHANNELS) {
      return {
        ok: false,
        error:
          `不支持的采集参数：${sampleRate}Hz/${channels}声道。` +
          `插件固定使用 ${SAMPLE_RATE}Hz 单声道，以保证与本地语音引擎对齐。`,
      };
    }

    const id = nextId('rec_');
    const stamp = folderStamp();
    const label = sanitizeSegment(title);
    const folderName = label ? `${stamp}_${label}` : `${stamp}_会议录音`;
    const folder = join(this.root, folderName);

    await mkdir(folder, { recursive: true });

    const pcmPath = join(folder, '录音.pcm.raw');
    const wavPath = join(folder, '录音.wav');
    const stream = createWriteStream(pcmPath, { flags: 'w' });

    const session = {
      id,
      folder,
      folderName,
      pcmPath,
      wavPath,
      stream,
      title: label,
      sampleRate: SAMPLE_RATE,
      bytes: 0,
      startedAt: nowIso(),
      closed: false,
      failure: null,
      rehydrated: false,
      /** 重点标记。单一真源就在会话上，任务对象通过 sessionId 读它。 */
      marks: [],
    };

    stream.on('error', (error) => {
      session.failure = `写入录音文件失败：${error.message}`;
    });

    this.sessions.set(id, session);

    await this.writeMeta(session, { phase: 'recording' });

    return { ok: true, session: this.sessionView(session) };
  }

  /**
   * 接收一段 PCM。
   *
   * Client 用流式 POST 把 Float32Array 的底层字节原样传来，不做 base64 编码：
   * 省掉 33% 的体积膨胀，也省掉两端的编解码 CPU。这里只做字节搬运，
   * 不解析浮点值——保证边录边写不引入 CPU 负担。
   */
  async appendChunk(payload) {
    const { sessionId, buffer: incoming } = payload ?? {};
    const session = this.sessions.get(sessionId);

    if (!session) return { ok: false, error: '录音会话不存在或已结束' };
    if (session.closed) return { ok: false, error: '录音会话已经收尾' };
    if (session.failure) return { ok: false, error: session.failure };

    if (!Buffer.isBuffer(incoming) && !ArrayBuffer.isView(incoming)) {
      return { ok: false, error: '音频数据必须是原始字节' };
    }

    const buffer = Buffer.isBuffer(incoming)
      ? incoming
      : Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);

    if (buffer.length === 0) return { ok: true, session: this.sessionView(session) };
    if (buffer.length % BYTES_PER_SAMPLE !== 0) {
      return { ok: false, error: `音频块长度不是 ${BYTES_PER_SAMPLE} 字节的整数倍` };
    }

    if (session.bytes + buffer.length > MAX_RECORDING_BYTES) {
      session.failure = '录音数据超过安全上限，已停止接收。请分段录制。';
      return { ok: false, error: session.failure };
    }

    const flushed = session.stream.write(buffer);
    session.bytes += buffer.length;

    return {
      ok: true,
      backpressure: !flushed,
      session: this.sessionView(session),
    };
  }

  /** 收尾：关闭写流、补 WAV 头、计算时长。 */
  async finalizeRecording(payload) {
    const session = this.sessions.get(payload?.sessionId);
    if (!session) return { ok: false, error: '录音会话不存在' };

    await this.closeSessionStream(session);
    session.closed = true;
    session.endedAt = nowIso();

    if (session.failure) return { ok: false, error: session.failure };

    const seconds = session.bytes / BYTES_PER_SAMPLE / session.sampleRate;

    if (seconds < 0.5) {
      return { ok: false, error: `录音时长仅 ${seconds.toFixed(1)} 秒，太短无法转写` };
    }

    const wavWritten = await this.writeWavHeaderAndConcat(session);
    if (!wavWritten.ok) return wavWritten;

    session.seconds = Number(seconds.toFixed(3));
    await this.writeMeta(session, { phase: 'recorded' });

    return {
      ok: true,
      session: this.sessionView(session),
    };
  }

  async cancelRecording(payload) {
    const session = this.sessions.get(payload?.sessionId);
    if (!session) return { ok: true };

    await this.closeSessionStream(session);
    session.closed = true;

    try {
      await rm(session.folder, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响取消动作本身 */
    }

    this.sessions.delete(session.id);

    return { ok: true };
  }


  // ---------------------------------------------------------------- 导入录音

  /**
   * 后期导入：接收外部音频文件，统一转成 16 kHz 单声道 WAV，再走同一套转写流程。
   *
   * 支持 wav/mp3/m4a/flac/ogg 等；压缩格式依赖本机 ffmpeg（selfcheck 会提示）。
   * 原始文件保留为「原始录音.xxx」，转写始终读「录音.wav」。
   */
  static importExtensions() {
    return new Set([
      '.wav', '.wave', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus',
      '.wma', '.webm', '.mp4', '.amr', '.aiff', '.aif', '.au',
    ]);
  }

  async beginImport(payload) {
    const { title = '', filename = '录音.wav' } = payload ?? {};
    const rawName = String(filename || '录音.wav');
    const ext = extname(rawName).toLowerCase() || '.wav';

    if (!MeetingRecorder.importExtensions().has(ext)) {
      return {
        ok: false,
        error:
          `不支持的音频格式：${ext || '（无扩展名）'}。` +
          '请导入 wav / mp3 / m4a / flac / ogg / webm 等常见录音文件。',
      };
    }

    const id = nextId('rec_');
    const stamp = folderStamp();
    const label = sanitizeSegment(title) || sanitizeSegment(rawName.replace(extname(rawName), '')) || '导入录音';
    const folderName = `${stamp}_${label}`;
    const folder = join(this.root, folderName);
    await mkdir(folder, { recursive: true });

    const originalName = `原始录音${ext}`;
    const originalPath = join(folder, originalName);
    const wavPath = join(folder, '录音.wav');
    const stream = createWriteStream(originalPath, { flags: 'w' });

    const session = {
      id,
      folder,
      folderName,
      pcmPath: null,
      wavPath,
      originalPath,
      originalName,
      stream,
      title: label,
      sampleRate: SAMPLE_RATE,
      bytes: 0,
      startedAt: nowIso(),
      closed: false,
      failure: null,
      rehydrated: false,
      imported: true,
      marks: [],
    };

    stream.on('error', (error) => {
      session.failure = `写入导入文件失败：${error.message}`;
    });

    this.sessions.set(id, session);
    await this.writeMeta(session, { phase: 'importing', source: 'import', originalName });

    return { ok: true, session: this.sessionView(session) };
  }

  async appendImportChunk(payload) {
    const { sessionId, buffer: incoming } = payload ?? {};
    const session = this.sessions.get(sessionId);

    if (!session) return { ok: false, error: '导入会话不存在或已结束' };
    if (!session.imported) return { ok: false, error: '这场会议不是导入会话' };
    if (session.closed) return { ok: false, error: '导入会话已经收尾' };
    if (session.failure) return { ok: false, error: session.failure };

    if (!Buffer.isBuffer(incoming) && !ArrayBuffer.isView(incoming)) {
      return { ok: false, error: '音频数据必须是原始字节' };
    }

    const buffer = Buffer.isBuffer(incoming)
      ? incoming
      : Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);

    if (buffer.length === 0) return { ok: true, session: this.sessionView(session) };

    if (session.bytes + buffer.length > MAX_RECORDING_BYTES) {
      session.failure = '导入文件超过安全上限（约 8 GB），请分段处理。';
      return { ok: false, error: session.failure };
    }

    const flushed = session.stream.write(buffer);
    session.bytes += buffer.length;

    return {
      ok: true,
      backpressure: !flushed,
      session: this.sessionView(session),
    };
  }

  async finalizeImport(payload) {
    const session = this.sessions.get(payload?.sessionId);
    if (!session) return { ok: false, error: '导入会话不存在' };
    if (!session.imported) return { ok: false, error: '这场会议不是导入会话' };

    await this.closeSessionStream(session);
    session.closed = true;
    session.endedAt = nowIso();

    if (session.failure) return { ok: false, error: session.failure };
    if (!session.bytes) return { ok: false, error: '没有收到任何音频数据' };

    const outcome = await this.runPython(
      [
        '-m',
        'speech_engine',
        'normalize',
        '--audio',
        session.originalPath,
        '--out',
        session.wavPath,
      ],
      { timeoutMs: 600000 },
    );

    if (outcome.code !== 0) {
      const errEvent = [...(outcome.events ?? [])].reverse().find((event) => event.type === 'error');
      const detail =
        errEvent?.message ||
        (outcome.stderr ?? '').trim().split('\n').slice(-8).join('\n') ||
        `退出码 ${outcome.code}`;
      session.failure = `导入转码失败：${detail}`;
      await this.writeMeta(session, {
        phase: 'import_failed',
        source: 'import',
        originalName: session.originalName,
      });
      return { ok: false, error: session.failure };
    }

    const done = (outcome.events ?? []).find((event) => event.type === 'normalize' && event.ok);
    const seconds = Number(done?.audioSeconds);
    if (!(seconds > 0.5)) {
      return { ok: false, error: '转码后时长异常，无法转写' };
    }

    session.seconds = Number(seconds.toFixed(3));
    session.sampleRate = SAMPLE_RATE;

    // 用规范化后的 WAV 大小作为 bytes，便于首页显示
    try {
      session.bytes = (await stat(session.wavPath)).size;
    } catch {
      /* 保留上传字节数 */
    }

    await this.writeMeta(session, {
      phase: 'recorded',
      source: 'import',
      originalName: session.originalName,
      encoding: 'pcm_s16le',
    });

    return { ok: true, session: this.sessionView(session) };
  }

  async cancelImport(payload) {
    return this.cancelRecording(payload);
  }


  // ---------------------------------------------------------------- 重点标记

  /**
   * 内容时间（秒）：由已落盘字节数换算，而不是看时钟。
   *
   * 这是整个标记功能的时间基准。暂停期间剪掉的空档不进音频，所以墙上时钟
   * 与音频时长会越差越多；而按字节换算得到的是音频内容时间，与 WAV、
   * 与转写时间戳同一个基准 —— 标记因此能精确落在它要指的那句话上。
   */
  contentSeconds(session) {
    return session.bytes / BYTES_PER_SAMPLE / session.sampleRate;
  }

  /**
   * 加一个重点标记。
   *
   * 两种来源，时间点的取法不同：
   *   - 录音过程中点「标记」：不传 atSeconds，由 Host 按已落盘字节换算，
   *     不采信客户端报的时钟；
   *   - 校对页在某个播放位置标记：客户端传 atSeconds，这里按会话时长夹紧。
   */
  async addMark(payload) {
    const { sessionId, note = '', label = '', atSeconds: requested = null } = payload ?? {};
    const session = this.sessions.get(sessionId);

    if (!session) return { ok: false, error: '录音会话不存在' };

    const content = this.contentSeconds(session);
    const ceiling = session.closed ? (session.seconds ?? content) : content;

    const atSeconds = Number.isFinite(requested)
      ? Math.min(Math.max(Number(requested), 0), ceiling)
      : content;

    const mark = {
      id: nextId('mark_'),
      atSeconds: Number(atSeconds.toFixed(3)),
      label: String(label).slice(0, 60),
      note: String(note).slice(0, 500),
      createdAt: nowIso(),
    };

    session.marks = [...(session.marks ?? []), mark];
    await this.writeMeta(session, { phase: session.closed ? 'recorded' : 'recording' });

    return { ok: true, mark, session: this.sessionView(session) };
  }

  /** 改标记的备注或标签。 */
  async updateMark(payload) {
    const { sessionId, markId, note, label } = payload ?? {};
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: '录音会话不存在' };

    const marks = session.marks ?? [];
    const index = marks.findIndex((mark) => mark.id === markId);
    if (index < 0) return { ok: false, error: '标记不存在' };

    const next = { ...marks[index] };
    if (typeof note === 'string') next.note = note.slice(0, 500);
    if (typeof label === 'string') next.label = label.slice(0, 60);

    session.marks = [...marks.slice(0, index), next, ...marks.slice(index + 1)];
    await this.writeMeta(session, { phase: session.closed ? 'recorded' : 'recording' });

    return { ok: true, mark: next, session: this.sessionView(session) };
  }

  async removeMark(payload) {
    const { sessionId, markId } = payload ?? {};
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: '录音会话不存在' };

    const marks = session.marks ?? [];
    const remaining = marks.filter((mark) => mark.id !== markId);
    if (remaining.length === marks.length) return { ok: false, error: '标记不存在' };

    session.marks = remaining;
    await this.writeMeta(session, { phase: session.closed ? 'recorded' : 'recording' });

    return { ok: true, session: this.sessionView(session) };
  }

  async closeSessionStream(session) {
    if (!session?.stream || session.stream.closed) return;

    await new Promise((resolveClose) => {
      session.stream.end(() => resolveClose());
    });
  }

  /**
   * 把纯 PCM 转成合法的 WAV：写入 44 字节头，再把 PCM 追加进去。
   * 分段拼接而不是整段读入内存——1 小时录音的 PCM 有 230 MB。
   */
  async writeWavHeaderAndConcat(session) {
    const dataBytes = session.bytes;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt 块长度
    header.writeUInt16LE(3, 20); // 3 = IEEE float
    header.writeUInt16LE(1, 22); // 单声道
    header.writeUInt32LE(session.sampleRate, 24);
    header.writeUInt32LE(session.sampleRate * BYTES_PER_SAMPLE, 28); // 字节率
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // 块对齐
    header.writeUInt16LE(32, 34); // 位深
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);

    try {
      const output = createWriteStream(session.wavPath, { flags: 'w' });
      await new Promise((resolveWrite, rejectWrite) => {
        output.on('error', rejectWrite);
        output.write(header);

        const input = createReadStream(session.pcmPath, { highWaterMark: 1 << 20 });
        input.on('error', rejectWrite);
        input.on('data', (chunk) => output.write(chunk));
        input.on('end', () => output.end(resolveWrite));
      });
    } catch (error) {
      return { ok: false, error: `生成 WAV 文件失败：${error.message}` };
    }

    try {
      await rm(session.pcmPath, { force: true });
    } catch {
      /* 原始 PCM 删不掉也不影响结果 */
    }

    return { ok: true };
  }

  sessionView(session) {
    const imported = Boolean(session.imported);
    return {
      id: session.id,
      title: session.title,
      folder: session.folder,
      folderName: session.folderName,
      bytes: session.bytes,
      seconds: session.seconds
        ?? (imported
          ? null
          : Number((session.bytes / BYTES_PER_SAMPLE / session.sampleRate).toFixed(3))),
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      hasWav: Boolean(session.seconds),
      audioUrl: session.seconds ? this.audioUrl(session) : null,
      marks: session.marks ?? [],
      // live 是首页判断"这场会议还在录"的唯一依据：正在录音的会话 hasWav 为 false
      // 但已写入字节数一直大于 0，只看字节会把在录的会议误报成待转写。
      // 导入会话不算 live，避免上传过程中被首页当成麦克风录音。
      live: !session.closed && !imported,
      closed: Boolean(session.closed),
      imported,
      source: imported ? 'import' : (session.source ?? 'record'),
    };
  }

  /** 按 id 取会话；内存里没有就从磁盘上的 meta.json 恢复。 */
  requireSession(sessionId) {
    if (!sessionId) return null;

    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    return null;
  }

  /**
   * 列出所有录音会话：内存中的活动会话 + 磁盘上历史会话。
   *
   * 为什么要读磁盘：页面刷新会丢掉 Client 侧状态，但录音文件还在。
   * 只靠内存表的话，用户刷新一次就再也找不到刚录的东西了。
   */
  async listSessions() {
    const found = new Map();

    for (const session of this.sessions.values()) {
      found.set(session.id, session);
    }

    let entries = [];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [...found.values()].map((session) => this.sessionView(session));
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folder = join(this.root, entry.name);
      let meta;
      try {
        meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
      } catch {
        continue; // 没有 meta.json 的目录不是我们的会话
      }

      if (!meta?.id || found.has(meta.id)) continue;

      const wavPath = join(folder, '录音.wav');
      const pcmPath = join(folder, '录音.pcm.raw');
      const hasWav = await stat(wavPath).then((info) => info.isFile()).catch(() => false);
      const hasPcm = await stat(pcmPath).then((info) => info.isFile()).catch(() => false);

      if (!hasWav && !hasPcm) continue;

      const restored = {
        id: meta.id,
        folder,
        folderName: meta.folderName ?? entry.name,
        wavPath,
        pcmPath,
        stream: null,
        title: meta.title ?? '',
        sampleRate: meta.sampleRate ?? SAMPLE_RATE,
        bytes: Number(meta.bytes ?? 0),
        // WAV 已存在时用 WAV 的实际大小重算时长，比 meta 里的旧值可靠
        seconds: hasWav
          ? Number(((await stat(wavPath).then((info) => info.size).catch(() => 0) - 44) /
              BYTES_PER_SAMPLE /
              SAMPLE_RATE).toFixed(3))
          : (meta.seconds ?? null),
        startedAt: meta.startedAt ?? null,
        endedAt: meta.endedAt ?? null,
        closed: true,
        failure: null,
        rehydrated: true,
        hasWav,
        marks: Array.isArray(meta.marks) ? meta.marks : [],
      };

      // 恢复出来的会话放进内存表：首页点开某场会议时必须拿到同一个对象，
      // 否则后续编辑（改标记、改说话人姓名）会落在互相看不见的游离副本上。
      this.sessions.set(restored.id, restored);
      found.set(restored.id, restored);
    }

    // 逐场补齐清单信息（有没有转写、几段、几个人、有哪些文件）。
    // 串行做是有意的：文件不多，而并发几百次 stat/readdir 对首页打开速度没帮助。
    const list = [];
    for (const session of found.values()) {
      list.push({
        ...this.sessionView(session),
        hasWav: session.hasWav ?? Boolean(session.seconds),
        ...(await this.describeSession(session)),
      });
    }

    // 新的排在前面
    return list.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')));
  }

  /**
   * 按 id 取会话，必要时从磁盘恢复。
   *
   * 借 listSessions 扫一遍磁盘（它会把恢复出来的会话登记进内存表），
   * 这样磁盘恢复逻辑只有一份，不会两处走样。
   */
  async loadSession(sessionId) {
    if (!sessionId) return null;

    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    await this.listSessions();
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * 首页列清单需要的补充事实：有没有转写结果、几段、几个人、目录里有哪些文件。
   *
   * 特意不放进 sessionView：那个方法是同步的、被多处调用，不该做磁盘 I/O。
   * 这里的文件清单只 stat 不读内容——一场会议的录音可能几十 MB，绝不能读进来。
   */
  async describeSession(session) {
    // 有修订就用修订：界面上的改动（说话人姓名、改过的文字）以它为准
    const revision = await readJsonFile(join(session.folder, '修订.json'));
    const transcript = revision ?? (await readJsonFile(join(session.folder, '转写结果.json')));

    const files = [];

    const collect = async (path, name, note, deliverable = false) => {
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ name, path, bytes: info.size, note, deliverable });
    };

    await collect(session.wavPath, '录音.wav', '录音原件');
    await collect(join(session.folder, '转写结果.json'), '转写结果.json', '引擎原始输出');
    await collect(join(session.folder, '修订.json'), '修订.json', '界面上的修订');

    // 会议文件夹根目录里的正式交付件（含「会议名_会议纪要_时间」）
    try {
      for (const entry of await readdir(session.folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (name === '录音.wav' || name === '转写结果.json' || name === '修订.json' || name === 'meta.json') {
          continue;
        }
        const isMinutes = /会议纪要/u.test(name) && /\.(md|docx)$/i.test(name);
        const isDeliverableDoc =
          /\.(docx|md|wav|txt|srt)$/i.test(name) &&
          (isMinutes || /讲话文字稿|要点提纲|会议发言/u.test(name));
        if (!isMinutes && !isDeliverableDoc) continue;
        await collect(
          join(session.folder, name),
          name,
          isMinutes ? '会议纪要' : '会议文件夹内交付件',
          true,
        );
      }
    } catch {
      /* 目录异常时跳过 */
    }

    // 交付物目录：中间产物与备份
    const staging = join(session.folder, '交付物');
    try {
      for (const entry of await readdir(staging, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        await collect(join(staging, entry.name), entry.name, '交付物', true);
      }
    } catch {
      /* 还没生成过交付物 */
    }

    return {
      hasTranscript: Boolean(transcript),
      edited: Boolean(revision),
      segmentCount: transcript?.segments?.length ?? 0,
      speakerCount: transcript?.speakers?.length ?? 0,
      audioSeconds: transcript?.audioSeconds ?? session.seconds ?? null,
      markCount: (session.marks ?? []).length,
      hasDeliverables: files.some((file) => file.deliverable),
      files,
    };
  }

  /**
   * 在资源管理器里定位到会议目录。
   *
   * 唯一会启动外部进程的操作，且只由用户点击触发。detached + unref：不等它、
   * 也不接管它的生命周期。（explorer.exe 成功时也可能返回退出码 1，
   * 所以这里只判断是否抛异常，不看退出码。）
   */
  reveal(payload) {
    const session = this.sessions.get(payload?.sessionId);
    if (!session) return { ok: false, error: '找不到这场会议' };

    const staging = join(session.folder, '交付物');
    const path = existsSync(staging) ? staging : session.folder;

    try {
      const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      return { ok: false, error: `打开文件夹失败：${error.message}` };
    }

    return { ok: true, path };
  }

  /**
   * 把一场会议移出清单。
   *
   * 不做物理删除，而是改名移进根目录下的「已删除」文件夹：同盘改名是原子的、
   * 瞬间完成，用户还能自己去把文件找回来。对真实会议录音来说"误删就没了"的
   * 代价太大，而调用回收站要么慢、要么依赖外部进程。
   * （「已删除」目录不会被 listSessions 当成会议——它下面没有 meta.json。）
   */
  async remove(payload) {
    const { sessionId } = payload ?? {};
    const session = this.sessions.get(sessionId);

    if (!session) return { ok: false, error: '找不到这场会议' };
    if (!session.closed) return { ok: false, error: '这场会议正在录音，不能删除' };

    const trash = join(this.root, '已删除');
    const target = join(trash, sanitizeSegment(`${folderStamp()}_${session.folderName}`));

    try {
      await mkdir(trash, { recursive: true });
      await rename(session.folder, target);
    } catch (error) {
      return { ok: false, error: `移出清单失败：${error.message}` };
    }

    this.sessions.delete(sessionId);

    // 任务表也一并清掉：会话没了，任务的 sessionId 就成了悬空引用。
    // 反向通知而不是让调用方记得做——这个不变量只在一个地方维护才不会漏。
    this.jobs?.forget?.(sessionId);

    return { ok: true, removed: sessionId, movedTo: target };
  }

  async writeMeta(session, extra) {
    const meta = {
      id: session.id,
      title: session.title,
      folderName: session.folderName,
      sampleRate: session.sampleRate,
      channels: CHANNELS,
      encoding: 'float32',
      bytes: session.bytes,
      seconds: session.seconds ?? null,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      // 标记必须落盘：页面刷新会丢掉 Client 侧状态，标记不该跟着丢
      marks: session.marks ?? [],
      ...extra,
      updatedAt: nowIso(),
    };

    try {
      await writeFile(join(session.folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      /* 元信息写失败不阻断录音 */
    }
  }

  // ---------------------------------------------------------------- 音频路由

  /**
   * 音频 URL 用会话 id 做标识，而不是文件路径。
   *
   * 早先的版本把文件路径 base64 后当 token，那等于开了一个任意文件读取接口：
   * 任何本机进程都能自己编一个 token 去读磁盘上任何文件。
   * 改成按会话 id 查表 + 路径边界双重校验。
   */
  audioUrl(session) {
    return `${MEDIA_PATH}?sessionId=${encodeURIComponent(session.id)}`;
  }

  /**
   * 取音频文件的可回放表示。
   *
   * 返回纯数据描述（状态码 / 响应头 / 字节流），不碰 node:http 的 req-res 对象：
   * 调用方是 Connection 的 fetch 路由，那一层只认 WHATWG Request / Response。
   * 解耦的额外好处是这个方法能被单测直接调用，不需要伪造一个 res。
   *
   * Range 支持是必需的：长录音没有 Range，<audio> 就无法拖动定位。
   */
  async openAudio(sessionId, { method = 'GET', range = null } = {}) {
    // 用 loadSession：历史会议的会话不在内存表里（进程重启过或刚打开首页），
    // 用 requireSession 会让旧录音一律放不出来、进度条也拖不动。
    const session = await this.loadSession(sessionId);
    if (!session) return { status: 404, headers: {}, body: null, error: '录音会话不存在' };

    // 双重保险：即使会话记录被污染，也不允许读到根目录之外
    const hostPath = resolve(session.wavPath);
    if (!isInside(this.root, hostPath)) {
      return { status: 403, headers: {}, body: null, error: '拒绝访问输出目录以外的文件' };
    }

    const info = await stat(hostPath).catch(() => null);
    if (!info || !info.isFile()) {
      return { status: 404, headers: {}, body: null, error: '音频文件不存在' };
    }

    const contentType =
      extname(hostPath).toLowerCase() === '.wav' ? 'audio/wav' : 'application/octet-stream';
    const base = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    // HEAD 只回响应头：桥接层看到 body 为 null 就直接收尾，不会真去读文件
    const headOnly = method === 'HEAD';
    const parsed = parseByteRange(range, info.size);

    if (parsed === null) {
      return {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` },
        body: null,
        error: 'Range 头不合法',
      };
    }

    if (parsed === undefined) {
      return {
        status: 200,
        headers: { ...base, 'Content-Length': String(info.size) },
        body: headOnly
          ? null
          : Readable.toWeb(createReadStream(hostPath, { highWaterMark: 1 << 20 })),
      };
    }

    const { start, end } = parsed;
    return {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': String(end - start + 1),
      },
      body: headOnly ? null : Readable.toWeb(createReadStream(hostPath, { start, end })),
    };
  }

  // ---------------------------------------------------------------- 引擎

  /** 当前插件实际会用的引擎位置，以及能不能在界面里安全地跑捆绑 setup。 */
  engineSnapshot() {
    const python = this.pythonExecutable();
    const bundled = resolve(this.engineRoot) === BUNDLED_ENGINE_ROOT;
    const setupScript = join(
      PLUGIN_ROOT,
      'scripts',
      process.platform === 'win32' ? 'setup.ps1' : 'setup.sh',
    );

    return {
      pluginRoot: PLUGIN_ROOT,
      engineRoot: this.engineRoot,
      pythonPath: python,
      pythonReady: existsSync(python),
      modelCacheDir: this.modelCacheDir,
      modelCacheExists: existsSync(this.modelCacheDir),
      bundled,
      setupScript,
      setupScriptReady: existsSync(setupScript),
      canSetupHere: bundled && existsSync(setupScript),
    };
  }

  setupStatus() {
    return this.engineSetup.snapshot();
  }

  startEngineSetup(options = {}) {
    return this.engineSetup.start({
      engineRoot: this.engineRoot,
      downloadModels: options?.downloadModels === true,
      force: options?.force === true,
    });
  }

  cancelEngineSetup() {
    return this.engineSetup.cancel();
  }

  /** 引擎虚拟环境里的 Python 解释器路径（Windows / POSIX）。 */
  pythonExecutable() {
    if (this.pythonPath) return this.pythonPath;
    if (process.platform === 'win32') {
      return join(this.engineRoot, '.venv', 'Scripts', 'python.exe');
    }
    return join(this.engineRoot, '.venv', 'bin', 'python');
  }

  async engineSelfCheck() {
    const python = this.pythonExecutable();
    const exists = await stat(python).then((info) => info.isFile()).catch(() => false);

    if (!exists) {
      return {
        ok: false,
        python,
        error:
          `找不到语音引擎的 Python 解释器：${python}。` +
          `请在插件里点「只安装依赖」，或在插件目录 ${PLUGIN_ROOT} 运行 scripts/setup。不要在另一份克隆里安装后指望这里能看到。`,
      };
    }

    const result = await this.runPython(['-m', 'speech_engine', 'selfcheck'], { timeoutMs: 120000 });
    const record = result.events.find((event) => event.type === 'selfcheck');

    return {
      ok: Boolean(record?.ok),
      python,
      checks: record?.checks ?? [],
      error: record ? null : result.stderr.slice(-1200) || '引擎自检未返回结果',
    };
  }

  /** 运行引擎命令，把 stdout 的 JSON Lines 收集成事件数组。 */
  runPython(args, { timeoutMs = 0, onEvent = null, signal = null } = {}) {
    return new Promise((resolveRun) => {
      const child = spawn(this.pythonExecutable(), args, {
        cwd: this.engineRoot,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          ...(this.modelCacheDir ? { MODELSCOPE_CACHE: this.modelCacheDir } : {}),
        },
      });

      const events = [];
      const stderrChunks = [];
      let settled = false;
      let timer = null;

      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });

      reader.on('line', (line) => {
        const text = line.trim();
        if (!text) return;

        try {
          const event = JSON.parse(text);
          events.push(event);
          if (onEvent) onEvent(event);
        } catch {
          // 引擎不该往 stdout 写非 JSON，但真出现了也不能让整个任务崩掉
          stderrChunks.push(`[stdout 非 JSON] ${text.slice(0, 300)}\n`);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk.toString('utf8'));
        if (stderrChunks.length > 200) stderrChunks.splice(0, 100);
      });

      const finish = (code, spawnError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolveRun({ code, events, stderr: stderrChunks.join(''), spawnError: spawnError ?? null });
      };

      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        finish(null);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
          finish(null);
        }, timeoutMs);
      }

      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  }
}
