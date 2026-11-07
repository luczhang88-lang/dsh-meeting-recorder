/**
 * 会议录音插件 · Client 半边（浏览器 UI）。
 *
 * 与 Host 的通信方式（依据来自 @deepseek-ai/dsh-client-file-upload 与
 * @deepseek-ai/dsh-client-connection 的 lib/index.js，不是猜的）：
 *   走 Connection 的 fetch 路由，挂在 webserver 的 /api 下。
 *   最初用的是插件自己通过 webServer.register 注册的路由，那条路走不通：
 *   webServer 只服务 GET 页面，所有非 GET 在进入路由前就被拒（实测 405），
 *   未匹配路径由静态兜底返回 404，POST 永远到不了处理器。
 *   也不用 package 私有的 host.call —— 它的 Host 侧接收契约无法确认。
 *
 * 凭据：
 *   同源请求自带浏览器凭据 Cookie（Connection 经 /connect 发放），
 *   普通 fetch 即可通过准入；这里显式写 credentials: 'same-origin'，
 *   免得以后有人改成跨源时静默失效。
 *
 * 采集方式：
 *   用 AudioWorklet 而不是 MediaRecorder。原因：
 *     1. MediaRecorder 输出 webm/opus，还要再转码；AudioWorklet 直接产出
 *        float32 PCM，正是本地引擎要吃的格式，无转码、无音质损失
 *     2. AudioWorklet 在独立音频线程，标签页失去焦点时仍稳定回调
 *
 * 界面约定：
 *   所有颜色、边框、文字色一律走宿主主题令牌（--dsw-alias-*），
 *   不硬编码任何颜色值，亮色 / 暗色主题切换自动跟随。
 */

window.__ModuleLoader__.load({
  id: 'dsh-meeting-recorder',
  factory(require) {
    const React = require('react');

    const PANEL_KEY = 'meeting-recorder';

    /**
     * 路径真源在 host/paths.js；这里是它的副本——Client 是独立的浏览器
     * bundle，没法 import Host 的模块，所以改动时必须两边一起改。
     * Connection 的 fetch 注册表按 url.pathname 精确匹配，这三个字符串
     * 必须与 Host 侧逐字一致，否则请求会落到 404。
     */
    const RPC_PATH = '/api/meeting-recorder/rpc';
    const AUDIO_PATH = '/api/meeting-recorder/audio';
    const IMPORT_PATH = '/api/meeting-recorder/import';

    /** 导入录音允许的扩展名（与 Host MeetingRecorder.importExtensions 对齐）。 */
    const IMPORT_ACCEPT =
      'audio/*,.wav,.wave,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,.webm,.mp4,.amr,.aiff,.aif,.au';

    /**
     * 客户端 cordis 上下文。
     *
     * 组件（RecorderPanel / SidebarEntry 等）定义在 factory 作用域，看不到
     * apply(ctx) 的形参，所以在这里存一份。早先 RecorderPanel 里直接写了
     * ctx.get(...)，那实际是个未定义的自由变量，一点"选择文件夹"就会抛
     * ReferenceError —— 现在统一从这里取。
     */
    let clientCtx = null;

    /** 采集参数，必须与 Host 侧 recorder.js 的常量一致。 */
    const SAMPLE_RATE = 16000;
    const CHUNK_SECONDS = 2;

    // ------------------------------------------------------------ 工具

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children);
    }

    /**
     * 调 Host 的一个业务操作。
     * 所有操作共用一条精确路由，用 body.op 区分（见 host/transport.js 的 ops 表）。
     */
    async function api(op, args) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...(args ?? {}) }),
      });

      const text = await response.text();
      let payload = null;

      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`服务返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`);
      }

      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }

      return payload;
    }

    /**
     * 上传一段 PCM。
     *
     * 直接 POST Float32Array 的底层字节，不做 base64：省掉 33% 的体积膨胀，
     * 也省掉两端的编解码 CPU。Host 那条路由声明了 requestBody: 'streaming'，
     * 于是 request.body 是 ReadableStream，Host 边收边写盘，不占内存。
     *
     * 必须按 byteOffset/byteLength 取视图而不是整个 buffer：传进来的可能
     * 是一个大 buffer 的局部视图，整块发出去会带上不属于这个音频块的内存。
     */
    async function uploadChunk(sessionId, samples) {
      const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

      const response = await fetch(
        `${AUDIO_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        },
      );

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `音频上传失败（HTTP ${response.status}）`);
      }

      return payload;
    }


    /**
     * 导入整段录音文件。
     *
     * 直接把 File/Blob 作为 POST body 流式发给 Host：Host 落盘后转成
     * 16 kHz 单声道 WAV，再返回可转写的会话。不要读成 ArrayBuffer 再发，
     * 长会议文件会把浏览器内存顶爆。
     */
    async function uploadImportFile(file, title) {
      const name = file?.name || '录音.wav';
      const query = new URLSearchParams({
        filename: name,
        title: title || '',
      });

      const response = await fetch(`${IMPORT_PATH}?${query.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `导入失败（HTTP ${response.status}）`);
      }

      if (!payload.ok) {
        throw new Error(payload.error ?? '导入失败');
      }

      return payload;
    }


    function formatClock(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0));
      const hours = String(Math.floor(total / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
      const secs = String(total % 60).padStart(2, '0');
      return `${hours}:${minutes}:${secs}`;
    }

    function formatSize(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    /** ISO 时间 → 「2026年11月5日 21:32」。历史清单按本地时间显示更好读。 */
    function formatDateTime(iso) {
      if (!iso) return '时间未知';

      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);

      const pad = (value) => String(value).padStart(2, '0');
      return (
        `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`
      );
    }

    /**
     * 一场会议处于什么状态。
     *
     * 判定顺序有讲究：正在录音的会话还没有 WAV（收尾时才补文件头的），
     * 而且它的"已写入字节"一直大于 0，所以必须先看 live，否则会把正在录的
     * 会议误报成"待转写"。
     */
    function meetingStatus(session) {
      if (session.live) return { key: 'live', text: '录音中', tone: 'error' };
      if (!session.hasWav) return { key: 'broken', text: '无录音文件', tone: 'warn' };
      if (!session.hasTranscript) return { key: 'todo', text: '待转写', tone: 'warn' };
      if (!session.hasDeliverables) return { key: 'done', text: '已转写', tone: 'brand' };
      return { key: 'shipped', text: '已交付', tone: 'success' };
    }

    function resample(input, fromRate, toRate) {
      const ratio = toRate / fromRate;
      const length = Math.max(1, Math.round(input.length * ratio));
      const output = new Float32Array(length);

      for (let index = 0; index < length; index += 1) {
        const position = index / ratio;
        const low = Math.floor(position);
        const high = Math.min(input.length - 1, low + 1);
        const weight = position - low;
        output[index] = input[low] * (1 - weight) + input[high] * weight;
      }

      return output;
    }

    // ------------------------------------------------------------ 录音器

    class WaveRecorder {
      constructor({ onLevel, onChunk, onError }) {
        this.onLevel = onLevel;
        this.onChunk = onChunk;
        this.onError = onError;
        this.context = null;
        this.stream = null;
        this.node = null;
        this.source = null;
        this.sink = null;
        this.buffer = [];
        this.bufferSamples = 0;
        this.chunkSamples = SAMPLE_RATE * CHUNK_SECONDS;
        this.stopping = false;
        /** 暂停标志。暂停期间收到的帧直接丢弃，所以成品里没有这段空档。 */
        this.paused = false;
      }

      async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: SAMPLE_RATE,
          },
        });

        this.context = new AudioContext({ sampleRate: SAMPLE_RATE });

        // worklet 源码用 Blob URL 装载，不需要 Host 额外提供资源路由
        const source = `
          class CaptureProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const channel = inputs[0] && inputs[0][0];
              if (channel && channel.length > 0) {
                this.port.postMessage(channel.slice(0));
              }
              return true;
            }
          }
          registerProcessor('meeting-capture', CaptureProcessor);
        `;

        const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        try {
          await this.context.audioWorklet.addModule(blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }

        this.source = this.context.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.context, 'meeting-capture');
        this.node.port.onmessage = (event) => this.receive(event.data);

        // 必须接到 destination，否则这条链在部分浏览器里不被驱动
        this.sink = this.context.createGain();
        this.sink.gain.value = 0;
        this.source.connect(this.node);
        this.node.connect(this.sink);
        this.sink.connect(this.context.destination);
      }

      receive(frame) {
        // 暂停时把帧丢掉，而不是攒着等恢复后一次吐出去：攒着既不符合"暂停期间
        // 不录"的语义，也会让恢复瞬间往上传队列里塞进几分钟的音频。
        if (this.stopping || this.paused) return;

        // 麦克风原始采样率可能不是 16 kHz，这里做线性重采样
        const rate = this.context?.sampleRate ?? SAMPLE_RATE;
        const target = Math.abs(rate - SAMPLE_RATE) > 1 ? resample(frame, rate, SAMPLE_RATE) : frame;

        let peak = 0;
        for (let index = 0; index < target.length; index += 1) {
          const value = Math.abs(target[index]);
          if (value > peak) peak = value;
        }
        this.onLevel?.(peak);

        this.buffer.push(target);
        this.bufferSamples += target.length;

        if (this.bufferSamples >= this.chunkSamples) this.flush();
      }

      /**
       * 暂停录音。
       *
       * 先把已攒的、不足一块的样本冲刷出去，再进入暂停。顺序很重要：如果先暂停
       * 再留着这段尾巴，它就要等到恢复之后才发出去，于是落盘顺序变成
       * 「暂停前的尾巴」跟在「恢复后的音频」后面，音频被剪碎。
       */
      pause() {
        if (this.paused || this.stopping) return;
        this.flush();
        this.paused = true;
        this.onLevel?.(0);
      }

      resume() {
        if (this.stopping) return;
        this.paused = false;
      }

      flush() {
        if (this.bufferSamples === 0) return;

        const merged = new Float32Array(this.bufferSamples);
        let offset = 0;
        for (const part of this.buffer) {
          merged.set(part, offset);
          offset += part.length;
        }

        this.buffer = [];
        this.bufferSamples = 0;

        try {
          this.onChunk?.(merged);
        } catch (error) {
          this.onError?.(error);
        }
      }

      async stop() {
        this.stopping = true;

        // 先把残留采样写出去，再断链路
        this.flush();

        try {
          this.node?.port?.close?.();
        } catch {
          /* 已关闭 */
        }

        try {
          this.source?.disconnect();
          this.node?.disconnect();
          this.sink?.disconnect();
        } catch {
          /* 已断开 */
        }

        for (const track of this.stream?.getTracks?.() ?? []) {
          try {
            track.stop();
          } catch {
            /* 已停止 */
          }
        }

        try {
          await this.context?.close();
        } catch {
          /* 已关闭 */
        }

        this.context = null;
        this.stream = null;
      }
    }

    // ------------------------------------------------------------ 基础组件

    function Icon({ path, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        ...path.map((d, index) => h('path', { key: index, d })),
      );
    }

    const MIC_PATH = [
      'M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z',
      'M19 10v2a7 7 0 0 1-14 0v-2',
      'M12 19v3',
    ];
    const PLAY_PATH = ['M6 4l14 8-14 8z'];
    const PAUSE_PATH = ['M6 5h4v14H6z', 'M14 5h4v14h-4z'];

    function Button({ children, onClick, variant = 'default', disabled, title, type = 'button', className = '' }) {
      const classes = ['mr-btn'];
      if (variant !== 'default') classes.push(`mr-btn--${variant}`);
      if (className) classes.push(className);
      return h(
        'button',
        { type, className: classes.join(' '), onClick, disabled, title: title ?? undefined },
        children,
      );
    }

    function Panel({ title, subtitle, children, actions }) {
      return h(
        'section',
        { className: 'mr-panel' },
        h(
          'header',
          { className: 'mr-panel__head' },
          h(
            'div',
            null,
            h('h3', { className: 'mr-panel__title' }, title),
            subtitle ? h('p', { className: 'mr-panel__subtitle' }, subtitle) : null,
          ),
          actions ? h('div', { className: 'mr-panel__actions' }, actions) : null,
        ),
        h('div', { className: 'mr-panel__body' }, children),
      );
    }


    /** 空状态：无会议 / 未就绪时给出明确下一步，而不是白屏或崩。 */
    function EmptyState({ title, hint, primaryLabel, onPrimary, secondaryLabel, onSecondary }) {
      return h(
        'div',
        { className: 'mr-empty' },
        h('div', { className: 'mr-empty__icon' }, h(Icon, { path: MIC_PATH, size: 28 })),
        h('h3', { className: 'mr-empty__title' }, title),
        hint ? h('p', { className: 'mr-empty__hint' }, hint) : null,
        h(
          'div',
          { className: 'mr-empty__actions' },
          primaryLabel && onPrimary
            ? h(Button, { variant: 'primary', onClick: onPrimary }, primaryLabel)
            : null,
          secondaryLabel && onSecondary
            ? h(Button, { variant: 'ghost', onClick: onSecondary }, secondaryLabel)
            : null,
        ),
      );
    }

    function LevelMeter({ level }) {
      const percent = Math.min(100, Math.round(level * 140));
      return h(
        'div',
        { className: 'mr-meter' },
        h('div', { className: 'mr-meter__fill', style: { width: `${percent}%` } }),
      );
    }

    /** 阶段顺序必须与引擎实际发出的 stage 名一致。 */
    const STAGE_ORDER = ['starting', 'load', 'vad', 'asr', 'punc', 'speaker', 'done'];
    const STAGE_LABELS = [
      ['vad', '语音活动检测'],
      ['asr', '语音转文字'],
      ['punc', '标点补全'],
      ['speaker', '说话人分离'],
    ];

    function StageList({ job }) {
      const current = STAGE_ORDER.indexOf(job.stage);

      return h(
        'ul',
        { className: 'mr-stages' },
        ...STAGE_LABELS.map(([key, label]) => {
          const index = STAGE_ORDER.indexOf(key);
          let state = 'pending';
          if (current > index) state = 'done';
          else if (current === index) state = 'active';

          return h(
            'li',
            { key, className: `mr-stage mr-stage--${state}` },
            h('span', { className: 'mr-stage__dot' }),
            h('span', { className: 'mr-stage__label' }, label),
          );
        }),
      );
    }

    // ------------------------------------------------------------ 各标签页

    // ------------------------------------------------------------ 管理首页

    /** 一场会议的卡片：状态、元信息、文件、可做的操作。 */
    /**
     * 会议库一行：表格式，文件默认折叠，避免 chip 挤成一团。
     */
    function MeetingRow({ session, busy, expanded, onToggle, onOpen, onDeliver, onTranscribe, onReveal, onRemove }) {
      const [confirming, setConfirming] = React.useState(false);
      const status = meetingStatus(session);
      const files = session.files ?? [];
      const deliverables = files.filter((file) => file.deliverable);
      const sources = files.filter((file) => !file.deliverable);
      const fileCount = files.length;

      const primaryAction = () => {
        if (!session.hasTranscript && session.hasWav) {
          return h(
            Button,
            { onClick: () => onTranscribe(session), variant: 'primary', disabled: busy },
            '转写',
          );
        }
        if (session.hasTranscript && !session.hasDeliverables) {
          return h(
            Button,
            {
              onClick: () => (onDeliver ? onDeliver(session) : onOpen(session)),
              variant: 'primary',
              disabled: busy,
            },
            '去交付',
          );
        }
        if (session.hasTranscript) {
          return h(
            Button,
            { onClick: () => onOpen(session), variant: 'primary', disabled: busy },
            '校对',
          );
        }
        return null;
      };

      return h(
        React.Fragment,
        null,
        h(
          'tr',
          { className: `mr-tr mr-tr--${status.key}${expanded ? ' mr-tr--open' : ''}` },
          h(
            'td',
            { className: 'mr-td mr-td--name' },
            h(
              'button',
              {
                type: 'button',
                className: 'mr-row-title',
                onClick: onToggle,
                title: expanded ? '收起文件清单' : '展开文件清单',
              },
              h('span', { className: `mr-caret${expanded ? ' mr-caret--open' : ''}` }, '▸'),
              h('span', { className: 'mr-row-title__text' }, session.title || '（未命名会议）'),
            ),
            fileCount
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mr-filecount',
                    onClick: onToggle,
                  },
                  `${fileCount} 个文件`,
                )
              : h('span', { className: 'mr-filecount mr-filecount--empty' }, '暂无文件'),
          ),
          h(
            'td',
            { className: 'mr-td mr-td--status' },
            h(
              'span',
              { className: `mr-badge mr-badge--${status.tone}` },
              h('i', { className: `mr-dot-status mr-dot-status--${status.tone}` }),
              status.text,
            ),
          ),
          h('td', { className: 'mr-td mr-td--time' }, formatDateTime(session.startedAt)),
          h('td', { className: 'mr-td mr-td--mono' }, formatClock(session.seconds)),
          h('td', { className: 'mr-td mr-td--mono' }, formatSize(session.bytes)),
          h(
            'td',
            { className: 'mr-td mr-td--mono' },
            session.speakerCount ? String(session.speakerCount) : '—',
          ),
          h(
            'td',
            { className: 'mr-td mr-td--actions' },
            h(
              'div',
              { className: 'mr-row-actions' },
              primaryAction(),
              // 未交付时主按钮是「去交付」，补一个校对；已交付时主按钮是「校对」，补一个交付
              session.hasTranscript && !session.hasDeliverables
                ? h(
                    Button,
                    { onClick: () => onOpen(session), variant: 'ghost', disabled: busy },
                    '校对',
                  )
                : null,
              session.hasTranscript && session.hasDeliverables
                ? h(
                    Button,
                    {
                      onClick: () => (onDeliver ? onDeliver(session) : onOpen(session)),
                      variant: 'ghost',
                      disabled: busy,
                    },
                    '交付',
                  )
                : null,
              h(
                Button,
                { onClick: () => onReveal(session), variant: 'ghost', disabled: busy },
                '文件夹',
              ),
              confirming
                ? h(
                    React.Fragment,
                    null,
                    h(
                      Button,
                      {
                        onClick: () => {
                          setConfirming(false);
                          onRemove(session);
                        },
                        variant: 'danger',
                        disabled: busy,
                      },
                      '确认移出',
                    ),
                    h(Button, { onClick: () => setConfirming(false), variant: 'ghost' }, '取消'),
                  )
                : h(
                    Button,
                    { onClick: () => setConfirming(true), variant: 'ghost', disabled: busy },
                    '移出',
                  ),
            ),
            confirming
              ? h(
                  'p',
                  { className: 'mr-note mr-note--warn mr-row-warn' },
                  '将移到「已删除」文件夹，不会真删，可手动找回。',
                )
              : null,
          ),
        ),
        expanded
          ? h(
              'tr',
              { className: 'mr-tr mr-tr--detail' },
              h(
                'td',
                { colSpan: 7, className: 'mr-td mr-td--detail' },
                deliverables.length
                  ? h(
                      'div',
                      { className: 'mr-filelist' },
                      h('p', { className: 'mr-filelist__label' }, '交付文件'),
                      h(
                        'ul',
                        { className: 'mr-filelist__ul' },
                        ...deliverables.map((file) =>
                          h(
                            'li',
                            { key: file.path, title: file.path },
                            h('span', { className: 'mr-filelist__name' }, file.name),
                            h('span', { className: 'mr-filelist__size' }, formatSize(file.bytes)),
                          ),
                        ),
                      ),
                    )
                  : h('p', { className: 'mr-muted' }, '还没有交付文件。'),
                sources.length
                  ? h(
                      'div',
                      { className: 'mr-filelist mr-filelist--muted' },
                      h('p', { className: 'mr-filelist__label' }, '中间文件'),
                      h(
                        'ul',
                        { className: 'mr-filelist__ul' },
                        ...sources.map((file) =>
                          h(
                            'li',
                            { key: file.path, title: `${file.name}${file.note ? `（${file.note}）` : ''}` },
                            h('span', { className: 'mr-filelist__name' }, file.name),
                            h('span', { className: 'mr-filelist__size' }, formatSize(file.bytes)),
                          ),
                        ),
                      ),
                    )
                  : null,
                session.markCount
                  ? h('p', { className: 'mr-muted' }, `重点标记 ${session.markCount} 处`)
                  : null,
              ),
            )
          : null,
      );
    }

    // 兼容旧测试台命名
    const MeetingCard = MeetingRow;

    /**
     * 管理首页：表格式会议清单。
     *
     * 文件默认折叠，点名称或「N 个文件」再展开，避免一屏被 chip 占满。
     */
    function HomeView({
      sessions,
      loading,
      busyId,
      onRefresh,
      onNew,
      onImport,
      onOpen,
      onDeliver,
      onTranscribe,
      onReveal,
      onRemove,
    }) {
      const [query, setQuery] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const [expandedId, setExpandedId] = React.useState(null);
      const fileRef = React.useRef(null);

      const pickImport = () => fileRef.current?.click();
      const onFilePicked = (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file && onImport) onImport(file);
      };

      const all = sessions ?? [];
      const statusOf = (session) => meetingStatus(session).key;

      const keyword = query.trim().toLowerCase();
      const list = all.filter((session) => {
        if (filter !== 'all' && statusOf(session) !== filter) return false;
        if (!keyword) return true;
        return `${session.title ?? ''} ${session.folderName ?? ''} ${session.startedAt ?? ''}`
          .toLowerCase()
          .includes(keyword);
      });

      const chips = [
        ['all', '全部', all.length],
        ['todo', '待转写', all.filter((session) => statusOf(session) === 'todo').length],
        ['done', '已转写', all.filter((session) => statusOf(session) === 'done').length],
        ['shipped', '已交付', all.filter((session) => statusOf(session) === 'shipped').length],
      ];

      return h(
        Panel,
        {
          title: '会议记录',
          subtitle: all.length
            ? `共 ${all.length} 场。点名称可展开文件清单；日常操作用右侧按钮即可。`
            : '还没有会议记录。现场录一段，或导入已有录音，讲话文字稿和会议纪要都会留在这里。',
          actions: h(
            'div',
            { className: 'mr-row' },
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: IMPORT_ACCEPT,
              style: { display: 'none' },
              onChange: onFilePicked,
            }),
            h(Button, { onClick: onRefresh, variant: 'ghost', disabled: loading }, '刷新'),
            h(Button, { onClick: pickImport, variant: 'ghost', disabled: loading || Boolean(busyId) }, '导入录音'),
            h(Button, { onClick: onNew, variant: 'primary', className: 'mr-btn--lg' }, '现场录音'),
          ),
        },
        h(
          'div',
          { className: 'mr-home__tools' },
          h('input', {
            className: 'mr-input',
            value: query,
            placeholder: '按会议名称、文件夹或日期筛选…',
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'mr-chips' },
            ...chips.map(([key, label, count]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: `mr-chip ${filter === key ? 'mr-chip--on' : ''}`,
                  onClick: () => setFilter(key),
                },
                `${label} ${count}`,
              ),
            ),
          ),
        ),
        loading ? h('p', { className: 'mr-muted' }, '正在读取会议记录…') : null,
        !loading && list.length === 0
          ? all.length === 0
            ? h(EmptyState, {
                title: '还没有会议',
                hint: '可以现场录音，也可以导入已有音频：转写 → 校对说话人 → 一键出齐录音、讲话稿和会议纪要。',
                primaryLabel: '现场录音',
                onPrimary: onNew,
                secondaryLabel: '导入录音',
                onSecondary: pickImport,
              })
            : h('p', { className: 'mr-muted' }, '没有符合条件的会议。')
          : null,
        !loading && list.length > 0
          ? h(
              'div',
              { className: 'mr-table-wrap' },
              h(
                'table',
                { className: 'mr-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'mr-th mr-th--name' }, '名称'),
                    h('th', { className: 'mr-th' }, '状态'),
                    h('th', { className: 'mr-th' }, '时间'),
                    h('th', { className: 'mr-th' }, '时长'),
                    h('th', { className: 'mr-th' }, '大小'),
                    h('th', { className: 'mr-th' }, '说话人'),
                    h('th', { className: 'mr-th mr-th--actions' }, '操作'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  ...list.map((session) =>
                    h(MeetingRow, {
                      key: session.id,
                      session,
                      busy: busyId === session.id,
                      expanded: expandedId === session.id,
                      onToggle: () =>
                        setExpandedId((current) => (current === session.id ? null : session.id)),
                      onOpen,
                      onDeliver,
                      onTranscribe,
                      onReveal,
                      onRemove,
                    }),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function RecordingView({ state, actions }) {
      const [note, setNote] = React.useState('');
      const fileRef = React.useRef(null);
      const overLimit = state.seconds > state.maxRecordingHours * 3600;

      const marks = [...(state.marks ?? [])].sort((left, right) => left.atSeconds - right.atSeconds);

      const addMark = () => {
        actions.addMark(note.trim());
        setNote('');
      };

      const pickImport = () => fileRef.current?.click();
      const onFilePicked = (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) actions.importRecording?.(file);
      };

      return h(
        Panel,
        {
          title: '录音',
          subtitle: state.paused
            ? '已暂停。暂停期间的谈话不会进入录音，恢复后接着往下录。'
            : state.recording
              ? '使用本机麦克风。录音期间请保持此页面打开。'
              : '现场用麦克风录，或导入已有 wav / mp3 / m4a 等录音文件。',
          actions: state.recording
            ? h(
                'div',
                { className: 'mr-row' },
                state.paused
                  ? h(Button, { onClick: actions.resumeRecording, variant: 'primary' }, '继续录音')
                  : h(Button, { onClick: actions.pauseRecording }, '暂停'),
                h(Button, { onClick: actions.stopRecording, variant: 'danger' }, '结束并转写'),
              )
            : h(
                'div',
                { className: 'mr-row' },
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: IMPORT_ACCEPT,
                  style: { display: 'none' },
                  onChange: onFilePicked,
                }),
                h(
                  Button,
                  {
                    onClick: pickImport,
                    variant: 'ghost',
                    disabled: state.busy,
                  },
                  '导入录音',
                ),
                h(
                  Button,
                  {
                    onClick: actions.startRecording,
                    variant: 'primary',
                    disabled: state.busy,
                    className: 'mr-btn--lg',
                  },
                  '开始录音',
                ),
              ),
        },
        h(
          'div',
          { className: `mr-recorder ${state.paused ? 'mr-recorder--paused' : ''}` },
          h(
            'div',
            { className: 'mr-recorder__timer' },
            h('span', {
              className: `mr-dot ${state.recording && !state.paused ? 'mr-dot--live' : ''}`,
            }),
            h('span', { className: 'mr-recorder__clock' }, formatClock(state.seconds)),
            state.paused ? h('span', { className: 'mr-badge mr-badge--warn' }, '已暂停') : null,
          ),
          h(LevelMeter, { level: state.paused ? 0 : state.level }),
          h(
            'div',
            { className: 'mr-recorder__meta' },
            h('span', null, `已写入 ${formatSize(state.bytes)}`),
            h('span', null, `${SAMPLE_RATE / 1000} kHz 单声道`),
            state.recording ? h('span', null, state.paused ? '暂停中…' : '录音中…') : null,
          ),
        ),
        state.recording
          ? h(
              'div',
              { className: 'mr-mark__add' },
              h('input', {
                className: 'mr-input',
                value: note,
                disabled: state.paused,
                placeholder: '标记重点（备注可不填），例如：领导定调 / 待办分工',
                onChange: (event) => setNote(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addMark();
                },
              }),
              h(
                Button,
                { onClick: addMark, variant: 'primary', disabled: state.paused },
                `标记此刻 ${formatClock(state.seconds)}`,
              ),
            )
          : null,
        state.recording && state.paused
          ? h(
              'p',
              { className: 'mr-note' },
              '暂停期间不能标记：标记要落在音频的某个具体时刻上，而暂停期间的音频不会存在。',
            )
          : null,
        marks.length
          ? h(
              'ul',
              { className: 'mr-mark__list' },
              ...marks.map((mark) =>
                h(
                  'li',
                  { key: mark.id, className: 'mr-mark__item' },
                  h(
                    'div',
                    { className: 'mr-mark__head' },
                    h('span', { className: 'mr-mark__time' }, formatClock(mark.atSeconds)),
                    h(
                      'span',
                      { className: 'mr-mark__note' },
                      mark.note ? mark.note : h('em', { className: 'mr-muted' }, '（无备注）'),
                    ),
                    h('span', { className: 'mr-mark__spacer' }),
                    h(
                      Button,
                      { onClick: () => actions.removeMark(mark.id), variant: 'ghost' },
                      '删除',
                    ),
                  ),
                ),
              ),
            )
          : null,
        overLimit
          ? h(
              'p',
              { className: 'mr-note mr-note--warn' },
              `录音已超过 ${state.maxRecordingHours} 小时。录音仍在继续，但转写耗时会更长，建议分段处理。`,
            )
          : null,
        h(
          'p',
          { className: 'mr-note' },
          '录音不做降噪和自动增益，保留原始音质交给转写引擎处理。',
        ),
      );
    }

    function ProgressView({ job, actions }) {
      return h(
        Panel,
        {
          title: '转写进度',
          subtitle: job.message,
          actions:
            job.status === 'running'
              ? h(Button, { onClick: () => actions.cancelJob(job.id), variant: 'ghost' }, '取消')
              : null,
        },
        h(
          'div',
          { className: 'mr-progress' },
          h(
            'div',
            { className: 'mr-progress__bar' },
            h('div', {
              className: 'mr-progress__fill',
              style: { width: `${Math.round(job.progress * 100)}%` },
            }),
          ),
          h('span', { className: 'mr-progress__value' }, `${Math.round(job.progress * 100)}%`),
        ),
        h(StageList, { job }),
        job.realTimeFactor
          ? h(
              'p',
              { className: 'mr-note' },
              `音频 ${Math.round(job.audioSeconds)} 秒，处理用了 ${Math.round(job.inferenceSeconds)} 秒` +
                `（实时倍率 ${Number(job.realTimeFactor).toFixed(2)}，越小越快）。`,
            )
          : null,
        job.error ? h('p', { className: 'mr-note mr-note--warn' }, job.error) : null,
      );
    }

    function SpeakerManager({ job, actions }) {
      const [drafts, setDrafts] = React.useState({});

      const speakers = React.useMemo(() => {
        const totals = new Map();
        for (const segment of job.segments ?? []) {
          const entry = totals.get(segment.speaker) ?? { segments: 0, seconds: 0, low: 0 };
          entry.segments += 1;
          entry.seconds += Number(segment.end) - Number(segment.start);
          if (typeof segment.confidence === 'number' && segment.confidence < 0.6) entry.low += 1;
          totals.set(segment.speaker, entry);
        }
        return [...totals.entries()]
          .map(([name, entry]) => ({ name, ...entry }))
          .sort((left, right) => right.seconds - left.seconds);
      }, [job.segments]);

      const totalSeconds = speakers.reduce((sum, item) => sum + item.seconds, 0) || 1;

      return h(
        Panel,
        {
          title: '说话人',
          subtitle: '声纹聚类只知道"这是不同的几个人"，不知道姓名。请填上姓名后点应用。',
        },
        h(
          'ul',
          { className: 'mr-speakers' },
          ...speakers.map((speaker) =>
            h(
              'li',
              { key: speaker.name, className: 'mr-speaker' },
              h(
                'div',
                { className: 'mr-speaker__meta' },
                h('span', { className: 'mr-speaker__raw' }, speaker.name),
                h(
                  'span',
                  { className: 'mr-speaker__stat' },
                  `${Math.round(speaker.seconds)} 秒 · 占比 ${Math.round(
                    (speaker.seconds / totalSeconds) * 100,
                  )}% · ${speaker.segments} 段`,
                ),
                speaker.low > 0
                  ? h('span', { className: 'mr-speaker__warn' }, `${speaker.low} 段分人置信度偏低`)
                  : null,
              ),
              h(
                'div',
                { className: 'mr-row' },
                h('input', {
                  className: 'mr-input',
                  type: 'text',
                  placeholder: '姓名（可留空）',
                  value: drafts[speaker.name] ?? '',
                  onChange: (event) => setDrafts({ ...drafts, [speaker.name]: event.target.value }),
                }),
                h(
                  Button,
                  {
                    onClick: () => actions.renameSpeaker(speaker.name, drafts[speaker.name] ?? ''),
                    disabled: !(drafts[speaker.name] ?? '').trim(),
                  },
                  '应用',
                ),
              ),
            ),
          ),
        ),
        speakers.length > 6
          ? h(
              'p',
              { className: 'mr-note mr-note--warn' },
              '说话人数量偏多，通常意味着同一个人被拆成了几段（抢话、离麦克风远近变化都会导致）。' +
                '只说了很短几句的"说话人"多半是误分，可以在下面按段改归属。',
            )
          : null,
      );
    }

    /**
     * 可拖动的播放进度条。
     *
     * 拖动用 Pointer Events + setPointerCapture：指针一旦被捕获，即使拖到条外、
     * 甚至拖出窗口，事件仍然回到这个元素上，不会出现"拖到一半丢了"的老毛病。
     *
     * 条上叠了三层信息：
     *   - 说话区间底衬：有内容的地方有底色，一眼看出哪里在讲、哪里在歇；
     *   - 重点标记：强调色竖线，悬停显示备注；
     *   - 当前位置：圆形滑块 + 已播进度。
     */
    function SeekBar({ audioRef, duration, position, segments, marks, onSeek }) {
      const trackRef = React.useRef(null);
      const [dragging, setDragging] = React.useState(false);
      const total = Number.isFinite(duration) && duration > 0 ? duration : 0;

      const percent = (seconds) =>
        total > 0 ? Math.min(Math.max(Number(seconds) / total, 0), 1) * 100 : 0;

      /**
       * 说话区间底衬只算一次并缓存。
       * 时间轴不随播放变化，而播放时每秒会重渲染几次，没必要反复算两百多个位置。
       */
      const bandRef = React.useRef({ key: null, nodes: null });
      const bandKey = `${total}|${segments.length}`;
      if (bandRef.current.key !== bandKey) {
        bandRef.current = {
          key: bandKey,
          nodes:
            total > 0
              ? segments.map((segment, index) =>
                  h('span', {
                    key: `band-${index}`,
                    className: 'mr-seek__band',
                    style: {
                      left: `${percent(segment.start)}%`,
                      // 极短的一段也要看得见，给一个最小宽度
                      width: `${Math.max(percent(segment.end) - percent(segment.start), 0.2)}%`,
                    },
                  }),
                )
              : [],
        };
      }

      const ratioAt = (clientX) => {
        const node = trackRef.current;
        if (!node) return 0;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      };

      const seekTo = (ratio) => {
        if (total <= 0) return;
        const target = Math.min(Math.max(ratio, 0), 1) * total;
        const node = audioRef.current;
        if (node) node.currentTime = target;
        onSeek?.(target);
      };

      return h(
        'div',
        {
          ref: trackRef,
          className: `mr-seek ${dragging ? 'mr-seek--dragging' : ''}`,
          role: 'slider',
          tabIndex: 0,
          'aria-label': '播放进度，可拖动',
          'aria-valuemin': 0,
          'aria-valuemax': Math.round(total),
          'aria-valuenow': Math.round(position),
          onPointerDown: (event) => {
            if (total <= 0) return;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* 老浏览器没有指针捕获，退化成普通拖动 */
            }
            setDragging(true);
            seekTo(ratioAt(event.clientX));
          },
          onPointerMove: (event) => {
            if (!dragging) return;
            seekTo(ratioAt(event.clientX));
          },
          onPointerUp: (event) => {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              /* 已经释放 */
            }
            setDragging(false);
          },
          onPointerCancel: () => setDragging(false),
          onKeyDown: (event) => {
            if (total <= 0) return;
            const step = event.shiftKey ? 30 : 5;
            if (event.key === 'ArrowRight') {
              seekTo((position + step) / total);
              event.preventDefault();
            } else if (event.key === 'ArrowLeft') {
              seekTo((position - step) / total);
              event.preventDefault();
            }
          },
        },
        ...bandRef.current.nodes,
        h('div', { className: 'mr-seek__fill', style: { width: `${percent(position)}%` } }),
        ...(marks ?? []).map((mark, index) =>
          h('span', {
            key: mark.id ?? `mark-${index}`,
            className: 'mr-seek__mark',
            style: { left: `${percent(mark.atSeconds)}%` },
            title: `${formatClock(mark.atSeconds)}${mark.note ? ` ${mark.note}` : ''}`,
          }),
        ),
        h('span', { className: 'mr-seek__head', style: { left: `${percent(position)}%` } }),
      );
    }

    /**
     * 重点标记列表。
     *
     * 三种操作：跳到标记处、改备注、删除。备注用行内输入框直接改、回车即存，
     * 不用弹窗——会议记录过程中最忌讳打断。
     */
    function MarkList({ marks, current, onSeek, onAdd, onUpdate, onRemove }) {
      const [draft, setDraft] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [note, setNote] = React.useState('');

      const sorted = [...(marks ?? [])].sort((left, right) => left.atSeconds - right.atSeconds);

      const submit = () => {
        onAdd(draft.trim());
        setDraft('');
      };

      return h(
        Panel,
        {
          title: '重点标记',
          subtitle: sorted.length
            ? `${sorted.length} 处。写纪要时会优先体现这些时刻的主题。`
            : '录音中或回听时按「标记此处」记下重点时刻，写纪要时会优先体现。',
        },
        h(
          'div',
          { className: 'mr-row mr-mark__add' },
          h('input', {
            className: 'mr-input',
            value: draft,
            placeholder: '备注（可不填），例如：领导定调 / 待办分工',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit();
            },
          }),
          h(
            Button,
            { onClick: submit, variant: 'primary' },
            `标记 ${formatClock(current)}`,
          ),
        ),
        sorted.length
          ? h(
              'ul',
              { className: 'mr-mark__list' },
              ...sorted.map((mark) =>
                h(
                  'li',
                  { key: mark.id, className: 'mr-mark__item' },
                  h(
                    'div',
                    { className: 'mr-mark__head' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'mr-mark__time',
                        onClick: () => onSeek(mark.atSeconds),
                        title: '跳到这个位置',
                      },
                      formatClock(mark.atSeconds),
                    ),
                    editing === mark.id
                      ? null
                      : h(
                          'span',
                          { className: 'mr-mark__note' },
                          mark.note ? mark.note : h('em', { className: 'mr-muted' }, '（无备注）'),
                        ),
                    h('span', { className: 'mr-mark__spacer' }),
                    editing === mark.id
                      ? h(
                          React.Fragment,
                          null,
                          h(
                            Button,
                            {
                              onClick: () => {
                                onUpdate(mark.id, note);
                                setEditing(null);
                              },
                              variant: 'primary',
                            },
                            '保存',
                          ),
                          h(Button, { onClick: () => setEditing(null), variant: 'ghost' }, '取消'),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h(
                            Button,
                            {
                              onClick: () => {
                                setEditing(mark.id);
                                setNote(mark.note ?? '');
                              },
                              variant: 'ghost',
                            },
                            '改备注',
                          ),
                          h(Button, { onClick: () => onRemove(mark.id), variant: 'ghost' }, '删除'),
                        ),
                  ),
                  editing === mark.id
                    ? h('input', {
                        className: 'mr-input',
                        value: note,
                        autoFocus: true,
                        onChange: (event) => setNote(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') {
                            onUpdate(mark.id, note);
                            setEditing(null);
                          }
                        },
                      })
                    : null,
                ),
              ),
            )
          : null,
      );
    }

    function TranscriptView({ job, actions }) {
      const [playing, setPlaying] = React.useState(null);
      const [editing, setEditing] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const [duration, setDuration] = React.useState(0);
      const [position, setPosition] = React.useState(0);
      const audioRef = React.useRef(null);

      const segments = job.segments ?? [];
      const marks = job.marks ?? [];

      // 播放到该段结尾就停，避免一路播下去
      React.useEffect(() => {
        const node = audioRef.current;
        if (playing === null || !node) return undefined;

        const segment = segments[playing];
        if (!segment) return undefined;

        const onTimeUpdate = () => {
          if (node.currentTime >= Number(segment.end)) node.pause();
        };

        node.addEventListener('timeupdate', onTimeUpdate);
        return () => node.removeEventListener('timeupdate', onTimeUpdate);
      }, [playing, segments]);

      const visible = segments.filter((segment) => {
        if (filter === 'all') return true;
        if (filter === 'low') {
          return typeof segment.confidence === 'number' && segment.confidence < 0.6;
        }
        return segment.speaker === filter;
      });

      const play = (index) => {
        const node = audioRef.current;
        const segment = segments[index];
        if (!node || !segment) return;

        if (playing === index) {
          node.pause();
          setPlaying(null);
          return;
        }

        node.currentTime = Number(segment.start);
        node
          .play()
          .then(() => setPlaying(index))
          .catch(() => setPlaying(null));
      };

      const saveEdit = () => {
        actions.updateSegment(editing, { text: draft });
        setEditing(null);
      };

      /**
       * 跳到某个时刻。拖动进度条、点标记、点段落都走这里。
       * 元数据还没加载完时 currentTime 赋值会被忽略，所以位置状态照样先更新，
       * 让滑块跟手，音频就绪后再拖一次即可。
       */
      const seekTo = (seconds) => {
        const target = Math.max(0, Number(seconds) || 0);
        const node = audioRef.current;
        if (node) {
          try {
            node.currentTime = target;
          } catch {
            /* 音频还没就绪 */
          }
        }
        setPosition(target);
      };

      const speakerNames = [...new Set(segments.map((segment) => segment.speaker))];
      const lowCount = segments.filter(
        (segment) => typeof segment.confidence === 'number' && segment.confidence < 0.6,
      ).length;

      return h(
        Panel,
        {
          title: '讲话文字稿',
          subtitle:
            `${segments.length} 段` +
            (lowCount ? `，其中 ${lowCount} 段置信度偏低建议复核` : '') +
            '。点击文字即可修改。',
          actions: h(
            'select',
            {
              className: 'mr-input mr-input--sm',
              value: filter,
              onChange: (event) => setFilter(event.target.value),
            },
            h('option', { value: 'all' }, '全部'),
            lowCount ? h('option', { value: 'low' }, `待复核（${lowCount}）`) : null,
            ...speakerNames.map((name) => h('option', { key: name, value: name }, name)),
          ),
        },
        job.audioUrl
          ? h(
              'div',
              { className: 'mr-player' },
              h(SeekBar, {
                audioRef,
                duration,
                position,
                segments,
                marks,
                onSeek: setPosition,
              }),
              h(
                'div',
                { className: 'mr-player__row' },
                h('audio', {
                  ref: audioRef,
                  src: job.audioUrl,
                  preload: 'metadata',
                  className: 'mr-audio',
                  controls: true,
                  onLoadedMetadata: (event) => setDuration(event.currentTarget.duration || 0),
                  onTimeUpdate: (event) => setPosition(event.currentTarget.currentTime || 0),
                  onSeeked: (event) => setPosition(event.currentTarget.currentTime || 0),
                }),
                h(
                  'span',
                  { className: 'mr-player__clock' },
                  `${formatClock(position)} / ${formatClock(duration)}`,
                ),
              ),
              h(
                'p',
                { className: 'mr-note' },
                '拖动上面的进度条可定位到任意时刻；细底色表示有人在说话的位置，竖线是你标的重点。',
              ),
            )
          : null,
        h(MarkList, {
          marks,
          current: position,
          onSeek: seekTo,
          onAdd: (note) => actions.addJobMark(position, note),
          onUpdate: actions.updateJobMark,
          onRemove: actions.removeJobMark,
        }),
        h(
          'div',
          { className: 'mr-segments' },
          ...visible.map((segment) => {
            const index = segment.index;
            const low = typeof segment.confidence === 'number' && segment.confidence < 0.6;

            return h(
              'article',
              {
                key: index,
                className: `mr-seg ${low ? 'mr-seg--low' : ''} ${
                  playing === index ? 'mr-seg--playing' : ''
                }`,
              },
              h(
                'div',
                { className: 'mr-seg__head' },
                h(
                  Button,
                  { onClick: () => play(index), variant: 'ghost', title: '只播放这一段' },
                  h(Icon, { path: playing === index ? PAUSE_PATH : PLAY_PATH, size: 13 }),
                ),
                h(
                  'span',
                  { className: 'mr-seg__time' },
                  `${formatClock(segment.start)} – ${formatClock(segment.end)}`,
                ),
                h('span', { className: 'mr-seg__speaker' }, segment.speaker),
                low ? h('span', { className: 'mr-seg__flag' }, '待复核') : null,
              ),
              editing === index
                ? h(
                    'div',
                    { className: 'mr-seg__edit' },
                    h('textarea', {
                      className: 'mr-textarea',
                      value: draft,
                      rows: 3,
                      onChange: (event) => setDraft(event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'mr-row' },
                      h(Button, { onClick: saveEdit, variant: 'primary' }, '保存'),
                      h(Button, { onClick: () => setEditing(null), variant: 'ghost' }, '取消'),
                    ),
                  )
                : h(
                    'p',
                    {
                      className: 'mr-seg__text',
                      onClick: () => {
                        setEditing(index);
                        setDraft(segment.text);
                      },
                      title: '点击修改文字',
                    },
                    segment.text || h('em', { className: 'mr-muted' }, '（空）'),
                  ),
            );
          }),
        ),
      );
    }

    const FORMAT_LABELS = [
      ['recording', '录音文件（WAV）'],
      ['transcript', '讲话文字稿（按时间）'],
      ['transcriptBySpeaker', '讲话文字稿（按人合并）'],
      ['outline', '发言要点提纲（机器抽取）'],
      ['subtitles', 'SRT 字幕'],
      ['plainText', '纯文本稿'],
    ];

    /** 把毫秒说成人话，用在"已用 1 分 12 秒"这种地方。 */
    function formatElapsed(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
      if (total < 60) return `${total} 秒`;
      return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
    }

    function ExportView({ job, actions, outputDir, onPickDirectory, onGoHome, onGoRecord, onGoReview }) {
      const [formats, setFormats] = React.useState({
        recording: true,
        transcript: true,
        transcriptBySpeaker: true,
        outline: true,
        subtitles: false,
        plainText: false,
      });
      const [result, setResult] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [advanced, setAdvanced] = React.useState(false);
      // AI 写纪要的进度。Host 起任务后立刻返回，这里靠轮询拿进度和结果。
      const [author, setAuthor] = React.useState(null);
      const authoring = author?.state === 'running';
      const authorModelText = author?.model ?? '当前模型';
      const jobId = job?.id ?? null;
      const ready = job?.status === 'ready';

      const run = async (operation) => {
        setBusy(true);
        setResult(null);
        try {
          setResult(await operation());
        } catch (error) {
          setResult({ ok: false, error: error.message });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 一键让插件自己写纪要。
       *
       * 这里**不等**模型跑完：Host 那边是异步任务，本地只把状态置成 running，
       * 进度和结果交给下面的轮询。一次长会议的模型调用要几分钟，同步等会把
       * 按钮一直卡住，既没有进度也没法取消。
       */
      const startAuthoring = async () => {
        if (!jobId) return;
        setResult(null);
        setAuthor({ state: 'running', chars: 0, elapsedMs: 0 });

        try {
          const started = await actions.authorMinutes();
          if (!started?.ok && !started?.authoring) {
            setAuthor(null);
            setResult({ ok: false, error: started?.error ?? '无法开始生成纪要' });
          }
        } catch (error) {
          setAuthor(null);
          setResult({ ok: false, error: error.message });
        }
      };

      /**
       * 傻瓜主路径：先落机械交付文件，再异步写正式纪要。
       * 录音 / 讲话稿 / 提纲立刻可用；纪要在后台流式生成，可取消。
       */
      const shipAll = async () => {
        if (!jobId || !ready) return;
        setBusy(true);
        setResult(null);
        try {
          const files = await actions.generate(formats);
          if (!files?.ok) {
            setResult(files ?? { ok: false, error: '生成交付文件失败' });
            return;
          }
          setResult({ ...files, shipping: true });
          setAuthor({ state: 'running', chars: 0, elapsedMs: 0 });
          const started = await actions.authorMinutes();
          if (!started?.ok && !started?.authoring) {
            setAuthor(null);
            setResult({
              ok: true,
              ...files,
              author: null,
              warn: started?.error ?? '讲话稿已生成，但纪要未能启动',
            });
          }
        } catch (error) {
          setAuthor(null);
          setResult({ ok: false, error: error.message });
        } finally {
          setBusy(false);
        }
      };

      // 轮询进度。依赖只写 authoring + jobId：job 为 null 时绝不能读 job.id。
      React.useEffect(() => {
        if (!authoring || !jobId) return undefined;

        let alive = true;
        const timer = setInterval(async () => {
          try {
            const next = await actions.authorStatus();
            if (!alive || !next?.state) return;

            setAuthor(next);
            if (next.state === 'running') return;

            setResult((prev) => {
              if (next.state === 'ok') {
                return {
                  ...(prev && prev.ok ? prev : {}),
                  ok: true,
                  author: next.result,
                  docxPath: next.result?.docxPath ?? null,
                  shipping: false,
                };
              }
              return {
                ...(prev && prev.ok ? prev : {}),
                ok: false,
                error: next.error ?? '生成纪要失败',
                shipping: false,
              };
            });
          } catch {
            /* 单次轮询失败不打断，下一拍继续 */
          }
        }, 1200);

        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [authoring, jobId]);

      if (!job) {
        return h(
          Panel,
          { title: '交付', subtitle: '生成录音、讲话文字稿和正式会议纪要。' },
          h(EmptyState, {
            title: '还没有打开会议',
            hint: '请先在「会议记录」打开一场已转写的会议，或新建一场录音。点「交付」不会再白屏。',
            primaryLabel: '去会议记录',
            onPrimary: onGoHome,
            secondaryLabel: '新建录音',
            onSecondary: onGoRecord,
          }),
        );
      }

      if (!ready) {
        const running = job.status === 'running';
        return h(
          Panel,
          { title: '交付', subtitle: job.title || '当前会议' },
          h(EmptyState, {
            title: running ? '转写还在进行' : '转写尚未完成',
            hint: running
              ? '转写结束后会自动进入校对；校对完说话人姓名，再回来一键出齐交付物。'
              : (job.error
                ? `转写未成功：${job.error}`
                : '请先完成转写，再生成讲话稿和会议纪要。'),
            primaryLabel: running ? '查看转写进度' : '去会议记录',
            onPrimary: running ? onGoReview : onGoHome,
            secondaryLabel: running ? null : '新建录音',
            onSecondary: running ? null : onGoRecord,
          }),
        );
      }

      return h(
        Panel,
        {
          title: '交付',
          subtitle: '推荐一键出齐：录音、讲话文字稿、发言要点，以及正式《会议纪要》Word。',
        },
        h(
          'div',
          { className: 'mr-step mr-step--primary' },
          h('p', { className: 'mr-step__title' }, '一键出齐全部交付物'),
          h(
            'p',
            { className: 'mr-step__hint' },
            `先落盘录音与讲话稿，再用 Harness 当前模型（${authorModelText}）撰写正式纪要并转成 Word。` +
              '长会议通常要几分钟，可随时取消纪要生成。',
          ),
          h(
            'div',
            { className: 'mr-row' },
            h(
              Button,
              {
                variant: 'primary',
                className: 'mr-btn--lg',
                disabled: authoring || busy,
                onClick: shipAll,
              },
              authoring || busy ? '正在处理…' : '一键出齐交付物',
            ),
            authoring
              ? h(
                  Button,
                  {
                    variant: 'danger',
                    onClick: () => {
                      void actions.cancelAuthor();
                    },
                  },
                  '取消纪要',
                )
              : null,
            h(
              Button,
              {
                variant: 'ghost',
                disabled: authoring || busy,
                onClick: startAuthoring,
              },
              '只生成会议纪要',
            ),
          ),
          authoring
            ? h(
                'div',
                { className: 'mr-author-progress' },
                h(
                  'div',
                  { className: 'mr-progress' },
                  h(
                    'div',
                    { className: 'mr-progress__bar' },
                    h('div', {
                      className: 'mr-progress__fill mr-progress__fill--pulse',
                      style: { width: '64%' },
                    }),
                  ),
                  h(
                    'span',
                    { className: 'mr-progress__value' },
                    `${author?.chars ?? 0} 字`,
                  ),
                ),
                h(
                  'p',
                  { className: 'mr-muted' },
                  `已生成 ${author?.chars ?? 0} 字，用时 ${formatElapsed(author?.elapsedMs)}。` +
                    '可以先去忙别的，完成后会留在本页。',
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'mr-step' },
          h('p', { className: 'mr-step__title' }, '① 机械交付文件'),
          h(
            'p',
            { className: 'mr-step__hint' },
            '讲话文字稿、按人合并稿、要点提纲等（不含正式纪要正文）。',
          ),
          h(
            'div',
            { className: 'mr-grid' },
            ...FORMAT_LABELS.map(([key, label]) =>
              h(
                'label',
                { key, className: 'mr-check' },
                h('input', {
                  type: 'checkbox',
                  checked: formats[key],
                  onChange: () => setFormats({ ...formats, [key]: !formats[key] }),
                }),
                h('span', null, label),
              ),
            ),
          ),
          h(
            'div',
            { className: 'mr-field' },
            h('span', { className: 'mr-field__label' }, '额外复制到（可选）'),
            h(
              'div',
              { className: 'mr-row' },
              h('input', {
                className: 'mr-input',
                readOnly: true,
                value: outputDir ?? '',
                placeholder: '不选也可以：文件默认留在会议目录的「交付物」里',
              }),
              h(Button, { onClick: onPickDirectory }, '浏览…'),
            ),
          ),
          h(
            'div',
            { className: 'mr-row' },
            h(
              Button,
              {
                disabled: busy || authoring || !ready,
                onClick: () => run(() => actions.generate(formats)),
              },
              '只生成这些文件',
            ),
          ),
        ),
        h(
          'div',
          { className: 'mr-step' },
          h(
            'button',
            {
              type: 'button',
              className: 'mr-step__toggle',
              onClick: () => setAdvanced(!advanced),
            },
            advanced ? '收起高级选项' : '高级：用自己的 Agent / Claude Code 写纪要',
          ),
          advanced
            ? h(
                React.Fragment,
                null,
                h(
                  'p',
                  { className: 'mr-step__hint' },
                  '导出写作请求，交给任意 Agent；写完把 Markdown 存到约定路径，再点「转成 Word」。',
                ),
                h(
                  'div',
                  { className: 'mr-row' },
                  h(
                    Button,
                    {
                      disabled: busy || !ready,
                      onClick: () => run(() => actions.exportPrompt()),
                    },
                    '导出写作请求',
                  ),
                  h(
                    Button,
                    {
                      disabled: busy || !ready,
                      onClick: () => run(() => actions.renderMinutes()),
                    },
                    '把 Markdown 转成 Word',
                  ),
                ),
                h(
                  'p',
                  { className: 'mr-mono mr-muted' },
                  `约定路径：${result?.agentMinutesPath ?? '（先生成一次文件，这里会显示确切路径）'}`,
                ),
              )
            : null,
        ),
        result
          ? result.ok
            ? h(
                'div',
                { className: 'mr-result mr-result--ok' },
                h('p', null, authoring ? '讲话稿已就绪，纪要仍在生成…' : '完成。'),
                result.warn
                  ? h('p', { className: 'mr-note mr-note--warn' }, result.warn)
                  : null,
                result.author
                  ? h(
                      'p',
                      { className: 'mr-muted' },
                      `${result.author.provider} / ${result.author.model}：纪要正文 ${result.author.markdownLength} 字`,
                    )
                  : null,
                result.author?.markdownPath
                  ? h('p', { className: 'mr-mono' }, `纪要 Markdown：${result.author.markdownPath}`)
                  : result.stageDir
                    ? h('p', { className: 'mr-mono' }, `工作区：${result.stageDir}`)
                    : null,
                result.outputDir
                  ? h('p', { className: 'mr-mono' }, `已复制到：${result.outputDir}`)
                  : null,
                result.docxPath ?? result.author?.docxPath
                  ? h(
                      'p',
                      { className: 'mr-mono' },
                      `纪要 Word：${result.docxPath ?? result.author?.docxPath}`,
                    )
                  : null,
                result.author?.renderError
                  ? h(
                      'p',
                      { className: 'mr-note mr-note--warn' },
                      `纪要正文已经写好，但转 Word 失败：${result.author.renderError}`,
                    )
                  : null,
                result.promptPath
                  ? h('p', { className: 'mr-mono' }, `写作请求：${result.promptPath}`)
                  : null,
                result.copyError
                  ? h('p', { className: 'mr-note mr-note--warn' }, result.copyError)
                  : null,
                (result.files ?? []).length > 0
                  ? h(
                      'ul',
                      { className: 'mr-files' },
                      ...(result.files ?? []).map((file) => h('li', { key: file.path }, file.name)),
                    )
                  : null,
              )
            : result.needMinutes
              ? h(
                  'div',
                  { className: 'mr-result mr-result--info' },
                  h('p', null, '还没有纪要 Markdown，所以暂时没有 Word 可以转换。'),
                  h('p', { className: 'mr-muted' }, '两条路选一条：'),
                  h(
                    'ul',
                    { className: 'mr-files' },
                    h('li', null, '点上面的「一键出齐交付物」或「只生成会议纪要」（推荐）；'),
                    h(
                      'li',
                      null,
                      '或者展开高级选项，导出写作请求交给自己的 Agent，再回来转 Word。',
                    ),
                  ),
                  h('p', { className: 'mr-mono' }, result.markdownPath ?? ''),
                )
              : h(
                  'div',
                  { className: 'mr-result mr-result--err' },
                  h('p', { className: 'mr-pre' }, result.error),
                )
          : null,
      );
    }

    // ------------------------------------------------------------ 引擎安装

    /**
     * 只启动捆绑 setup，不接受任意命令。默认按钮不下载模型。
     * 进度和失败都留在页面上，避免脚本在终端里失败了界面仍显示就绪。
     */
    function EngineBanner({ engine, setup, busy, onStart, onCancel }) {
      if (!engine) return null;

      const running = Boolean(setup?.running);
      const failed = setup?.phase === 'failed';
      const succeeded = setup?.phase === 'succeeded';
      const lines = Array.isArray(setup?.log) ? setup.log.slice(-12) : [];
      const ready = Boolean(engine.pythonReady);

      let title = '引擎依赖还没装到这份插件里';
      let detail =
        '插件代码已经加载，但还不能转写。需要在下面这个目录创建 Python 虚拟环境并安装依赖。模型约 2GB+，默认不会下载。';
      if (!engine.canSetupHere) {
        title = '当前引擎目录不是本插件自带的 engine/';
        detail = '界面不会代跑安装，以免装到插件没用的位置。请到 engineRoot 所指目录，按 INSTALL.md 手动运行 setup。';
      } else if (running) {
        title = setup?.downloadModels ? '正在安装依赖并下载模型' : '正在安装依赖（不下载模型）';
        detail = '请保持本页打开。下面是安装脚本的输出。失败会停在非零退出码，不会显示为已完成。';
      } else if (failed) {
        title = '安装没有完成';
        detail = setup?.error
          ? setup.error
          : `安装脚本退出码 ${setup?.exitCode ?? '未知'}。依赖或模型仍可能缺失。`;
      } else if (succeeded && setup?.downloadModels) {
        title = '依赖已安装，模型下载步骤已结束';
        detail = '若 Harness 在安装前已经打开，请完全退出后重新打开，再开始转写。';
      } else if (succeeded) {
        title = '依赖已安装，模型还没下载';
        detail = '第一次转写会尝试从 ModelScope 下载约 2GB+。也可以点「安装依赖并下载模型」。';
      } else if (ready) {
        title = '已找到引擎 Python';
        detail = '虚拟环境里的解释器存在。模型是否完整要等第一次转写或自检；这里不能把它说成已经能转写。';
      }

      return h(
        'section',
        { className: `mr-engine ${failed ? 'mr-engine--bad' : ready && !running ? 'mr-engine--ok' : ''}` },
        h('div', { className: 'mr-engine__copy' }, h('strong', null, title), h('p', null, detail)),
        h(
          'dl',
          { className: 'mr-engine__paths' },
          h('div', null, h('dt', null, '插件目录'), h('dd', { className: 'mr-mono' }, engine.pluginRoot)),
          h('div', null, h('dt', null, 'engineRoot'), h('dd', { className: 'mr-mono' }, engine.engineRoot)),
          h('div', null, h('dt', null, 'Python'), h('dd', { className: 'mr-mono' }, engine.pythonPath)),
        ),
        h(
          'div',
          { className: 'mr-engine__actions' },
          h(
            Button,
            {
              variant: 'primary',
              disabled: busy || running || !engine.canSetupHere,
              onClick: () => onStart(false),
            },
            '只安装依赖',
          ),
          h(
            Button,
            {
              disabled: busy || running || !engine.canSetupHere,
              onClick: () => onStart(true),
              title: '下载约 2GB+ 模型，需要网络和磁盘空间',
            },
            '安装依赖并下载模型',
          ),
          running
            ? h(
                Button,
                { onClick: onCancel },
                '停止',
              )
            : null,
        ),
        lines.length
          ? h('pre', { className: 'mr-engine__log' }, lines.join('\n'))
          : null,
      );
    }

    // ------------------------------------------------------------ 主面板

    function RecorderPanel() {
      const [status, setStatus] = React.useState(null);
      const [recording, setRecording] = React.useState(false);
      const [level, setLevel] = React.useState(0);
      const [seconds, setSeconds] = React.useState(0);
      const [bytes, setBytes] = React.useState(0);
      const [job, setJob] = React.useState(null);
      const [title, setTitle] = React.useState('');
      const [outputDir, setOutputDir] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      // 默认落在管理首页：多次会议是常态，先看见历史再谈录新的
      const [tab, setTab] = React.useState('home');
      const [paused, setPaused] = React.useState(false);
      const [marks, setMarks] = React.useState([]);
      const [sessions, setSessions] = React.useState([]);
      const [loadingSessions, setLoadingSessions] = React.useState(true);
      const [busyId, setBusyId] = React.useState(null);
      const [engine, setEngine] = React.useState(null);
      const [setupState, setSetupState] = React.useState(null);

      const recorderRef = React.useRef(null);
      const sessionRef = React.useRef(null);
      const levelRef = React.useRef({ value: 0, decay: 0 });
      /** 录音已累计的有效秒数（不含暂停时段），跨暂停由计时器累加维护。 */
      const elapsedRef = React.useRef(0);

      /**
       * 音频上传队列。
       *
       * 为什么必须串行：Host 按到达顺序把每块 PCM 追加到同一个文件，
       * 并发 POST 一旦乱序（慢的那块插到前面），整段音频就被剪碎了。
       * 每 2 秒发一块，正常情况下远快于采集，但 Host 忙起来（比如正在
       * 起 Python 进程）单次请求就可能超过 2 秒，所以这里用一条 promise 链
       * 排队，而不是依赖"它应该够快"。
       *
       * 收尾时也必须先等这条链排空再告诉 Host 结束录音，否则 WAV 头会按
       * 当时已落盘的字节数写死，尾部音频就丢了。
       */
      const uploadRef = React.useRef(Promise.resolve());

      /**
       * 读会议清单。
       *
       * 首页、以及每次录音或转写完成后都会调用：状态徽标（待转写/已转写/已交付）
       * 和文件清单都由 Host 现算，前端不自己猜，避免和磁盘上的实际情况脱节。
       */
      const refreshSessions = async () => {
        setLoadingSessions(true);
        try {
          const result = await api('sessions');
          if (result.ok) setSessions(result.sessions ?? []);
        } catch (error) {
          setMessage({ kind: 'error', text: `读取会议清单失败：${error.message}` });
        } finally {
          setLoadingSessions(false);
        }
      };

      // 初始化：取引擎状态与会议清单
      React.useEffect(() => {
        let cancelled = false;
        api('status')
          .then((result) => {
            if (cancelled) return;
            setStatus(result);
            if (result.engine) setEngine(result.engine);
            if (result.setup) setSetupState(result.setup);
            if (result.defaultOutputDir) setOutputDir(result.defaultOutputDir);
          })
          .catch(
            (error) =>
              !cancelled && setMessage({ kind: 'error', text: `无法连接语音引擎接口：${error.message}` }),
          );
        refreshSessions();
        return () => {
          cancelled = true;
        };
      }, []);

      // 安装脚本可能要几分钟到几十分钟。只在它还在跑时轮询，避免空转。
      React.useEffect(() => {
        if (!setupState?.running) return undefined;
        let cancelled = false;

        const timer = setInterval(async () => {
          try {
            const result = await api('setup/status');
            if (cancelled || !result.ok) return;
            setSetupState(result.setup);
            if (!result.setup?.running) {
              const fresh = await api('status');
              if (cancelled || !fresh.ok) return;
              setStatus(fresh);
              if (fresh.engine) setEngine(fresh.engine);
              setMessage(
                fresh.setup?.phase === 'succeeded'
                  ? {
                      kind: 'ok',
                      text: fresh.setup.downloadModels
                        ? '依赖和模型下载步骤已结束。请完全退出并重启 Harness 后再转写。'
                        : '依赖已安装。这一步没有下载模型。',
                    }
                  : {
                      kind: 'error',
                      text: fresh.setup?.error || `安装未完成（退出码 ${fresh.setup?.exitCode ?? '未知'}）`,
                    },
              );
            }
          } catch (error) {
            if (!cancelled) setMessage({ kind: 'error', text: error.message });
          }
        }, 1000);

        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [setupState?.running]);

      const beginSetup = async (downloadModels) => {
        setBusy(true);
        setMessage(null);
        try {
          const result = await api('setup/start', { downloadModels: downloadModels === true });
          if (!result.ok) throw new Error(result.error || '无法启动安装');
          setSetupState(result.setup);
          setMessage({
            kind: 'ok',
            text: downloadModels
              ? '已开始安装依赖并下载模型。这一步会拉取约 2GB+，请看下面的输出。'
              : '已开始安装依赖。这一步不下载模型。',
          });
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusy(false);
        }
      };

      const cancelSetup = async () => {
        try {
          const result = await api('setup/cancel');
          if (result.setup) setSetupState(result.setup);
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        }
      };

      // 电平表平滑：上升即时、下降缓慢，符合音量表观感
      React.useEffect(() => {
        let frame = 0;
        const tick = () => {
          const state = levelRef.current;
          state.decay = Math.max(state.value, state.decay * 0.92);
          setLevel(state.decay);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
      }, []);

      /**
       * 录音计时。
       *
       * 计时的秒数必须与音频的实际长度是同一件事：暂停期间不采集麦克风，
       * 音频里就没有那段时间，计时也必须停。所以用「已累计秒数 + 本段已走的
       * 毫秒」来算，而不是拿开始时刻直接相减——后者会把暂停的时长也算进去，
       * 界面上显示 40 分钟而音频只有 32 分钟，还会让人误判是否超限。
       */
      React.useEffect(() => {
        if (!recording || paused) return undefined;

        const base = elapsedRef.current;
        const started = Date.now();

        const timer = setInterval(() => setSeconds(base + (Date.now() - started) / 1000), 500);

        return () => {
          clearInterval(timer);
          elapsedRef.current = base + (Date.now() - started) / 1000;
        };
      }, [recording, paused]);

      // 任务轮询：转写是分钟级的，靠轮询拿进度
      React.useEffect(() => {
        if (!job || job.status !== 'running') return undefined;
        let cancelled = false;

        const timer = setInterval(async () => {
          try {
            const result = await api('job/get', { jobId: job.id });
            if (cancelled) return;
            if (result.ok) {
              setJob(result.job);
              if (result.job.status !== 'running') {
                setTab('review');
                setMessage(
                  result.job.status === 'ready'
                    ? { kind: 'ok', text: '转写完成，请在「校对」里确认说话人和文字。' }
                    : { kind: 'error', text: result.job.error ?? '转写没有正常完成' },
                );
              }
            }
          } catch (error) {
            if (!cancelled) setMessage({ kind: 'error', text: error.message });
          }
        }, 1500);

        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [job]);

      const startRecording = async () => {
        uploadRef.current = Promise.resolve();
        elapsedRef.current = 0;
        setMessage(null);
        setBusy(true);
        setSeconds(0);
        setBytes(0);
        setJob(null);
        setPaused(false);
        setMarks([]);

        try {
          const begun = await api('recording/begin', { title, sampleRate: SAMPLE_RATE });
          if (!begun.ok) throw new Error(begun.error);

          sessionRef.current = begun.session;

          const recorder = new WaveRecorder({
            onLevel: (peak) => {
              const state = levelRef.current;
              state.value = peak;
              if (peak > state.decay) state.decay = peak;
            },
            onChunk: (samples) => {
              const session = sessionRef.current;
              if (!session) return;

              // 排到队列尾部（见 uploadRef 的说明）。失败只提示，不掐断后续块：
              // 一块传丢了比整场录音停掉更容易补救。
              uploadRef.current = uploadRef.current
                .then(() => uploadChunk(session.id, samples))
                .then((result) => {
                  if (result.ok) setBytes(result.session.bytes);
                  else setMessage({ kind: 'error', text: result.error });
                })
                .catch((error) =>
                  setMessage({ kind: 'error', text: `音频写入失败：${error.message}` }),
                );
            },
            onError: (error) => setMessage({ kind: 'error', text: error.message }),
          });

          await recorder.start();
          recorderRef.current = recorder;
          setRecording(true);
        } catch (error) {
          const hint = /permission|denied|NotAllowed/i.test(error.message)
            ? '浏览器拒绝了麦克风访问。请检查地址栏左侧的权限图标，允许本页面使用麦克风后重试。'
            : error.message;
          setMessage({ kind: 'error', text: hint });
        } finally {
          setBusy(false);
        }
      };

      const stopRecording = async () => {
        setBusy(true);
        setRecording(false);
        setPaused(false);

        try {
          await recorderRef.current?.stop();
          recorderRef.current = null;

          const session = sessionRef.current;
          if (!session) return;

          // 等最后几块音频落盘完成再收尾，否则 WAV 头会按当时的字节数写死，
          // 尾部音频就丢了
          await uploadRef.current;

          const finished = await api('recording/finish', { sessionId: session.id });
          if (!finished.ok) throw new Error(finished.error);

          sessionRef.current = finished.session;
          setSeconds(finished.session.seconds);
          setMessage({
            kind: 'ok',
            text: `录音完成，共 ${formatSize(finished.session.bytes)}，开始转写…`,
          });

          const started = await api('transcribe', { sessionId: finished.session.id });
          if (!started.ok) throw new Error(started.error);

          const first = await api('job/get', { jobId: started.jobId });
          setJob(first.job);
          setTab('progress');
          void refreshSessions();
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusy(false);
        }
      };

      /**
       * 暂停 / 继续。
       *
       * 暂停 = 停止采集。已攒下的不足一块的样本先冲刷出去（见 WaveRecorder.pause），
       * 所以暂停点不会在音频里留下半块噪声，恢复后接着往下录，中间没有空档。
       */
      const pauseRecording = () => {
        recorderRef.current?.pause();
        setPaused(true);
        setLevel(0);
      };

      const resumeRecording = () => {
        recorderRef.current?.resume();
        setPaused(false);
      };

      /**
       * 加标记。
       *
       * 时间点由 Host 按已落盘字节数算出，前端不传时间：墙上时间、音频时长、
       * 去掉暂停后的内容时长这三条轴里，只有"音频字节"是共同基准，
       * 由持有字节数的那一方算才可能准。前端只负责备注。
       */
      const addMark = async (note) => {
        const session = sessionRef.current;
        if (!session) return;

        try {
          const result = await api('mark/add', { sessionId: session.id, note });
          if (!result.ok) throw new Error(result.error);
          sessionRef.current = result.session ?? session;
          setMarks(result.session?.marks ?? []);
        } catch (error) {
          setMessage({ kind: 'error', text: `标记失败：${error.message}` });
        }
      };

      const removeMark = async (markId) => {
        const session = sessionRef.current;
        if (!session) return;

        try {
          const result = await api('mark/remove', { sessionId: session.id, markId });
          if (!result.ok) throw new Error(result.error);
          sessionRef.current = result.session ?? session;
          setMarks(result.session?.marks ?? []);
        } catch (error) {
          setMessage({ kind: 'error', text: `删除标记失败：${error.message}` });
        }
      };

      // ---------------------------------------------------------- 历史会议

      /** 打开一场历史会议：任务表是内存态，Host 会按需从磁盘恢复。 */
      const openMeeting = async (session, targetTab = 'review') => {
        setBusyId(session.id);
        setMessage(null);

        try {
          const result = await api('job/reopen', { sessionId: session.id });
          if (!result.ok) throw new Error(result.error);

          setJob(result.job);
          if (result.job.title) setTitle(result.job.title);
          setTab(targetTab);
          if (targetTab === 'export' && result.job?.status === 'ready') {
            setMessage({ kind: 'ok', text: '已打开会议，可一键出齐交付物。' });
          }
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusyId(null);
        }
      };

      const openMeetingForDelivery = (session) => openMeeting(session, 'export');

      /** 给一场历史会议补转写。 */
      const transcribeSession = async (session) => {
        setBusyId(session.id);
        setMessage(null);

        try {
          const started = await api('transcribe', { sessionId: session.id });
          if (!started.ok) throw new Error(started.error);

          const first = await api('job/get', { jobId: started.jobId });
          setJob(first.job);
          setTab('progress');
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusyId(null);
        }
      };

      const revealSession = async (session) => {
        try {
          const result = await api('session/reveal', { sessionId: session.id });
          if (!result.ok) throw new Error(result.error);
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        }
      };

      /** 移出清单：Host 把整个目录改名移进「已删除」，不是真删。 */
      const removeSession = async (session) => {
        setBusyId(session.id);

        try {
          const result = await api('session/remove', { sessionId: session.id });
          if (!result.ok) throw new Error(result.error);

          if (job?.sessionId === session.id) setJob(null);
          sessionRef.current = sessionRef.current?.id === session.id ? null : sessionRef.current;

          await refreshSessions();
          setMessage({ kind: 'ok', text: '已移出清单，文件在「已删除」文件夹里，可以手动找回。' });
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusyId(null);
        }
      };

      const startNewRecording = () => {
        setJob(null);
        setMessage(null);
        setTab('record');
      };

      /**
       * 导入已有录音：上传 → 转成 16 kHz WAV → 自动开始转写。
       * 与现场录音共用后续校对 / 交付流程。
       */
      const importRecording = async (file) => {
        if (!file) return;

        setBusy(true);
        setBusyId('import');
        setMessage({ kind: 'ok', text: `正在导入「${file.name}」…` });
        setJob(null);

        try {
          const imported = await uploadImportFile(file, title);
          if (!imported.ok) throw new Error(imported.error);

          sessionRef.current = imported.session;
          setSeconds(imported.session.seconds ?? 0);
          setBytes(imported.session.bytes ?? 0);
          setMessage({
            kind: 'ok',
            text:
              `已导入「${imported.session.title || file.name}」，` +
              `时长 ${formatClock(imported.session.seconds ?? 0)}，开始转写…`,
          });

          const started = await api('transcribe', { sessionId: imported.session.id });
          if (!started.ok) throw new Error(started.error);

          const first = await api('job/get', { jobId: started.jobId });
          setJob(first.job);
          setTab('progress');
          void refreshSessions();
        } catch (error) {
          setMessage({ kind: 'error', text: error.message });
        } finally {
          setBusy(false);
          setBusyId(null);
        }
      };

      const requireJobId = () => {
        if (!job?.id) throw new Error('还没有打开会议，请先在「会议记录」打开一场。');
        return job.id;
      };

      const actions = {
        startRecording,
        stopRecording,
        pauseRecording,
        resumeRecording,
        importRecording,
        addMark,
        removeMark,
        cancelJob: async (jobId) => {
          try {
            const result = await api('job/cancel', { jobId });
            if (result.job) setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: error.message });
          }
        },
        renameSpeaker: async (speaker, name) => {
          try {
            const result = await api('speakers/rename', { jobId: requireJobId(), speaker, name });
            if (!result.ok) throw new Error(result.error);
            setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: error.message });
          }
        },
        updateSegment: async (index, patch) => {
          try {
            const result = await api('segments', {
              jobId: requireJobId(),
              updates: [{ index, ...patch }],
            });
            if (!result.ok) throw new Error(result.error);
            setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: error.message });
          }
        },
        generate: async (formats) => {
          const result = await api('deliverables', {
            jobId: requireJobId(),
            outputDir,
            formats,
            // 只传名称：录音时间由 Host 从会话记录取（见 normalizeMeeting）。
            // 这里传 new Date() 会让「录音时间」变成点按钮的时刻，隔天补写
            // 纪要就会在正式文件里写出一个错日期。
            meeting: { title: title || job?.title },
          });
          // 交付物落盘后首页的文件清单会变，顺手刷新
          void refreshSessions();
          return result;
        },
        exportPrompt: async () => {
          const result = await api('minutes-prompt', {
            jobId: requireJobId(),
            outputDir,
            meeting: { title: title || job?.title },
          });
          return { ...result, promptPath: result.minutesPromptPath };
        },
        // 第三步：Agent 写好 Markdown 后，只做格式转换，不改内容。
        // 路径由 Host 从会话推出来，界面不需要记着它。
        renderMinutes: async () => {
          const result = await api('minutes/render', { jobId: requireJobId(), outputDir });
          void refreshSessions();
          return result;
        },

        // 主路径：让插件自己调模型写纪要。Host 起任务后立刻返回，
        // 进度由 authorStatus 轮询；完成时顺手刷新首页的文件清单。
        authorMinutes: async () =>
          api('minutes/author', {
            jobId: requireJobId(),
            outputDir,
            meeting: { title: title || job?.title },
          }),
        authorStatus: async () => {
          const next = await api('minutes/author-status', { jobId: requireJobId() });
          if (next?.state && next.state !== 'running') void refreshSessions();
          return next;
        },
        cancelAuthor: async () => api('minutes/cancel', { jobId: requireJobId() }),

        // 校对页里的标记：这时已经只有 jobId 了，Host 会从任务反查会话。
        // 时间点由校对页的播放位置给出（此时音频已定长，位置就是内容时间）。
        addJobMark: async (atSeconds, note) => {
          try {
            const result = await api('mark/add', { jobId: requireJobId(), atSeconds, note });
            if (!result.ok) throw new Error(result.error);
            setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: `标记失败：${error.message}` });
          }
        },
        updateJobMark: async (markId, note) => {
          try {
            const result = await api('mark/update', { jobId: requireJobId(), markId, note });
            if (!result.ok) throw new Error(result.error);
            setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: `保存备注失败：${error.message}` });
          }
        },
        removeJobMark: async (markId) => {
          try {
            const result = await api('mark/remove', { jobId: requireJobId(), markId });
            if (!result.ok) throw new Error(result.error);
            setJob(result.job);
          } catch (error) {
            setMessage({ kind: 'error', text: `删除标记失败：${error.message}` });
          }
        },
      };

      const pickDirectory = async () => {
        const service = clientCtx?.get('uiWorkspace');
        if (!service?.pickDirectory) {
          setMessage({ kind: 'error', text: '当前界面没有提供目录选择器。' });
          return;
        }
        try {
          const picked = await service.pickDirectory();
          if (picked) setOutputDir(picked);
        } catch (error) {
          setMessage({ kind: 'error', text: `打开目录选择器失败：${error.message}` });
        }
      };

      const tabs = [
        ['home', '会议记录'],
        ['record', '录音'],
        ['progress', '转写'],
        ['review', '校对'],
        ['export', '交付'],
      ];

      return h(
        'div',
        { className: 'mr-root' },
        h(
          'header',
          { className: 'mr-header' },
          h(
            'div',
            { className: 'mr-header__title' },
            h(Icon, { path: MIC_PATH, size: 20 }),
            h('h2', null, '会议录音'),
            h('span', { className: 'mr-header__tag' }, '本地离线'),
          ),
          status?.meetingsRoot
            ? h('div', { className: 'mr-header__status mr-muted mr-mono' }, status.meetingsRoot)
            : null,
        ),
        h(
          'div',
          { className: 'mr-flow', 'aria-hidden': true },
          ...[
            ['home', '1', '会议库'],
            ['record', '2', '录音'],
            ['progress', '3', '转写'],
            ['review', '4', '校对'],
            ['export', '5', '交付'],
          ].map(([key, num, label]) =>
            h(
              'span',
              {
                key,
                className: `mr-flow__step ${tab === key ? 'mr-flow__step--on' : ''}`,
              },
              h('span', { className: 'mr-flow__n' }, num),
              label,
            ),
          ),
        ),
        h(
          'nav',
          { className: 'mr-tabs' },
          ...tabs.map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: `mr-tab ${tab === key ? 'mr-tab--active' : ''}`,
                onClick: () => setTab(key),
              },
              label,
            ),
          ),
        ),
        message
          ? h(
              'div',
              { className: `mr-banner mr-banner--${message.kind}` },
              h('span', null, message.text),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mr-banner__close',
                  onClick: () => setMessage(null),
                },
                '×',
              ),
            )
          : null,
        h(EngineBanner, {
          engine,
          setup: setupState,
          busy,
          onStart: beginSetup,
          onCancel: cancelSetup,
        }),
        h(
          'div',
          { className: 'mr-body' },
          tab === 'home'
            ? h(HomeView, {
                sessions,
                loading: loadingSessions,
                busyId,
                onRefresh: refreshSessions,
                onNew: startNewRecording,
                onImport: importRecording,
                onOpen: openMeeting,
                onDeliver: openMeetingForDelivery,
                onTranscribe: transcribeSession,
                onReveal: revealSession,
                onRemove: removeSession,
              })
            : null,

          tab === 'record'
            ? h(
                React.Fragment,
                null,
                h(
                  Panel,
                  {
                    title: '会议信息',
                    subtitle: '可留空。现场停录或导入完成后会自动开始转写。',
                  },
                  h(
                    'div',
                    { className: 'mr-field' },
                    h('span', { className: 'mr-field__label' }, '会议名称'),
                    h('input', {
                      className: 'mr-input',
                      type: 'text',
                      value: title,
                      placeholder: '例如：数智化转型专题会（用于文件夹命名）',
                      disabled: recording,
                      onChange: (event) => setTitle(event.target.value),
                    }),
                  ),
                ),
                h(RecordingView, {
                  state: {
                    recording,
                    paused,
                    marks,
                    level,
                    seconds,
                    bytes,
                    busy,
                    maxRecordingHours: status?.maxRecordingHours ?? 6,
                  },
                  actions,
                }),
              )
            : null,

          tab === 'progress'
            ? job
              ? h(ProgressView, { job, actions })
              : h(
                  Panel,
                  { title: '转写进度' },
                  h(EmptyState, {
                    title: '还没有转写任务',
                    hint: '现场录一段或导入录音后会自动开始转写；也可以从会议记录里点「开始转写」。',
                    primaryLabel: '去录音',
                    onPrimary: () => setTab('record'),
                    secondaryLabel: '会议记录',
                    onSecondary: () => setTab('home'),
                  }),
                )
            : null,

          tab === 'review'
            ? job?.status === 'ready'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'mr-review-cta' },
                    h(
                      'p',
                      { className: 'mr-muted' },
                      '核对说话人姓名和关键句子后，去「交付」一键出齐文件。',
                    ),
                    h(
                      Button,
                      { variant: 'primary', onClick: () => setTab('export') },
                      '去交付',
                    ),
                  ),
                  h(SpeakerManager, { job, actions }),
                  h(TranscriptView, { job, actions }),
                )
              : h(
                  Panel,
                  { title: '校对' },
                  h(EmptyState, {
                    title: job?.status === 'running' ? '转写还在进行' : '还没有可校对的发言稿',
                    hint:
                      job?.status === 'running'
                        ? '转写完成后会自动跳到本页。'
                        : '请先完成一场录音转写，或从会议记录打开已转写的会议。',
                    primaryLabel: job?.status === 'running' ? '查看进度' : '去会议记录',
                    onPrimary: () => setTab(job?.status === 'running' ? 'progress' : 'home'),
                    secondaryLabel: '新建录音',
                    onSecondary: startNewRecording,
                  }),
                )
            : null,

          tab === 'export'
            ? h(ExportView, {
                job,
                actions,
                outputDir,
                onPickDirectory: pickDirectory,
                onGoHome: () => setTab('home'),
                onGoRecord: startNewRecording,
                onGoReview: () => setTab(job?.status === 'running' ? 'progress' : 'review'),
              })
            : null,
        ),
      );
    }

    // ------------------------------------------------------------ 侧边栏图标

    function SidebarEntry() {
      /**
       * 切到本插件的主面板。
       *
       * 宿主是否把 sidebar.panellist 的点击代管到 layout.selectPanel 无法从
       * inspect 确认（入口本身是纯展示的 span），所以这里自己挂一次点击：
       * 能切就切，宿主没有 layout 服务时静默忽略，不影响插件激活。
       * 重复切同一个 id 是幂等的，所以即使宿主也代管一次也没有副作用。
       */
      const open = () => {
        try {
          clientCtx?.get('layout')?.selectPanel?.(PANEL_KEY);
        } catch {
          /* 宿主没有 layout 服务 */
        }
      };

      return h(
        'span',
        {
          className: 'mr-sidebar-entry',
          role: 'button',
          tabIndex: 0,
          'aria-label': '会议录音',
          title: '会议录音',
          onClick: open,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          },
        },
        h(Icon, { path: MIC_PATH, size: 18 }),
      );
    }

    // ------------------------------------------------------------ 样式

    const STYLE_ID = 'meeting-recorder-styles';

    const CSS = `
.mr-root {
  display: flex; flex-direction: column; height: 100%;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px; line-height: 1.6;
}
.mr-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; padding: 18px 24px 10px;
}
.mr-header__title { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-brand-primary); flex-wrap: wrap; }
.mr-header__title h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
.mr-header__tag {
  font-size: 11px; font-weight: 550; padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.mr-header__status { max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

.mr-flow { display: flex; gap: 6px; padding: 0 24px 12px; flex-wrap: wrap; }
.mr-flow__step {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.mr-flow__step--on {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.mr-flow__n {
  width: 18px; height: 18px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.mr-flow__step--on .mr-flow__n {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}

.mr-tabs {
  display: flex; gap: 2px; margin: 0 24px;
  padding: 4px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.mr-tab {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  flex: 1; min-width: 0; padding: 9px 10px; font-size: 13px;
  color: var(--dsw-alias-label-secondary); border-radius: 9px;
  font-family: inherit; font-weight: 500;
}
.mr-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.mr-tab--active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-weight: 650;
  box-shadow: 0 1px 0 var(--dsw-alias-border-l1);
}
.mr-body {
  flex: 1; overflow: auto; padding: 16px 24px 40px;
  display: flex; flex-direction: column; gap: 14px;
}
.mr-sidebar-entry { display: flex; align-items: center; justify-content: center; }

.mr-panel {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
}
.mr-panel__head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 16px 18px 12px;
}
.mr-panel__title { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.mr-panel__subtitle { margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.mr-panel__actions { flex: none; }
.mr-panel__body { padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 14px; }

.mr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.mr-muted { color: var(--dsw-alias-label-secondary); }
.mr-mono { font-family: Consolas, "SFMono-Regular", monospace; font-size: 11px; }

.mr-btn {
  appearance: none; cursor: pointer; font-family: inherit; font-size: 13px;
  padding: 7px 14px; border-radius: 9px; line-height: 1.4; font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.mr-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.mr-btn:disabled { opacity: .45; cursor: not-allowed; }
.mr-btn--primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 650;
  padding: 9px 18px;
}
.mr-btn--danger {
  background: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-base);
}
.mr-btn--ghost { background: transparent; border-color: transparent; padding: 6px 10px; }
.mr-btn--ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.mr-btn--lg { padding: 12px 22px; font-size: 14px; border-radius: 11px; }

.mr-input, .mr-textarea, select.mr-input {
  font-family: inherit; font-size: 13px; padding: 8px 12px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  width: 100%; box-sizing: border-box;
}
.mr-input--sm { width: auto; min-width: 130px; }
.mr-input:focus, .mr-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.mr-textarea { resize: vertical; line-height: 1.6; }
.mr-field { display: flex; flex-direction: column; gap: 6px; }
.mr-field__label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mr-check { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
.mr-check input { cursor: pointer; }

.mr-recorder {
  display: flex; flex-direction: column; gap: 14px; align-items: center;
  padding: 18px 12px 8px; text-align: center;
}
.mr-recorder__timer { display: flex; align-items: center; justify-content: center; gap: 12px; }
.mr-recorder__clock {
  font-family: Consolas, monospace; font-size: 42px; font-weight: 650; letter-spacing: .04em;
}
.mr-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.mr-dot--live { background: var(--dsw-alias-state-error-primary); animation: mr-pulse 1.4s ease-in-out infinite; }
@keyframes mr-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
.mr-recorder__meta {
  display: flex; gap: 16px; justify-content: center; flex-wrap: wrap;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}

.mr-meter {
  position: relative; height: 10px; border-radius: 999px; overflow: hidden; width: min(420px, 100%);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.mr-meter__fill {
  height: 100%; background: var(--dsw-alias-state-success-primary);
  transition: width .06s linear;
}

.mr-progress { display: flex; align-items: center; gap: 12px; }
.mr-progress__bar {
  flex: 1; height: 10px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); overflow: hidden;
}
.mr-progress__fill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }
.mr-progress__fill--pulse { animation: mr-pulse 1.4s ease-in-out infinite; }
.mr-progress__value { font-family: Consolas, monospace; font-size: 12px; min-width: 42px; text-align: right; }
.mr-stages { display: flex; gap: 14px; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
.mr-stage { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mr-stage__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-border-l2); }
.mr-stage--active .mr-stage__dot { background: var(--dsw-alias-brand-primary); animation: mr-pulse 1.2s infinite; }
.mr-stage--active .mr-stage__label { color: var(--dsw-alias-label-primary); font-weight: 600; }
.mr-stage--done .mr-stage__dot { background: var(--dsw-alias-state-success-primary); }

.mr-speakers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.mr-speaker {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-base); flex-wrap: wrap;
}
.mr-speaker__meta { display: flex; flex-direction: column; gap: 2px; min-width: 220px; }
.mr-speaker__raw { font-weight: 650; }
.mr-speaker__stat { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mr-speaker__warn { font-size: 11px; color: var(--dsw-alias-state-warn-primary); }

.mr-audio { width: 100%; height: 34px; }
.mr-segments { display: flex; flex-direction: column; gap: 8px; max-height: 58vh; overflow: auto; padding-right: 4px; }
.mr-seg {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  padding: 12px 14px; background: var(--dsw-alias-bg-base);
}
.mr-seg--low { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.mr-seg--playing { border-color: var(--dsw-alias-brand-primary); }
.mr-seg__head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.mr-seg__time { font-family: Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mr-seg__speaker { font-size: 12px; font-weight: 650; }
.mr-seg__flag {
  font-size: 11px; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-warn-primary);
}
.mr-seg__text { margin: 0; cursor: text; }
.mr-seg__text:hover { color: var(--dsw-alias-brand-primary); }
.mr-seg__edit { display: flex; flex-direction: column; gap: 8px; }

.mr-note { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mr-note--warn { color: var(--dsw-alias-state-warn-primary); }
.mr-result { border-radius: 12px; padding: 14px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); }
.mr-result--ok { border: 1px solid var(--dsw-alias-state-success-primary); }
.mr-result--err { border: 1px solid var(--dsw-alias-state-error-primary); }
.mr-result--info { border: 1px solid var(--dsw-alias-border-l2); }
.mr-pre { white-space: pre-line; }
.mr-step {
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.mr-step--primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.mr-step__title { margin: 0; font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.mr-step__hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.mr-step__toggle {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  padding: 0; text-align: left; font: inherit; font-size: 13px; font-weight: 650;
  color: var(--dsw-alias-brand-primary);
}
.mr-step__toggle:hover { text-decoration: underline; }
.mr-author-progress { display: flex; flex-direction: column; gap: 8px; }
.mr-result p { margin: 0 0 6px; word-break: break-all; }
.mr-files { margin: 6px 0 0; padding-left: 18px; }
.mr-files li { font-family: Consolas, monospace; font-size: 11px; }

.mr-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin: 12px 24px 0; padding: 10px 14px; border-radius: 12px; font-size: 13px;
  background: var(--dsw-alias-bg-layer-2);
}
.mr-banner--error { border: 1px solid var(--dsw-alias-state-error-primary); }
.mr-banner--ok { border: 1px solid var(--dsw-alias-state-success-primary); }
.mr-banner--info { border: 1px solid var(--dsw-alias-border-l2); }
.mr-banner__close {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  font-size: 18px; line-height: 1; color: var(--dsw-alias-label-secondary); padding: 0 4px;
}

.mr-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; text-align: center; padding: 48px 20px 36px;
}
.mr-empty__icon {
  width: 64px; height: 64px; border-radius: 18px;
  display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.mr-empty__title { margin: 0; font-size: 16px; font-weight: 650; }
.mr-empty__hint {
  margin: 0; max-width: 440px; font-size: 13px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary);
}
.mr-empty__actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }

.mr-review-cta {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.mr-review-cta .mr-muted { margin: 0; flex: 1; }

.mr-home__tools { display: flex; flex-direction: column; gap: 10px; }
.mr-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.mr-chip {
  appearance: none; cursor: pointer; font-family: inherit; font-size: 12px;
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.mr-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.mr-chip--on {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-base);
  font-weight: 650;
}

.mr-table-wrap {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
}
.mr-table {
  width: 100%; border-collapse: collapse; min-width: 780px;
}
.mr-th {
  text-align: left; font-size: 11px; font-weight: 650;
  color: var(--dsw-alias-label-secondary);
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  white-space: nowrap;
}
.mr-th--name { padding-left: 16px; min-width: 180px; }
.mr-th--actions { padding-right: 14px; text-align: right; }
.mr-tr { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mr-tr:last-child { border-bottom: 0; }
.mr-tr:hover { background: var(--dsw-alias-bg-layer-1); }
.mr-tr--open { background: var(--dsw-alias-bg-layer-1); }
.mr-tr--live td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-state-error-primary); }
.mr-tr--todo td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary); }
.mr-tr--done td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }
.mr-tr--shipped td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary); }
.mr-tr--broken td:first-child { box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary); }
.mr-tr--detail { background: var(--dsw-alias-bg-layer-1); }
.mr-tr--detail:hover { background: var(--dsw-alias-bg-layer-1); }
.mr-td {
  padding: 12px; vertical-align: middle;
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.mr-td--name { padding-left: 16px; min-width: 200px; }
.mr-td--mono { font-family: Consolas, monospace; font-size: 12px; white-space: nowrap; }
.mr-td--time { white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.mr-td--status { white-space: nowrap; }
.mr-td--actions { text-align: right; padding-right: 14px; }
.mr-td--detail { padding: 0 16px 14px; }
.mr-row-title {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0; max-width: 100%;
  font: inherit; font-size: 13px; font-weight: 650;
  color: var(--dsw-alias-label-primary); text-align: left;
}
.mr-row-title:hover { color: var(--dsw-alias-brand-primary); }
.mr-row-title__text {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px;
}
.mr-caret {
  display: inline-flex; width: 14px; justify-content: center;
  color: var(--dsw-alias-label-secondary);
  transition: transform .15s ease;
}
.mr-caret--open { transform: rotate(90deg); }
.mr-filecount {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  display: block; margin-top: 4px; padding: 0;
  font: inherit; font-size: 11px;
  color: var(--dsw-alias-brand-primary);
}
.mr-filecount--empty { color: var(--dsw-alias-label-secondary); cursor: default; }
.mr-row-actions {
  display: inline-flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end;
}
.mr-row-warn { margin-top: 6px; text-align: right; }
.mr-dot-status {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  margin-right: 6px; vertical-align: 1px;
  background: var(--dsw-alias-label-secondary);
}
.mr-dot-status--warn { background: var(--dsw-alias-state-warn-primary); }
.mr-dot-status--error { background: var(--dsw-alias-state-error-primary); }
.mr-dot-status--success { background: var(--dsw-alias-state-success-primary); }
.mr-dot-status--brand { background: var(--dsw-alias-brand-primary); }
.mr-filelist { margin-top: 8px; }
.mr-filelist--muted { opacity: .85; }
.mr-filelist__label {
  margin: 0 0 6px; font-size: 11px; font-weight: 650;
  color: var(--dsw-alias-label-secondary);
}
.mr-filelist__ul {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px;
}
.mr-filelist__ul li {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  font-size: 11px;
}
.mr-filelist__name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.mr-filelist__size {
  flex: none; font-family: Consolas, monospace;
  color: var(--dsw-alias-label-secondary);
}

.mr-badge {
  flex: none; display: inline-flex; align-items: center;
  font-size: 11px; padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-style: normal;
}
.mr-badge i { font-style: normal; }
.mr-badge--warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mr-badge--error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.mr-badge--success { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.mr-badge--brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }

.mr-player { display: flex; flex-direction: column; gap: 8px; }
.mr-player__row { display: flex; align-items: center; gap: 10px; }
.mr-player__row .mr-audio { flex: 1; min-width: 0; }
.mr-player__clock {
  flex: none; min-width: 112px; text-align: right;
  font-family: Consolas, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.mr-seek {
  position: relative; height: 22px; border-radius: 8px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  cursor: pointer; touch-action: none;
}
.mr-seek:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mr-seek__band {
  position: absolute; top: 6px; height: 10px; border-radius: 2px;
  background: var(--dsw-alias-border-l2);
}
.mr-seek__fill {
  position: absolute; top: 0; bottom: 0; left: 0;
  background: var(--dsw-alias-brand-primary); opacity: .22;
}
.mr-seek__mark {
  position: absolute; top: 2px; bottom: 2px; width: 2px; margin-left: -1px;
  border-radius: 1px; background: var(--dsw-alias-state-warn-primary);
}
.mr-seek__head {
  position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%;
  margin-left: -6px; transform: translateY(-50%); pointer-events: none;
  background: var(--dsw-alias-brand-primary);
  border: 2px solid var(--dsw-alias-bg-base);
}
.mr-seek--dragging .mr-seek__head { transform: translateY(-50%) scale(1.25); }

.mr-mark__add { display: flex; align-items: center; gap: 8px; }
.mr-mark__add .mr-input { flex: 1; min-width: 0; }
.mr-mark__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mr-mark__item {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-bg-base);
}
.mr-mark__head { display: flex; align-items: center; gap: 10px; }
.mr-mark__time { font-family: Consolas, monospace; font-size: 12px; font-weight: 650; }
button.mr-mark__time {
  appearance: none; border: 0; background: transparent; padding: 0; cursor: pointer;
  color: var(--dsw-alias-brand-primary);
}
button.mr-mark__time:hover { text-decoration: underline; }
span.mr-mark__time { color: var(--dsw-alias-label-primary); }
.mr-mark__note { font-size: 12px; word-break: break-word; }
.mr-mark__spacer { flex: 1; }

.mr-recorder--paused .mr-recorder__clock { color: var(--dsw-alias-state-warn-primary); }
.mr-recorder--paused .mr-dot { background: var(--dsw-alias-state-warn-primary); }

.mr-engine {
  margin: 0 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mr-engine--ok { border-left-color: var(--dsw-alias-state-success-primary); }
.mr-engine--bad { border-left-color: var(--dsw-alias-state-error-primary); }
.mr-engine__copy p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.mr-engine__paths { display: flex; flex-direction: column; gap: 4px; margin: 0; }
.mr-engine__paths div { display: flex; gap: 8px; min-width: 0; }
.mr-engine__paths dt { flex: 0 0 88px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.mr-engine__paths dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mr-engine__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.mr-engine__log {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-sunken, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
`;

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return () => {};

      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);

      return () => {
        try {
          element.remove();
        } catch {
          /* 已被移除 */
        }
      };
    }

    // ------------------------------------------------------------ 插件定义

    return {
      inject: ['slots'],
      // 测试台专用：可带真实 props 渲染关键页，避免只测首页默认 tab。
      __test: {
        EmptyState,
        ExportView,
        HomeView,
        MeetingCard,
        MeetingRow,
        ProgressView,
        RecordingView,
        SpeakerManager,
      },
      apply(ctx) {
        clientCtx = ctx;

        const disposers = [];

        // 样式表
        disposers.push(injectStyles());

        // 侧边栏入口：点图标切到主面板（见 SidebarEntry）
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: () => '会议录音' },
              SidebarEntry,
            ),
          ),
        );

        // 整页主面板：key 与侧边栏入口 id 一致，layout.selectPanel 用同一个 key
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_KEY }, RecorderPanel),
          ),
        );

        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose?.();
            } catch {
              /* 已释放 */
            }
          }
        };
      },
    };
  },
});
