/**
 * 交付物生成：把界面上的最终修订结果写成 Word 文件。
 *
 * 一个重要的分工决定：
 *   正式的《会议纪要》必须由 DSH Agent 按《纪要写法》规范撰写——
 *   机器无法判断"领导强调的核心观点"是什么，硬凑出来就是编造。
 *   所以本模块只做两件事：
 *     1. 生成"讲话文字稿"等纯转录类交付物（这些是机械转换，可以自动）
 *     2. 生成一份**如实的抽取式提纲**（按发言人列出原话，明确标注不是正式纪要），
 *        让你在纪要还没写出来之前有东西可取用
 *   正式纪要的生成走 agentMinutesPrompt()，把材料交给 Agent。
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 把段落按"同一说话人 + 间隔不超过 maxGap 秒"合并成发言块。 */
function buildBlocks(segments, maxGapSeconds = 20, maxSeconds = 180) {
  const blocks = [];

  for (const segment of segments) {
    const text = String(segment.text ?? '').trim();
    if (!text) continue;

    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      const sameSpeaker = last.speaker === segment.speaker;
      const smallGap = Number(segment.start) - last.end <= maxGapSeconds;
      const shortEnough = Number(segment.end) - last.start <= maxSeconds;

      if (sameSpeaker && smallGap && shortEnough) {
        last.text = `${last.text}${joinText(last.text, text)}`;
        last.end = Number(segment.end);
        continue;
      }
    }

    blocks.push({
      speaker: String(segment.speaker ?? '说话人1'),
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text,
    });
  }

  return blocks;
}

function joinText(previous, current) {
  const left = previous.slice(-1);
  const right = current.slice(0, 1);
  const asciiPair = /[0-9A-Za-z]/.test(left) && /[0-9A-Za-z]/.test(right);
  return asciiPair ? ` ${current}` : current;
}

function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
}

function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${secs} 秒`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

/**
 * 抽取式提纲。
 *
 * 这是**抽取**而非**生成**：只把同一位发言人的原话按时序聚成块，
 * 每块前标出发言时间。不做任何摘要、改写、推断，
 * 因此它不会编造领导观点，但也因此读起来比纪要多得多。
 * 这一点必须在文档里写清楚，否则会被当成正式纪要误用。
 */
export function buildOutlineMarkdown(job, meeting) {
  const blocks = buildBlocks(job.segments ?? []);
  if (blocks.length === 0) return '';

  const totals = new Map();
  for (const block of blocks) {
    const entry = totals.get(block.speaker) ?? { seconds: 0, blocks: 0 };
    entry.seconds += block.end - block.start;
    entry.blocks += 1;
    totals.set(block.speaker, entry);
  }
  const speakerSeconds = [...totals.entries()].sort((left, right) => right[1].seconds - left[1].seconds);

  const lines = [];
  lines.push('# 会议发言要点提纲（机器抽取，非正式纪要）');
  lines.push('');
  lines.push('> 本文件由转写文字按发言人原话分块抽取而成，未做任何概括与改写。');
  lines.push('> 它**不是**正式会议纪要。正式纪要需由 DSH Agent 按《纪要写法》规范撰写。');
  lines.push('');

  if (meetingTitle(meeting, job)) {
    lines.push(`会议：${meetingTitle(meeting, job)}`);
  }
  if (meeting?.recordedAt) {
    lines.push(`录音时间：${meeting.recordedAt}`);
  }
  lines.push(`音频时长：${humanDuration(job.audioSeconds)}`);
  lines.push(`发言人数：${speakerSeconds.length} 位`);
  lines.push('');
  lines.push('发言时长分布：');

  const totalSeconds = speakerSeconds.reduce((sum, [, entry]) => sum + entry.seconds, 0) || 1;
  for (const [speaker, entry] of speakerSeconds) {
    lines.push(`- ${speaker}：${humanDuration(entry.seconds)}（占比 ${Math.round((entry.seconds / totalSeconds) * 100)}%，${entry.blocks} 段发言）`);
  }

  lines.push('');
  lines.push('## 发言记录');
  lines.push('');

  let currentSpeaker = null;
  for (const block of blocks) {
    if (block.speaker !== currentSpeaker) {
      currentSpeaker = block.speaker;
      lines.push(`### ${currentSpeaker}`);
      lines.push('');
    }
    lines.push(`【${clock(block.start)} — ${clock(block.end)}】`);
    lines.push(block.text);
    lines.push('');
  }

  if (Array.isArray(meeting?.participants) && meeting.participants.length > 0) {
    lines.push('参会人员：' + meeting.participants.join('、'));
  }

  return lines.join('\n');
}

function meetingTitle(meeting, job) {
  return String(meeting?.title || job?.title || '').trim();
}

/**
 * 把 `session.startedAt` 排成公文里能直接用的日期。
 *
 * 会话里存的是 ISO 串，而单据上要的是「2026年11月6日 09:57」这种写法。
 */
function formatRecordedAt(value) {
  const date = new Date(value ?? NaN);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 会议信息归一化：**录音时间一律以会话记录为准**，不采用界面传来的值。
 *
 * 界面传的是 `new Date()`，也就是"点按钮的那一刻"，不是开会的时间。会议目录
 * 名里的时间戳来自 `session.startedAt`，所以隔天补写纪要时，界面那个值会让
 * 正式文件里的「录音时间」写成一个错的日期，而且还和目录名对不上。会话记录
 * 是这件事的权威来源，跟重点标记的处理原则一样。
 */
function normalizeMeeting(meeting, session) {
  const normalized = meeting && typeof meeting === 'object' ? { ...meeting } : {};
  normalized.recordedAt = formatRecordedAt(session?.startedAt) || normalized.recordedAt || '';
  return normalized;
}

/**
 * 交给 Agent 写纪要的材料。
 *
 * 把规范要求直接写进提示词，而不是让 Agent 去读某个文件——
 * 这样换机器、换路径都不会失效。
 */
/**
 * 取出这场会议的重点标记，换算成引擎和提示词共用的形状。
 *
 * 标记的真源在会话上（落盘于 meta.json），任务对象只是个视图，内部对象上
 * 根本没有 marks 字段。所以统一从会话取一次，再往两个下游分发——
 * 早先两处各自读 job.marks，实际都读到了 undefined，标记等于白标。
 */
export function marksOfSession(session) {
  return (session?.marks ?? []).map((mark) => ({
    at: clock(mark.atSeconds),
    atSeconds: mark.atSeconds,
    label: mark.label ?? '',
    note: mark.note ?? '',
  }));
}

export function buildMinutesRequest(job, meeting, marks = null) {
  /**
   * 写作请求里的转写稿必须「逐段完整」：每一段单独一行、带起止时刻。
   *
   * 早先用 buildBlocks 把同一人连续发言合成一大段，长会议时 Agent/人眼
   * 都容易误以为稿被截断；按时间稿 Word 本来就是逐段的，两边应对齐。
   * 提纲抽取仍走 buildBlocks，这里不改。
   */
  const segments = (job.segments ?? [])
    .map((segment) => ({
      speaker: String(segment.speaker ?? '说话人1'),
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: String(segment.text ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0);

  const body = segments
    .map(
      (segment) =>
        `[${clock(segment.start)} — ${clock(segment.end)}] ${segment.speaker}：${segment.text}`,
    )
    .join('\n');

  const span =
    segments.length > 0
      ? `${clock(segments[0].start)} — ${clock(segments[segments.length - 1].end)}`
      : '（无）';

  const header = [
    `（完整转写：共 ${segments.length} 段，覆盖 ${span}，音频时长 ${humanDuration(job.audioSeconds)}；下方无省略。）`,
    '',
  ].join('\n');

  const transcript = segments.length > 0 ? `${header}${body}` : '（无转写内容）';

  return {
    meetingTitle: meetingTitle(meeting, job),
    recordedAt: meeting?.recordedAt ?? '',
    location: meeting?.location ?? '',
    chair: meeting?.chair ?? '',
    participants: meeting?.participants ?? [],
    speakerHints: meeting?.speakerHints ?? {},
    notes: meeting?.notes ?? '',
    audioSeconds: job.audioSeconds,
    speakerCount: job.speakers?.length ?? 0,
    segmentCount: segments.length,
    // 用户在录音现场标的重点。时间点已经与音频、与转写时间戳同一基准。
    marks: marks ?? [],
    transcript,
  };
}

/**
 * 生成写纪要的提示词。含《纪要写法》全文要点。
 *
 * @param mode 'agent'  —— 交给 DSH Agent，它有文件工具，直接写盘。
 *             'direct' —— 交给插件自己发起的模型调用，它没有工具，
 *                         只能把正文作为回答吐回来。
 */
export function buildMinutesPrompt(job, meeting, paths, marks = null, mode = 'agent') {
  const request = buildMinutesRequest(job, meeting, marks);

  const facts = [
    ['会议名称', request.meetingTitle || '（未提供）'],
    ['录音时间', request.recordedAt || '（未提供）'],
    ['会议地点', request.location || '（未提供）'],
    ['主持人', request.chair || '（未提供，请勿猜测姓名）'],
    ['参会人员', request.participants.length > 0 ? request.participants.join('、') : '（未提供）'],
    ['音频时长', humanDuration(request.audioSeconds)],
    ['识别到的说话人', String(request.speakerCount)],
  ]
    .map(([label, value]) => `- ${label}：${value}`)
    .join('\n');

  const speakerMap = Object.entries(request.speakerHints ?? {})
    .map(([raw, name]) => `- ${raw} → ${name}`)
    .join('\n');

  const markList = request.marks
    .map((mark) => {
      const label = mark.label ? ` ${mark.label}` : '';
      const note = mark.note ? `：${mark.note}` : '';
      return `- [${mark.at}]${label}${note}`;
    })
    .join('\n');

  /**
   * 标记段落。
   *
   * 必须说清"标记只说明这里重要、不构成事实依据"：否则 Agent 可能为了让每个
   * 标记都出现在纪要里而编造内容。标记的价值是引导取舍，不是提供事实。
   */
  const markSection =
    request.marks.length > 0
      ? [
          '## 用户在录音现场标记的重点（应优先体现）',
          '',
          '以下是用户在会议进行中认为重要的时刻，请优先在纪要中体现它们所涉的主题：',
          '',
          markList,
          '',
          '注意：标记只说明"这里重要"，**不构成事实依据**。依据是标记时刻附近的转写',
          '内容；如果该处内容听不清、离题或与其它标记重复，宁可不用，也不要为了让标记',
          '"派上用场"而编造内容。',
          '',
        ].join('\n')
      : '';

  /**
   * 交付要求随调用方式而变。
   *
   * direct 模式必须把三件事写死，否则都会出问题：
   *   1. 不许调工具——那次调用根本没有工具，模型容易自己"假装"存了文件；
   *   2. 不许用代码块围栏——围栏会被原样写进 Word；
   *   3. 不许写前言后语——前言会被当成纪要标题。
   */
  const delivery =
    mode === 'direct'
      ? [
          '直接输出纪要 Markdown 全文，作为你的回答内容。机器会把它转成 Word：',
          '',
          '- 第一行就是纪要标题，接着按上面的规范写完全文。',
          '- **不要**使用代码块围栏（不要出现 ```），不要写 `**加粗**`。',
          '- **不要**调用任何工具，不要尝试保存文件——你没有文件工具。',
          '- 除了纪要正文，不要写任何解释、确认或前后说明。',
        ]
      : [
          `请把写好的纪要 Markdown 正文保存为：\`${paths.agentMinutesPath}\``,
          '文件内容只要纪要正文（含标题行），不要额外说明文字。',
          `如需附一份要点提纲，可另存为：\`${paths.agentOutlinePath}\``,
        ];

  return [
    '# 任务：根据会议录音转写稿撰写正式会议纪要',
    '',
    '## 本次会议的实际信息',
    facts,
    '',
    speakerMap ? `## 说话人对应关系（已在界面上确认）\n${speakerMap}\n` : '',
    request.notes ? `## 用户补充说明\n${request.notes}\n` : '',
    markSection,
    '## 写作规范（严格执行）',
    '',
    '结构用**四条式**，面向高层领导，精炼陈述：',
    '',
    '```',
    '# 20XX年X月XXX会议纪要',
    '20XX年X月XX日[主持人职务+姓名]主持召开了[会议名称]，各相关部门负责人参加会议。现将主要内容纪要如下：',
    '',
    '一、 [主题1]',
    '[核心内容]',
    '',
    '二、 [主题2]',
    '[核心内容]',
    '',
    '三、 [主题3]',
    '[核心内容]',
    '',
    '四、 [主题4]',
    '[核心内容，含考核机制表述]',
    '',
    '参会人员：[按层级排序]',
    '```',
    '',
    '硬性规则：',
    '1. 标题用普通文本格式，**不加粗**（写"一、"而不是"**一、**"）。',
    '2. 每条标题是一个完整动宾短语或主题词，概括该部分核心内容。',
    '3. 定期会议称"例会"，一次性专项议题称"专题会"。',
    '4. 主体用陈述句，不使用"要求""必须"等强硬措辞。语气体现务实推进、以鼓励为主。',
    '5. 关于考核，用"逐步探索"这类表述，不要写具体考核机制。',
    '6. 一句话能说清的不拆两句；去掉解释性语句（如"这意味着""其含义是"）。',
    '7. 不展开过于细节的操作流程，不罗列各部门的细碎任务。',
    '8. 常见主题词参考：明确阶段目标、强化过程管理 / 统筹平台建设、强化统一纳管 /',
    '   强化协同整合、坚持自研驱动 / 落实组织保障、逐步探索考核。',
    '9. 参会人员按层级排序（院领导 → 部门负责人 → 骨干员工）。',
    '10. **没有依据的人名、职务、数字一律不要编造**。信息缺失时保留占位符，',
    '    例如主持人写"（请补充主持人）"，而不是猜一个名字。',
    '',
    '## 转写稿说明',
    '',
    '- 稿件来自本地语音识别，存在同音字、专有名词、人名错误，请结合上下文理解，',
    '  不要把明显的识别错误照抄进纪要。',
    '- 说话人标签来自声纹聚类，可能与实际身份不符；以上面的"说话人对应关系"为准。',
    '- 方括号里是相对录音起点的起止时刻；下面按段完整列出，无截断、无省略。',
    `- 本场共 ${request.segmentCount ?? 0} 段转写，音频时长 ${humanDuration(request.audioSeconds)}。`,
    '',
    '## 转写稿全文',
    '',
    request.transcript,
    '',
    '## 交付要求',
    '',
    ...delivery,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/** 同时保留的写纪要任务数上限，防止长时间运行后任务表无限增长。 */
const MAX_AUTHOR_TASKS = 20;

/**
 * 清理模型返回的正文。
 *
 * 提示词里已经要求它别加围栏、别加前言，但实测模型经常照旧加上，
 * 而围栏和前言会原样进 Word，所以这里再兜一次底。
 */
export function cleanModelMarkdown(text) {
  let body = String(text ?? '').trim();

  // 反复剥到不再变化：模型既可能把前言写在围栏外面，也可能写在围栏里面，
  // 两种顺序都出现过，一次单向处理总会漏掉一种。
  for (let round = 0; round < 3; round += 1) {
    const before = body;
    body = stripFence(body);
    body = stripPreamble(body);
    if (body === before) break;
  }

  return body.trim();
}

/**
 * 去掉整段代码块围栏。
 *
 * 正则开头允许一行前言：模型很爱写"以下是会议纪要："再另起一行开围栏，
 * 早先的 ^``` 锚点在这种情况下直接失配，整块围栏就漏进了 Word。
 */
function stripFence(text) {
  const fenced = text.match(
    /^\s*(?:[^\n]*\n)?\s*```[ \t]*[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/,
  );
  return fenced ? fenced[1].trim() : text;
}

/**
 * 去掉"好的，以下是会议纪要："这一类单行前言。
 *
 * 判据是两条一起看：这一行以冒号结尾（按规范，纪要标题是
 * "<日期><会议名称>纪要"，不会以冒号结尾），而且**下一行确实像标题**
 * （Markdown 标题、含"纪要"、或含四位数年份）。
 *
 * 光看冒号太危险——"根据集团要求形成的会议纪要：正文如下"这种真标题也以
 * 冒号结尾；而只要求"不含纪要二字"又会让最常见的那句"以下是会议纪要："
 * 溜过去（这正是早先漏掉前言的直接原因）。
 */
function stripPreamble(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return text;

  const head = lines[0].trim();
  if (head.startsWith('#') || head.length > 40) return text;
  if (!/[：:]\s*$/.test(head)) return text;

  const next = lines.slice(1).find((line) => line.trim() !== '') ?? '';
  const nextLooksLikeTitle = /^\s*#/.test(next) || /纪要/.test(next) || /\d{4}\s*年/.test(next);
  if (!nextLooksLikeTitle) return text;

  return lines.slice(1).join('\n').trim();
}

/** 目录名/文件名里不能出现的字符。 */
function sanitize(text, fallback) {
  const cleaned = String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : fallback;
}

export class Deliverables {
  constructor(recorder, ctx = null) {
    this.recorder = recorder;
    // 只有装进 Harness 才有 ctx。测试脚本直接 new 出来时传 null，
    // 这时「AI 直接写纪要」会明确报不可用，而不是静默失败。
    this.ctx = ctx;
    this.authors = new Map();
  }

  /** 输出文件夹命名：时间戳 + 会议名称（没填名称就只用时间戳）。 */
  suggestFolderName(payload) {
    const date = payload?.recordedAt ? new Date(payload.recordedAt) : new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `_${pad(date.getHours())}${pad(date.getMinutes())}`;
    const title = sanitize(payload?.title, '');

    return title ? `${stamp}_${title}` : `${stamp}_会议记录`;
  }

  /**
   * 会议纪要文件名（不含扩展名）：会议名称 + 会议纪要 + 时间。
   *
   * 例：测试会议_会议纪要_20261106_0845
   * 没有会议名时退成：会议纪要_20261106_0845
   * 时间取录音开始时刻（与会议文件夹时间戳一致），补写纪要也不会改掉这个名字。
   */
  suggestMinutesBaseName(payload) {
    const date = payload?.recordedAt ? new Date(payload.recordedAt) : new Date();
    const safe = Number.isNaN(date.getTime()) ? new Date() : date;
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
      `${safe.getFullYear()}${pad(safe.getMonth() + 1)}${pad(safe.getDate())}` +
      `_${pad(safe.getHours())}${pad(safe.getMinutes())}`;
    const title = sanitize(payload?.title, '');
    return title ? `${title}_会议纪要_${stamp}` : `会议纪要_${stamp}`;
  }

  /**
   * 生成交付物。
   *
   * 输出目录策略：先写到工作区内的会议目录（一定能写成功），
   * 再复制到用户用原生选择器选定的目录。这样即使目标盘符只读或权限不足，
   * 也不会丢掉已经完成的转写成果。
   */
  async generate(payload) {
    const { jobId, outputDir, formats = {} } = payload ?? {};

    const job = this.recorder.jobs?.get?.(jobId) ?? null;
    if (!job) return { ok: false, error: '转写任务不存在' };
    if (job.status !== 'ready') return { ok: false, error: `任务状态是 ${job.status}，无法生成交付物` };

    // 用 loadSession：历史会议的会话可能不在内存里（进程重启过）
    const session = await this.recorder.loadSession(job.sessionId);
    if (!session) return { ok: false, error: '找不到对应的录音' };

    // 录音时间取会话记录，不取界面传来的那一刻（见 normalizeMeeting）
    const meeting = normalizeMeeting(payload?.meeting, session);

    const folderName = this.suggestFolderName({ title: job.title, recordedAt: session.startedAt });

    // 从会话取一次标记，供纪要点提纲的提示词和 Word 交付物共用
    const marks = marksOfSession(session);
    const staging = join(session.folder, '交付物');
    await mkdir(staging, { recursive: true });

    const want = {
      recording: formats.recording !== false,
      transcript: formats.transcript !== false,
      transcriptBySpeaker: formats.transcriptBySpeaker !== false,
      outline: formats.outline !== false,
      minutes: formats.minutes !== false,
      subtitles: formats.subtitles === true,
      plainText: formats.plainText === true,
    };

    const resultPath = join(session.folder, '转写结果.json');

    let transcribed = null;
    try {
      transcribed = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      return { ok: false, error: `读取转写结果失败：${error.message}` };
    }

    // 用界面上的最终修订覆盖引擎原始结果
    transcribed.segments = (job.segments ?? []).map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      speaker: segment.speaker,
      confidence: segment.confidence,
    }));
    transcribed.speakers = job.speakers ?? [];

    const requestPath = join(staging, '交付请求.json');
    const finalJsonPath = join(staging, '转写数据.json');

    await writeFile(finalJsonPath, JSON.stringify(transcribed, null, 2), 'utf8');

    const outlineMarkdown = want.outline ? buildOutlineMarkdown(job, meeting) : '';
    if (outlineMarkdown) {
      await writeFile(join(staging, '会议发言要点提纲.md'), outlineMarkdown, 'utf8');
    }

    const minutesBase = this.suggestMinutesBaseName({
      title: job.title ?? session.title,
      recordedAt: session.startedAt,
    });
    // 正式约定：会议文件夹根目录；写作请求里也写这个路径
    const agentMinutesPath = join(session.folder, `${minutesBase}.md`);
    const agentOutlinePath = join(session.folder, `${minutesBase}_附表.md`);

    const request = {
      audioPath: session.wavPath,
      recordingPath: session.wavPath,
      transcriptJsonPath: finalJsonPath,
      outputDir: staging,
      baseName: '讲话文字稿',
      folderName,
      meeting,
      want,
      speakerSeconds: transcribed.audioSeconds ?? null,
      // 重点标记：引擎会把它排成按时间稿开头的「重点标记」章节
      marks,
    };

    await writeFile(requestPath, JSON.stringify(request, null, 2), 'utf8');

    const outcome = await this.recorder.runPython(
      ['-m', 'speech_engine.deliverables', '--request', requestPath],
      { timeoutMs: 600000 },
    );

    if (outcome.code !== 0) {
      const detail = (outcome.stderr ?? '').trim().split('\n').slice(-12).join('\n');
      return {
        ok: false,
        error: `生成 Word 交付物失败（退出码 ${outcome.code}）。` +
          (detail ? `\n${detail}` : ''),
      };
    }

    const produced = outcome.events.find((event) => event.type === 'deliverables');
    const files = produced?.files ?? [];

    // 复制到用户选定的目录
    let copiedTo = null;
    let copyError = null;

    if (outputDir && String(outputDir).trim()) {
      try {
        const target = join(String(outputDir), folderName);
        await mkdir(target, { recursive: true });

        for (const file of files) {
          await copyFile(file.path, join(target, file.name));
        }

        if (existsSync(agentMinutesPath)) {
          await copyFile(agentMinutesPath, join(target, `${minutesBase}.md`));
        }
        const minutesDocx = join(session.folder, `${minutesBase}.docx`);
        if (existsSync(minutesDocx)) {
          await copyFile(minutesDocx, join(target, `${minutesBase}.docx`));
        }

        copiedTo = target;
      } catch (error) {
        copyError =
          `交付物已生成在 ${staging}，但复制到 ${outputDir} 失败：${error.message}。` +
          '请确认目标目录可写。';
      }
    }

    const prompt = buildMinutesPrompt(job, meeting, { agentMinutesPath, agentOutlinePath }, marks);
    const promptPath = join(staging, '纪要生成请求.md');
    await writeFile(promptPath, prompt, 'utf8');

    return {
      ok: true,
      stageDir: staging,
      outputDir: copiedTo,
      copyError,
      files: files.map((file) => ({ name: file.name, path: file.path })),
      minutesPromptPath: promptPath,
      agentMinutesPath,
      agentOutlinePath,
      hasAgentMinutes: existsSync(agentMinutesPath),
    };
  }

  /**
   * 让 Agent 把纪要渲染成 Word。
   * Agent 写完 Markdown 后调用这里，只做格式转换，不改内容。
   */
  async renderMinutes(payload) {
    const { jobId, markdownPath, outputDir } = payload ?? {};

    const job = this.recorder.jobs?.get?.(jobId) ?? null;
    if (!job) return { ok: false, error: '转写任务不存在' };

    // 用 loadSession：历史会议的会话可能不在内存里（进程重启过）
    const session = await this.recorder.loadSession(job.sessionId);
    if (!session) return { ok: false, error: '找不到对应的录音' };

    // 纪要落在本场会议文件夹根目录，文件名：会议名称_会议纪要_时间
    const baseName = this.suggestMinutesBaseName({
      title: job.title ?? session.title,
      recordedAt: session.startedAt,
    });
    const meetingMinutesMd = join(session.folder, `${baseName}.md`);
    const meetingMinutesDocx = join(session.folder, `${baseName}.docx`);

    // 兼容旧路径：交付物/会议纪要.md、会议根目录/会议纪要.md
    const candidates = [
      String(markdownPath ?? '').trim(),
      meetingMinutesMd,
      join(session.folder, '会议纪要.md'),
      join(session.folder, '交付物', '会议纪要.md'),
    ].filter(Boolean);

    let source = candidates.find((candidate) => existsSync(candidate)) ?? null;

    if (!source) {
      return {
        ok: false,
        error:
          `还没有找到纪要 Markdown。请先生成纪要，约定保存为：\n${meetingMinutesMd}`,
        needMinutes: true,
        markdownPath: meetingMinutesMd,
      };
    }

    // 若内容还在旧文件名里，复制/规范到新约定文件名（本场会议文件夹内）
    if (source !== meetingMinutesMd) {
      try {
        await mkdir(session.folder, { recursive: true });
        await copyFile(source, meetingMinutesMd);
        source = meetingMinutesMd;
      } catch (error) {
        /* 复制失败就继续用找到的源文件渲染，但仍尽量把 Word 写到会议目录 */
      }
    }

    const staging = join(session.folder, '交付物');
    await mkdir(staging, { recursive: true });
    const requestPath = join(staging, '纪要渲染请求.json');

    const request = {
      mode: 'minutes',
      markdownPath: source,
      outputDir: session.folder,
      fileName: `${baseName}.docx`,
      folderName: this.suggestFolderName({ title: job.title, recordedAt: session.startedAt }),
    };

    await writeFile(requestPath, JSON.stringify(request, null, 2), 'utf8');

    const outcome = await this.recorder.runPython(
      ['-m', 'speech_engine.deliverables', '--request', requestPath],
      { timeoutMs: 120000 },
    );

    if (outcome.code !== 0) {
      const detail = (outcome.stderr ?? '').trim().split('\n').slice(-8).join('\n');
      return { ok: false, error: `渲染纪要失败（退出码 ${outcome.code}）${detail ? `：\n${detail}` : ''}` };
    }

    const produced = outcome.events.find((event) => event.type === 'deliverables');
    let docxPath = produced?.files?.[0]?.path ?? null;

    // 再在会议文件夹内确保一份标准命名（防止引擎写到别处）
    if (docxPath && existsSync(docxPath) && docxPath !== meetingMinutesDocx) {
      try {
        await copyFile(docxPath, meetingMinutesDocx);
        docxPath = meetingMinutesDocx;
      } catch {
        /* 保留引擎产出路径 */
      }
    } else if (docxPath && existsSync(docxPath)) {
      docxPath = meetingMinutesDocx;
    }

    // 可选：复制到用户另选的外部保存目录（仍用同一文件名）
    if (docxPath && outputDir && String(outputDir).trim()) {
      try {
        await copyFile(docxPath, join(String(outputDir), `${baseName}.docx`));
      } catch {
        /* 复制失败时仍返回会议目录路径 */
      }
    }

    // 同步一份到 交付物/，方便旧界面/清单扫描，但不作为正式落点
    try {
      if (existsSync(source)) await copyFile(source, join(staging, `${baseName}.md`));
      if (docxPath && existsSync(docxPath)) await copyFile(docxPath, join(staging, `${baseName}.docx`));
    } catch {
      /* 非关键路径 */
    }

    return {
      ok: true,
      docxPath,
      markdownPath: source,
      fileName: `${baseName}.docx`,
      files: produced?.files ?? [],
    };
  }

  // ---------------------------------------------------------------- AI 写纪要

  /**
   * 让插件**自己**调模型把纪要写出来。
   *
   * 这是主路径，不是备选方案。原先的设计是"插件只做机械转换，正式纪要交给
   * DSH Agent 写"——理由是机器判断不了"领导强调的核心观点"。但那个理由只
   * 说明不能靠规则拼凑纪要，并不说明不能用模型：模型本来就是判断这件事的
   * 正确工具。而把工作推给 Agent 的代价是用户要离开插件、去对话里要东西、
   * 再把文件放回指定路径，实测这一串就被当成了"失败"。
   *
   * 现在改成：一次点击 → 插件用同一个模型生成 → 落盘 → 转 Word。全在插件内
   * 完成，不碰用户的对话，也不需要用户理解任何中间步骤。
   */
  async authorMinutes(payload) {
    const { jobId } = payload ?? {};

    const job = this.recorder.jobs?.get?.(jobId) ?? null;
    if (!job) return { ok: false, error: '转写任务不存在' };
    if (job.status !== 'ready') return { ok: false, error: `任务状态是 ${job.status}，还不能写纪要` };

    const running = this.authors.get(jobId);
    if (running && running.status === 'running') {
      return { ok: false, error: '这场会议的纪要正在生成中，等它结束就好。' };
    }

    const session = await this.recorder.loadSession(job.sessionId);
    if (!session) return { ok: false, error: '找不到对应的录音' };

    const task = {
      status: 'running',
      chars: 0,
      startedAt: Date.now(),
      error: null,
      result: null,
      provider: null,
      model: null,
      controller: new AbortController(),
    };

    this.authors.set(jobId, task);
    this.pruneAuthors();

    // 故意不 await：一次长会议的模型调用可能持续几分钟，界面靠
    // authorStatus 轮询进度。这样 HTTP 请求不会一直挂着，也才能中途取消。
    void this.runAuthor(task, job, session, payload ?? {}).catch(() => {});

    return { ok: true, authoring: true };
  }

  /**
   * 挑一个模型来写纪要。
   *
   * 优先用户自己选的默认模型——那是他正在用、也预期要花钱的那个；
   * 拿不到就退到部署默认，再退到"只有一个 provider"这种能猜对的情况。
   */
  async resolveAuthorRoute() {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.get !== 'function') return null;

    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) return selection;
    } catch {
      /* 服务不可用就往下试 */
    }

    try {
      const catalog = await ctx.get('sessionController')?.modelCatalog?.();
      if (catalog?.default?.provider && catalog.default.model) return catalog.default;
    } catch {
      /* 同上 */
    }

    try {
      const llm = ctx.get('llm');
      const providers = llm?.listProviders?.() ?? [];
      if (providers.length === 1) {
        const models = (await llm.listModels(providers[0].id)) ?? [];
        if (models[0]?.id) return { provider: providers[0].id, model: models[0].id };
      }
    } catch {
      /* 同上 */
    }

    return null;
  }

  /**
   * 会议信息从哪来。
   *
   * 界面上的"会议信息"是前端状态，进程一重启就没了，所以生成过文件的会议
   * 一律以落盘的《交付请求.json》为准；界面这次传了更新的值就用界面的。
   * 无论走哪个来源，最后都过一遍 normalizeMeeting：录音时间只认会话记录。
   */
  async resolveMeeting(session, payload) {
    const given = payload?.meeting ?? null;
    if (given && typeof given === 'object' && Object.keys(given).length > 0) {
      return normalizeMeeting(given, session);
    }

    try {
      const raw = await readFile(join(session.folder, '交付物', '交付请求.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.meeting && typeof parsed.meeting === 'object') {
        return normalizeMeeting(parsed.meeting, session);
      }
    } catch {
      /* 还没生成过文件：提示词里会如实写"未提供" */
    }

    return normalizeMeeting({}, session);
  }

  async runAuthor(task, job, session, payload) {
    const staging = join(session.folder, '交付物');
    const baseName = this.suggestMinutesBaseName({
      title: job.title ?? session.title,
      recordedAt: session.startedAt,
    });
    // 正式落点：本场会议文件夹根目录；交付物目录只作中间/备份
    const minutesPath = join(session.folder, `${baseName}.md`);

    try {
      const ctx = this.ctx;
      const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null;
      if (!llm || typeof llm.stream !== 'function') {
        throw new Error(
          '当前组装里没有可用的模型服务（llm），无法直接生成纪要。' +
            '请改用「导出纪要写作请求」，把提示词交给 DSH Agent 写。',
        );
      }

      const route = await this.resolveAuthorRoute();
      if (!route) {
        throw new Error('没能确定用哪个模型来写纪要。请先在 Harness 里选好模型，再回来重试。');
      }
      task.provider = route.provider;
      task.model = route.model;

      const meeting = await this.resolveMeeting(session, payload);
      const marks = marksOfSession(session);
      const paths = {
        agentMinutesPath: minutesPath,
        agentOutlinePath: join(session.folder, `${baseName}_附表.md`),
      };

      await mkdir(staging, { recursive: true });

      const prompt = buildMinutesPrompt(job, meeting, paths, marks, 'direct');

      // 上下文预算：转写稿太长就别把请求发出去，让用户看到确切原因，
      // 而不是等几十秒后收到一句 provider 报错。
      let contextWindow = null;
      try {
        const info = await llm.resolveModelInfo?.(route.provider, route.model);
        contextWindow = info?.context?.contextWindow ?? null;
      } catch {
        /* 拿不到容量信息就跳过这项检查 */
      }

      // 中文约 1.6 字符 ≈ 1 token；留 20% 给系统提示和输出
      const estimated = Math.ceil(prompt.length / 1.6);
      if (contextWindow && estimated > contextWindow * 0.8) {
        throw new Error(
          `这场会议的转写稿太长：约 ${estimated} tokens，超过模型 ${route.model} 的上下文（${contextWindow}）。` +
            '请改用「导出纪要写作请求」分段处理，或换一个上下文更大的模型。',
        );
      }

      const options = {
        provider: route.provider,
        model: route.model,
        system:
          '你是中文会议纪要撰写助手，严格按用户给出的写作规范输出，' +
          '不编造任何没有依据的人名、职务和数字。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: task.controller.signal,
      };
      if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort;

      let text = '';
      let finishReason = null;

      for await (const chunk of llm.stream(options)) {
        if (!chunk) continue;

        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          task.chars = text.length;
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason;
          if (reason && reason.kind !== 'stop') finishReason = reason;
        }
      }

      if (finishReason) {
        // 截断和真失败要分开说：这场会议可能只是太长，换模型或分段就能成，
        // 而「max-tokens」这个词对用户没有任何意义。
        if (finishReason.kind === 'max-tokens') {
          throw new Error(
            '纪要写到一半就被模型的输出上限截断了，所以没有落盘——半截的正式纪要比没有更糟。' +
              '这场会议比较长，请改用「导出纪要写作请求」分段撰写，或换一个输出上限更大的模型。',
          );
        }

        const failure = finishReason.failure ?? {};
        throw new Error(
          `模型返回失败：${failure.message ?? finishReason.kind}` +
            `${failure.code ? `（${failure.code}）` : ''}`,
        );
      }

      const markdown = cleanModelMarkdown(text);
      if (!markdown) {
        throw new Error('模型没有返回任何内容。可以重试一次，或改用「导出纪要写作请求」交给 DSH Agent。');
      }

      await writeFile(minutesPath, markdown, 'utf8');

      // 顺手转成 Word：内容就是刚写下的这份 Markdown，只做格式转换
      const rendered = await this.renderMinutes({ jobId: job.id, outputDir: payload.outputDir });

      task.result = {
        markdownPath: minutesPath,
        docxPath: rendered.ok ? rendered.docxPath ?? null : null,
        markdownLength: markdown.length,
        provider: route.provider,
        model: route.model,
        renderError: rendered.ok ? null : rendered.error,
      };
      task.status = 'ok';
    } catch (error) {
      if (task.controller.signal.aborted) {
        task.status = 'cancelled';
        task.error = '已取消。';
      } else {
        task.status = 'failed';
        task.error = error?.message ?? String(error);
      }
    }
  }

  /** 界面轮询生成进度。 */
  authorStatus(payload) {
    const task = this.authors.get(payload?.jobId);
    if (!task) return { ok: true, state: 'idle' };

    return {
      ok: true,
      state: task.status,
      chars: task.chars,
      elapsedMs: Date.now() - task.startedAt,
      provider: task.provider ?? null,
      model: task.model ?? null,
      error: task.error,
      result: task.status === 'ok' ? task.result : null,
    };
  }

  cancelAuthor(payload) {
    const task = this.authors.get(payload?.jobId);
    if (task && task.status === 'running') task.controller.abort();
    return { ok: true };
  }

  /** 只留最近若干条任务记录，正在跑的那条永远不删。 */
  pruneAuthors() {
    if (this.authors.size <= MAX_AUTHOR_TASKS) return;
    for (const [jobId, task] of this.authors) {
      if (this.authors.size <= MAX_AUTHOR_TASKS) break;
      if (task.status !== 'running') this.authors.delete(jobId);
    }
  }
}
