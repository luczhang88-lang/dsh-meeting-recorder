/**
 * 会议录音插件 · HTTP 接口层（Connection fetch 路由）。
 *
 * 为什么是 connection.fetch，而不是 webServer.register：
 *   最初把接口挂在 webServer 上，结果 POST 永远到不了处理器——实测
 *   webServer 只服务 GET 页面，所有非 GET 在进入路由前就被拒（405），
 *   未匹配的路径由静态兜底返回 404。client→host 的正确通道是 Connection。
 *
 * 依据（读 @deepseek-ai/dsh-client-connection 的 lib/index.js 确认，不是猜的）：
 *   - 路径挂在 webserver 的 /api 下，由 Connection 做 Host/Origin 校验和
 *     浏览器凭据准入，再按 url.pathname 「精确」分发（源码注释原文就是
 *     "Exact Fetch-route registry"），不支持通配；
 *   - requestBody 是每条路由的属性（'streaming' | 'buffered'），
 *     streaming 时 request.body 是 ReadableStream；
 *   - 同一路径重复注册会抛错；处理器只在 principal.kind === 'owner'
 *     的 peer（即已鉴权的浏览器）上被调用；
 *   - 处理器收 WHATWG Request、返 WHATWG Response，响应体可以是流。
 *   参考实现：@deepseek-ai/dsh-client-file-upload（流式上传 + 精确路由）。
 *
 * 安全边界（必须理解）：
 *   这条路由能触发文件写入和 Python 进程，且服务在 loopback 上。
 *   跨站与凭据准入已由 Connection 完成，这里不重复做同源校验；
 *   音频回放按会话 id 查表，并在 recorder.openAudio 内校验解析出的路径
 *   确实落在输出根目录之内。
 *   仍然存在的边界：本机上任何进程本来就有文件系统权限，这条路由不会
 *   把权限放得更大，但也不宣称对本地进程有隔离能力。
 */

import { AUDIO_PATH, IMPORT_PATH, MEDIA_PATH, RPC_PATH } from './paths.js';

/** 单个音频块约 128 KB（2 秒 × 16 kHz × 4 字节）。上限留足余量但不给超大请求机会。 */
const MAX_AUDIO_CHUNK_BYTES = 32 * 1024 * 1024;
/** 单次导入录音文件上限：约 2 GB（长会议压缩音频也够用）。 */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 进程级路由登记表。
 *
 * 为什么需要它：connection.fetch.register 把注册挂在 Connection 服务自己的
 * ctx 上，不随本插件卸载而消失（这是 Connection 的所有权选择）。于是插件
 * 被禁用后重新启用、或 HMR 换了一代模块时，再注册同一路径会抛
 * "exact Fetch route ... is already registered"，而且上一代的处理器会继续
 * 截住请求。用一张挂在 globalThis 上的表把上一代的 disposer 找回来先释放，
 * 让重复装载变成幂等的。
 */
const REGISTRY = Symbol.for('dsh.meeting-recorder.fetch-routes');

function routeRegistry() {
  if (!globalThis[REGISTRY]) globalThis[REGISTRY] = new Map();
  return globalThis[REGISTRY];
}

export class RecorderTransport {
  constructor({ recorder, jobs, deliverables, logger = null }) {
    this.recorder = recorder;
    this.jobs = jobs;
    this.deliverables = deliverables;
    this.logger = logger;
    this.alive = true;

    /** 业务操作表。全部走 RPC_PATH 一条精确路由，用 body.op 区分。 */
    this.ops = {
      status: () => this.status(),
      selfcheck: () => this.recorder.engineSelfCheck(),
      models: () => this.prepareModels(),
      'setup/start': (body) => this.recorder.startEngineSetup(body),
      'setup/status': () => ({ ok: true, setup: this.recorder.setupStatus() }),
      'setup/cancel': () => this.recorder.cancelEngineSetup(),

      'recording/begin': (body) => this.recorder.beginRecording(body),
      'recording/finish': (body) => this.recorder.finalizeRecording(body),
      'recording/cancel': (body) => this.recorder.cancelRecording(body),

      sessions: async () => ({ ok: true, sessions: await this.recorder.listSessions() }),

      // 历史会议：打开（必要时从磁盘恢复）、定位到目录、移出清单
      'job/reopen': (body) => this.jobs.reopen(body),
      'session/reveal': (body) => this.recorder.reveal(body),
      'session/remove': async (body) => {
        const result = await this.recorder.remove(body);
        // 会话没了，就把它的任务也从内存表摘掉，避免留下悬空引用
        if (result?.ok) this.jobs.forget(body?.sessionId);
        return result;
      },

      transcribe: (body) => this.jobs.start(body),
      jobs: () => ({ ok: true, jobs: this.jobs.list() }),
      'job/get': (body) => {
        const job = this.jobs.get(body?.jobId);
        return job ? { ok: true, job } : { ok: false, error: '任务不存在' };
      },
      'job/cancel': (body) => this.jobs.cancel(body),

      'speakers/rename': (body) => this.jobs.renameSpeaker(body),
      segments: (body) => this.jobs.updateSegments(body),

      // 标记：录音过程中前端只有 sessionId，任务建好之后只有 jobId，
      // 所以按传入的 id 分发。两条路最终都落在同一个会话对象上（标记的真源）。
      'mark/add': (body) => (body?.jobId ? this.jobs.addMark(body) : this.recorder.addMark(body)),
      'mark/update': (body) =>
        body?.jobId ? this.jobs.updateMark(body) : this.recorder.updateMark(body),
      'mark/remove': (body) =>
        body?.jobId ? this.jobs.removeMark(body) : this.recorder.removeMark(body),

      deliverables: (body) => this.deliverables.generate(body),
      'minutes-prompt': (body) =>
        this.deliverables.generate({
          ...body,
          formats: { ...(body?.formats ?? {}), minutes: false },
        }),
      'minutes/render': (body) => this.deliverables.renderMinutes(body),

      // AI 写纪要：主路径。author 只负责起任务立刻返回，进度和结果靠
      // author-status 轮询——一次长会议的模型调用要几分钟，不能让一个
      // HTTP 请求一直挂着，那样界面既显示不了进度也取消不了。
      'minutes/author': (body) => this.deliverables.authorMinutes(body),
      'minutes/author-status': (body) => this.deliverables.authorStatus(body),
      'minutes/cancel': (body) => this.deliverables.cancelAuthor(body),
    };

    /**
     * 多条精确路由。每条只能有一个 requestBody 模式，这正是音频上传与
     * 音频回放必须分开的原因：上传要 streaming，回放要浏览器原生 GET。
     */
    this.routes = [
      {
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => this.handleRpc(request),
      },
      {
        path: AUDIO_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => this.handleAudio(request),
      },
      {
        path: MEDIA_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => this.handleMedia(request),
      },
      {
        path: IMPORT_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => this.handleImport(request),
      },
    ];
  }

  /**
   * 把路由挂到 Connection 上，返回统一的释放函数。
   * @param connection - ctx.connection（HostConnectionService）。
   */
  register(connection) {
    const registry = routeRegistry();

    // 先释放上一代同路径的注册，保证插件重新装载 / HMR 换代都幂等
    for (const route of this.routes) {
      const previous = registry.get(route.path);
      if (!previous) continue;
      try {
        previous();
      } catch {
        /* 上一代可能已随 Connection 一起释放 */
      }
      registry.delete(route.path);
    }

    const disposers = this.routes.map((route) => {
      const dispose = connection.fetch.register(route);
      registry.set(route.path, dispose);
      return dispose;
    });

    return () => {
      this.alive = false;
      this.routes.forEach((route, index) => {
        // 只释放自己登记的那一份，别把后来者的注册误删
        if (registry.get(route.path) !== disposers[index]) return;
        try {
          disposers[index]();
        } catch {
          /* 已释放 */
        }
        registry.delete(route.path);
      });
    };
  }

  // ------------------------------------------------------------ 响应工具

  /** 统一的 JSON 响应。no-store：录音状态随时在变，缓存没有意义。 */
  json(payload, status = 200) {
    return new Response(JSON.stringify(payload ?? { ok: true }), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  /** 纯文本响应，只用于协议层面的问题（不是业务失败）。 */
  text(message, status) {
    return new Response(message, {
      status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // ------------------------------------------------------------ 处理器

  async handleRpc(request) {
    if (!this.alive) return this.json({ ok: false, error: '插件已停用' }, 503);

    let body;
    try {
      body = await request.json();
    } catch {
      return this.text('请求体不是合法 JSON', 400);
    }

    const op = typeof body?.op === 'string' ? body.op : '';
    const handler = this.ops[op];

    if (typeof handler !== 'function') {
      return this.json({ ok: false, error: `未知接口：${op}` }, 404);
    }

    try {
      const result = await handler(body);
      return this.json(result);
    } catch (error) {
      this.logger?.error?.(`会议录音插件接口 ${op} 失败：${error?.stack ?? error}`);
      return this.json({ ok: false, error: `处理失败：${error?.message ?? error}` }, 500);
    }
  }

  /**
   * 流式接收 PCM。
   *
   * request.body 是 ReadableStream（本路由声明了 requestBody: 'streaming'）。
   * 逐块交给 recorder 直接追加写盘，不把整段音频读进内存——一小时录音的
   * PCM 有 230 MB，一次性读进来会造成明显的内存尖峰。
   */
  async handleAudio(request) {
    if (!this.alive) return this.json({ ok: false, error: '插件已停用' }, 503);

    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return this.json({ ok: false, error: '缺少 sessionId' }, 400);
    if (request.body === null) return this.json({ ok: false, error: '请求没有音频正文' }, 400);

    const reader = request.body.getReader();
    let received = 0;
    let last = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        received += value.byteLength;
        if (received > MAX_AUDIO_CHUNK_BYTES) {
          return this.json({ ok: false, error: '单个音频块超过上限' }, 413);
        }

        last = await this.recorder.appendChunk({
          sessionId,
          buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        });

        // 会话不存在 / 已收尾 / 已超限：再读下去没有意义，提前停
        if (last?.ok === false) break;
      }
    } catch (error) {
      this.logger?.error?.(`会议录音插件：接收音频失败：${error?.stack ?? error}`);
      return this.json({ ok: false, error: `接收音频失败：${error?.message ?? error}` }, 500);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 流已关闭 */
      }
    }

    if (last?.ok === false) return this.json(last);
    return this.json(last ?? { ok: true, bytes: received });
  }


  /**
   * 流式接收用户导入的音频文件，落盘后转成 16 kHz 单声道 WAV。
   *
   * 与现场录音的 PCM 上传分开：导入是整文件一次 POST，体积可能上百 MB，
   * 上限按整场会议文件计，而不是按「单块 PCM」计。
   */
  async handleImport(request) {
    if (!this.alive) return this.json({ ok: false, error: '插件已停用' }, 503);

    const url = new URL(request.url);
    const title = url.searchParams.get('title') ?? '';
    const filename = url.searchParams.get('filename') ?? '录音.wav';
    if (request.body === null) return this.json({ ok: false, error: '请求没有音频正文' }, 400);

    const begun = await this.recorder.beginImport({ title, filename });
    if (!begun.ok) return this.json(begun, 400);

    const sessionId = begun.session.id;
    const reader = request.body.getReader();
    let received = 0;
    let last = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        received += value.byteLength;
        if (received > MAX_IMPORT_BYTES) {
          await this.recorder.cancelImport({ sessionId });
          return this.json({ ok: false, error: '导入文件超过上限（约 2 GB）' }, 413);
        }

        last = await this.recorder.appendImportChunk({
          sessionId,
          buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        });

        if (last?.ok === false) break;
      }
    } catch (error) {
      this.logger?.error?.(`会议录音插件：导入音频失败：${error?.stack ?? error}`);
      await this.recorder.cancelImport({ sessionId });
      return this.json({ ok: false, error: `导入失败：${error?.message ?? error}` }, 500);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 流已关闭 */
      }
    }

    if (last?.ok === false) {
      await this.recorder.cancelImport({ sessionId });
      return this.json(last);
    }

    if (!received) {
      await this.recorder.cancelImport({ sessionId });
      return this.json({ ok: false, error: '没有收到任何音频数据' }, 400);
    }

    const finished = await this.recorder.finalizeImport({ sessionId });
    if (!finished.ok) return this.json(finished);

    return this.json({
      ok: true,
      session: finished.session,
      bytes: received,
    });
  }


  /** 音频回放：recorder 给纯数据描述，这里翻成 Response（体可以是流）。 */
  async handleMedia(request) {
    if (!this.alive) return this.text('插件已停用', 503);

    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return this.text('缺少 sessionId', 400);

    const audio = await this.recorder.openAudio(sessionId, {
      method: request.method,
      range: request.headers.get('range'),
    });

    if (audio.error) {
      return new Response(audio.error, {
        status: audio.status,
        headers: { ...audio.headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(audio.body, { status: audio.status, headers: audio.headers });
  }

  // ------------------------------------------------------------ 通用操作

  status() {
    return {
      ok: true,
      engineRoot: this.recorder.engineRoot,
      pythonPath: this.recorder.pythonExecutable(),
      modelCacheDir: this.recorder.modelCacheDir,
      meetingsRoot: this.recorder.root,
      defaultOutputDir: this.recorder.defaultOutputDir,
      maxRecordingHours: this.recorder.maxRecordingHours,
      activeJobs: this.jobs.activeCount(),
      engine: this.recorder.engineSnapshot(),
      setup: this.recorder.setupStatus(),
    };
  }

  /** 预下载并加载模型。首次调用很慢（要下载几个 GB），之后走本地缓存。 */
  async prepareModels() {
    const args = ['-m', 'speech_engine', 'models'];
    if (this.recorder.modelCacheDir) args.push('--model-cache', this.recorder.modelCacheDir);

    const outcome = await this.recorder.runPython(args, { timeoutMs: 1800000 });
    const done = outcome.events.find((event) => event.type === 'models');

    return {
      ok: Boolean(done?.ok),
      error: done
        ? null
        : (outcome.stderr ?? '').trim().split('\n').slice(-10).join('\n') || '模型准备失败',
    };
  }
}
