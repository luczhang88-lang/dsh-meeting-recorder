/**
 * 会议录音插件 · Host 入口。
 *
 * 插件形态：export function apply(ctx, config) —— Cordis 的标准 Host 插件。
 * 所有资源都在 apply 内注册，由 ctx.effect 管理生命周期，插件卸载时自动清理。
 *
 * 与 Client 半边的通信走 Connection 的 fetch 路由（见 host/transport.js 开头的说明）。
 * 依赖的服务是 connection，不再是 webServer：webServer 只服务 GET 页面，
 * 所有非 GET 在进入路由前就被拒，插件接口挂在它上面永远收不到 POST。
 *
 * 关于 config：
 *   故意不声明 export const Config。声明 Config 会启用 schema 校验，
 *   未在 schema 里的键可能被拒；而本插件的路径参数更适合让用户直接在
 *   cordis.patch.yml 的 config 里改，不做校验更灵活。
 *   代价是插件管理界面里不会显示可编辑的表单项，需要改 patch 文件。
 */

import { MeetingRecorder } from './host/recorder.js';
import { TranscriptionJobs } from './host/jobs.js';
import { Deliverables } from './host/deliverables.js';
import { RecorderTransport } from './host/transport.js';

/** 插件依赖的宿主服务。没有 Connection 的组装（例如纯 CLI）就不激活。 */
export const inject = ['connection'];

/** config 缺省值。用户在 cordis.patch.yml 里给的值会覆盖这里。 */
const DEFAULTS = {
  // 空字符串表示走 recorder 内的环境变量 / 平台默认探测，见 host/recorder.js
  engineRoot: '',
  modelCacheDir: '',
  meetingsRoot: '',
  defaultOutputDir: '',
  pythonPath: '',
  maxRecordingHours: 6,
};

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };

  const recorder = new MeetingRecorder(ctx, settings);
  const jobs = new TranscriptionJobs(recorder);
  // 传 ctx 进去：交付物模块要自己调 llm 写纪要，模型路由也从宿主服务上取
  const deliverables = new Deliverables(recorder, ctx);

  // 交付物模块要通过同一份任务数据读取用户在界面上做的修订
  recorder.jobs = jobs;

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* 没有 logger 也不能让插件崩掉 */
    }
  };

  const report = (message) => {
    try {
      ctx.logger?.error?.(message);
    } catch {
      /* 同上 */
    }
  };

  const transport = new RecorderTransport({
    recorder,
    jobs,
    deliverables,
    logger: { error: report },
  });

  ctx.effect(() => {
    const connection = ctx.get('connection');

    if (!connection || typeof connection.fetch?.register !== 'function') {
      warn('会议录音插件：当前组装没有 connection 服务，插件未激活。');
      return () => {};
    }

    const disposeRoutes = transport.register(connection);

    // 先把路由挂上，再异步建目录；建目录失败不影响界面报错提示
    recorder.start().catch((error) => {
      report(`会议录音插件：创建输出目录 ${recorder.root} 失败：${error.message}`);
    });

    return () => {
      try {
        disposeRoutes();
      } catch {
        /* 已释放 */
      }

      void recorder.stop().catch((error) => {
        warn(`会议录音插件：清理资源时出错：${error.message}`);
      });
    };
  }, 'meeting-recorder: connection routes');

  return { recorder, jobs, deliverables, transport };
}

export { MeetingRecorder, TranscriptionJobs, Deliverables, RecorderTransport };
