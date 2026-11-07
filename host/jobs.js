/**
 * 转写任务管理。
 *
 * 关键约束：转写是分钟到小时级的任务，而一次 HTTP 请求只能给一次响应。
 * 所以设计成「启动即返回 + 轮询取进度」：start 立刻返回 jobId，
 * 界面每 1.5 秒取一次进度。这样界面能实时显示阶段、百分比、预计剩余时间，
 * 且浏览器标签页关闭后转写进程仍继续跑完。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 读 JSON，读不到或内容坏了都返回 null（列清单时会大量试探文件是否存在）。 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 同时只允许一个转写任务：本机 4 核、15.8 GB 内存，
 * 并发会同时加载多份模型（主模型 + 标点 + 声纹），有把内存吃爆的实际风险。
 */
const MAX_CONCURRENT_JOBS = 1;

/** 已完成任务只在内存里保留最近这么多条，避免插件长时间运行后内存持续增长。 */
const MAX_JOBS_IN_MEMORY = 10;

export class TranscriptionJobs {
  constructor(recorder) {
    this.recorder = recorder;
    /** jobId → job */
    this.jobs = new Map();
    /** sessionId → jobId，保证一次录音只有一个活跃任务 */
    this.bySession = new Map();
  }

  list() {
    return [...this.jobs.values()]
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      .map((job) => this.view(job, { includeSegments: false }));
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? this.view(job, { includeSegments: true }) : null;
  }

  activeCount() {
    return [...this.jobs.values()].filter((job) => job.status === 'running').length;
  }

  view(job, { includeSegments }) {
    const view = {
      id: job.id,
      sessionId: job.sessionId,
      status: job.status,
      stage: job.stage,
      progress: Number(Number(job.progress ?? 0).toFixed(4)),
      message: job.message,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      error: job.error,
      audioSeconds: job.audioSeconds ?? null,
      inferenceSeconds: job.inferenceSeconds ?? null,
      realTimeFactor: job.realTimeFactor ?? null,
      speakers: job.speakers ?? [],
      speakerNames: job.speakerNames ?? {},
      diagnostics: job.diagnostics ?? null,
      segmentCount: job.segments?.length ?? 0,
      title: job.title ?? '',
      folder: job.folder ?? '',
      audioUrl: job.audioUrl ?? null,
      marks: this.marksOf(job),
    };

    if (includeSegments) {
      view.segments = job.segments ?? [];
    }

    return view;
  }

  /**
   * 任务的标记列表。
   *
   * 标记的真源在会话上（落盘到 meta.json），不放在任务对象里：任务是内存态，
   * 进程重启就没了，而用户标的重点必须活得比进程久。这里每次读视图时取一份。
   */
  marksOf(job) {
    return this.recorder.requireSession(job.sessionId)?.marks ?? [];
  }

  /**
   * 标记操作：统一从 jobId 解析出会话，再交给 recorder。
   * 返回里带上刷新后的 job 视图，前端一次调用就能拿到新状态。
   */
  async addMark(payload) {
    const job = this.jobs.get(payload?.jobId);
    if (!job) return { ok: false, error: '任务不存在' };

    const result = await this.recorder.addMark({ ...payload, sessionId: job.sessionId });
    if (!result.ok) return result;

    return { ok: true, mark: result.mark, job: this.view(job, { includeSegments: true }) };
  }

  async updateMark(payload) {
    const job = this.jobs.get(payload?.jobId);
    if (!job) return { ok: false, error: '任务不存在' };

    const result = await this.recorder.updateMark({ ...payload, sessionId: job.sessionId });
    if (!result.ok) return result;

    return { ok: true, mark: result.mark, job: this.view(job, { includeSegments: true }) };
  }

  async removeMark(payload) {
    const job = this.jobs.get(payload?.jobId);
    if (!job) return { ok: false, error: '任务不存在' };

    const result = await this.recorder.removeMark({ ...payload, sessionId: job.sessionId });
    if (!result.ok) return result;

    return { ok: true, job: this.view(job, { includeSegments: true }) };
  }

  /** 启动转写。返回 jobId 供界面轮询。 */
  async start(payload) {
    const { sessionId, speakerHint = null, diarization = true } = payload ?? {};

    // 用 loadSession 而不是 requireSession：后者只查内存表，重启之后
    // 历史会议的会话不在内存里，会导致"重新转写一场旧会议"直接失败。
    const session = await this.recorder.loadSession(sessionId);
    if (!session) {
      return { ok: false, error: '找不到对应的录音，请先完成一次录音' };
    }

    if (!session.seconds) {
      return { ok: false, error: '录音尚未收尾，无法转写' };
    }

    const previousId = this.bySession.get(sessionId);
    if (previousId) {
      const previous = this.jobs.get(previousId);
      if (previous && previous.status === 'running') {
        return { ok: false, error: '这次录音已经有转写任务在运行', jobId: previous.id };
      }
    }

    if (this.activeCount() >= MAX_CONCURRENT_JOBS) {
      return {
        ok: false,
        error:
          '已有转写任务正在运行。本机内存有限，同时运行多个任务会因模型重复加载而失败，' +
          '请等当前任务完成。',
      };
    }

    const id = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

    const job = {
      id,
      sessionId,
      status: 'running',
      stage: 'starting',
      progress: 0,
      message: '正在启动语音引擎…',
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      title: session.title,
      folder: session.folder,
      audioUrl: this.recorder.audioUrl(session),
      speakerNames: {},
      speakers: [],
      segments: [],
      audioSeconds: null,
      inferenceSeconds: null,
      realTimeFactor: null,
      diagnostics: null,
      error: null,
      abort: new AbortController(),
    };

    this.jobs.set(id, job);
    this.bySession.set(sessionId, id);

    // 立刻返回，转写在后台继续
    void this.run(job, session, { speakerHint, diarization });
    this.prune();

    return { ok: true, jobId: id };
  }

  async run(job, session, options) {
    const resultPath = join(session.folder, '转写结果.json');

    const args = ['-m', 'speech_engine', 'transcribe', '--audio', session.wavPath, '--out', resultPath];

    if (!options.diarization) args.push('--no-diarization');
    if (Number.isInteger(options.speakerHint) && options.speakerHint > 0) {
      args.push('--speakers', String(options.speakerHint));
    }
    if (this.recorder.modelCacheDir) {
      args.push('--model-cache', this.recorder.modelCacheDir);
    }

    let reportedFailure = null;

    const onEvent = (payload) => {
      if (payload.type === 'progress') {
        job.stage = payload.stage ?? job.stage;
        job.progress = Math.max(job.progress, Number(payload.ratio ?? job.progress));
        job.message = payload.message ?? job.message;
        return;
      }

      if (payload.type === 'error') {
        reportedFailure = payload.message ?? '引擎报告未知错误';
        job.message = reportedFailure;
        return;
      }

      if (payload.type === 'result') {
        job.audioSeconds = payload.audioSeconds ?? null;
        job.inferenceSeconds = payload.inferenceSeconds ?? null;
        job.realTimeFactor = payload.realTimeFactor ?? null;
        job.speakers = payload.speakers ?? [];
        job.diagnostics = payload.diagnostics ?? null;
      }
    };

    const outcome = await this.recorder.runPython(args, { onEvent, signal: job.abort.signal });

    job.finishedAt = new Date().toISOString();

    if (job.status === 'cancelled') return;

    if (outcome.spawnError) {
      job.status = 'failed';
      job.error = `无法启动语音引擎：${outcome.spawnError.message}`;
      return;
    }

    if (outcome.code !== 0 || reportedFailure) {
      job.status = 'failed';
      job.error = reportedFailure ?? this.explainFailure(outcome);
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      job.status = 'failed';
      job.error = `转写完成但读取结果失败：${error.message}`;
      return;
    }

    job.segments = (parsed.segments ?? []).map((segment, index) => ({
      index,
      start: segment.start,
      end: segment.end,
      text: segment.text ?? '',
      speaker: segment.speaker ?? '说话人1',
      confidence: segment.confidence ?? null,
    }));

    job.speakers = this.orderSpeakers(job.segments);
    job.audioSeconds = parsed.audioSeconds ?? job.audioSeconds;
    job.inferenceSeconds = parsed.inferenceSeconds ?? job.inferenceSeconds;
    job.realTimeFactor = parsed.realTimeFactor ?? job.realTimeFactor;
    job.diagnostics = parsed.diagnostics ?? job.diagnostics;
    job.stage = 'done';
    job.progress = 1;
    job.status = 'ready';
    job.message = `转写完成，共 ${job.segments.length} 段、${job.speakers.length} 位说话人`;

    // 立刻落盘一份修订快照：这样"重新打开历史会议"总是走同一条路径，
    // 不需要判断该信引擎原始输出还是信界面修订
    void this.persistRevision(job);
  }

  explainFailure(outcome) {
    const stderr = (outcome.stderr ?? '').trim();
    const tail = stderr.split('\n').slice(-12).join('\n');

    return (
      `语音引擎退出码 ${outcome.code}。` +
      (tail ? `\n引擎输出：\n${tail}` : '引擎没有输出错误信息，请检查依赖是否完整。')
    );
  }

  /** 更新段落：改文字、改归属人。界面上的每一次纠正都走这里。 */
  updateSegments(payload) {
    const { jobId, updates } = payload ?? {};
    const job = this.jobs.get(jobId);

    if (!job) return { ok: false, error: '任务不存在' };
    if (job.status !== 'ready') return { ok: false, error: '任务尚未完成转写，无法修改' };

    let changed = 0;

    for (const update of updates ?? []) {
      const segment = job.segments[update.index];
      if (!segment) continue;

      if (typeof update.text === 'string' && update.text !== segment.text) {
        segment.text = update.text;
        changed += 1;
      }

      if (typeof update.speaker === 'string' && update.speaker !== segment.speaker) {
        segment.speaker = update.speaker;
        changed += 1;
      }
    }

    if (changed > 0) {
      job.speakers = this.orderSpeakers(job.segments);
      job.editedAt = new Date().toISOString();
      void this.persistRevision(job);
    }

    return { ok: true, changed, job: this.view(job, { includeSegments: true }) };
  }

  /**
   * 说话人清单按"首次发言顺序"排，不用字符串排序。
   * 字符串排序会把「说话人10」排到「说话人2」前面，在界面上很别扭。
   */
  orderSpeakers(segments) {
    const ordered = [];
    const seen = new Set();

    for (const segment of segments ?? []) {
      const speaker = segment.speaker;
      if (speaker && !seen.has(speaker)) {
        seen.add(speaker);
        ordered.push(speaker);
      }
    }

    return ordered;
  }

  /**
   * 改名 / 合并说话人。
   * mergeFrom 里列出的说话人会被并入 name——这是纠正"同一人被拆成两个"
   * 或"两个人被合成一个"的主要手段。
   */
  renameSpeaker(payload) {
    const { jobId, speaker, name, mergeFrom = [] } = payload ?? {};
    const job = this.jobs.get(jobId);

    if (!job) return { ok: false, error: '任务不存在' };
    if (job.status !== 'ready') return { ok: false, error: '任务尚未完成转写，无法改名' };

    const sources = new Set([speaker, ...(Array.isArray(mergeFrom) ? mergeFrom : [])].filter(Boolean));
    const displayName = String(name ?? '').trim();

    if (!displayName) return { ok: false, error: '姓名不能为空' };

    for (const segment of job.segments) {
      if (sources.has(segment.speaker)) {
        segment.speaker = displayName;
      }
    }

    const names = { ...job.speakerNames };
    for (const source of sources) delete names[source];
    names[displayName] = displayName;
    job.speakerNames = names;

    job.speakers = this.orderSpeakers(job.segments);
    job.editedAt = new Date().toISOString();
    void this.persistRevision(job);

    return { ok: true, job: this.view(job, { includeSegments: true }) };
  }

  /**
   * 把界面上的修订落盘到会话目录的「修订.json」，并保证写入顺序。
   *
   * 为什么要落盘：早先修订只活在内存的 job 对象上，进程一重启就没了——用户
   * 逐段改好的文字和说话人姓名全部作废。历史首页要能重新打开旧会议，
   * 修订就必须活得比进程久。写成"完整快照"而不是增量，重新打开时直接整体
   * 采用，不需要重放历史。
   *
   * 为什么要排队：用户连续改两段时，两次写入会并发；后完成的可能是先发起的，
   * 于是旧内容覆盖新内容。挂在 job.revising 上串行执行，顺序就与操作顺序一致。
   */
  persistRevision(job) {
    job.revising = (job.revising ?? Promise.resolve()).then(() => this.writeRevision(job));
    return job.revising;
  }

  async writeRevision(job) {
    const session = this.recorder.requireSession(job.sessionId);
    if (!session) return;

    const revision = {
      jobId: job.id,
      sessionId: job.sessionId,
      title: job.title ?? '',
      audioSeconds: job.audioSeconds ?? null,
      inferenceSeconds: job.inferenceSeconds ?? null,
      realTimeFactor: job.realTimeFactor ?? null,
      speakers: job.speakers ?? [],
      speakerNames: job.speakerNames ?? {},
      segments: job.segments ?? [],
      editedAt: new Date().toISOString(),
    };

    try {
      await writeFile(join(session.folder, '修订.json'), JSON.stringify(revision, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响当前会话继续编辑 */
    }
  }

  /**
   * 重新打开一场历史会议。
   *
   * 任务表是内存态，进程重启后就空了，所以历史首页的"打开"必须能从磁盘把结果
   * 恢复成一个 ready 任务。优先用「修订.json」——它带用户在界面上改过的说话人
   * 姓名和文字；没有修订才退回引擎的原始输出。
   */
  async reopen(payload) {
    const { sessionId } = payload ?? {};
    const session = await this.recorder.loadSession(sessionId);

    if (!session) return { ok: false, error: '找不到这场会议的录音' };
    if (!session.seconds) return { ok: false, error: '这场会议没有可用的录音文件' };

    // 这个会话上已经开着任务就直接复用，避免一个会话出现两个任务互相覆盖
    const existingId = this.bySession.get(sessionId);
    const existing = existingId ? this.jobs.get(existingId) : null;
    if (existing && (existing.status === 'running' || existing.status === 'ready')) {
      return { ok: true, job: this.view(existing, { includeSegments: true }), reused: true };
    }

    const revision = await readJson(join(session.folder, '修订.json'));
    const original = await readJson(join(session.folder, '转写结果.json'));
    const source = revision ?? original;

    if (!source) {
      return { ok: false, error: '这场会议还没有转写结果', needsTranscribe: true };
    }

    const id = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

    const job = {
      id,
      sessionId,
      status: 'ready',
      stage: 'done',
      progress: 1,
      message: `已载入历史转写结果，共 ${source.segments?.length ?? 0} 段`,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: source.editedAt ?? null,
      title: source.title || session.title,
      folder: session.folder,
      audioUrl: this.recorder.audioUrl(session),
      speakerNames: source.speakerNames ?? {},
      speakers: [],
      segments: (source.segments ?? []).map((segment, index) => ({
        index,
        start: segment.start,
        end: segment.end,
        text: segment.text ?? '',
        speaker: segment.speaker ?? '说话人1',
        confidence: segment.confidence ?? null,
      })),
      audioSeconds: source.audioSeconds ?? session.seconds ?? null,
      inferenceSeconds: source.inferenceSeconds ?? null,
      realTimeFactor: source.realTimeFactor ?? null,
      diagnostics: source.diagnostics ?? null,
      error: null,
      abort: new AbortController(),
      reopened: true,
      editedAt: source.editedAt ?? null,
    };

    job.speakers = this.orderSpeakers(job.segments);

    this.jobs.set(id, job);
    this.bySession.set(sessionId, id);
    this.prune();

    return { ok: true, job: this.view(job, { includeSegments: true }), reopened: true };
  }

  /** 会话被移出清单后，忘掉它对应的任务，避免内存表里留下悬空引用。 */
  forget(sessionId) {
    const jobId = this.bySession.get(sessionId);
    if (!jobId) return;

    this.bySession.delete(sessionId);
    this.jobs.delete(jobId);
  }

  importSegments(payload) {
    const { jobId, segments, replace = true } = payload ?? {};
    const job = this.jobs.get(jobId);

    if (!job) return { ok: false, error: '任务不存在' };

    const list = Array.isArray(segments) ? segments : [];
    job.segments = replace
      ? list.map((segment, index) => ({ index, ...segment }))
      : [
          ...job.segments,
          ...list.map((segment, offset) => ({ index: job.segments.length + offset, ...segment })),
        ];

    job.speakers = this.orderSpeakers(job.segments);
    job.status = 'ready';
    job.stage = 'done';
    job.progress = 1;
    job.message = `已导入 ${list.length} 段文字`;
    void this.persistRevision(job);

    return { ok: true, job: this.view(job, { includeSegments: true }) };
  }

  /** 只保留最近若干条已完成任务，避免插件长期运行后内存持续增长。 */
  prune() {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((left, right) =>
        String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')),
      );

    for (const job of finished.slice(MAX_JOBS_IN_MEMORY)) {
      this.jobs.delete(job.id);
      if (this.bySession.get(job.sessionId) === job.id) {
        this.bySession.delete(job.sessionId);
      }
    }
  }

  /**
   * 取消任务：通过 AbortSignal 终止 Python 子进程。
   * 早先的实现去 kill job.child，但 child 从来没被赋过值，取消实际是空转。
   */
  cancel(payload) {
    const job = this.jobs.get(payload?.jobId);
    if (!job) return { ok: false, error: '任务不存在' };

    if (job.status === 'running') {
      job.status = 'cancelled';
      job.message = '已取消';
      job.finishedAt = new Date().toISOString();

      try {
        job.abort?.abort();
      } catch {
        /* 已经中止过 */
      }
    }

    return { ok: true, job: this.view(job, { includeSegments: true }) };
  }
}
