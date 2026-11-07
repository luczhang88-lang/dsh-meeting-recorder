# dsh-meeting-recorder

DeepSeek Harness 会议录音插件，带本机 FunASR 引擎源码。现场录音、导入音频、转写、说话人校对，并用 Harness 里已经配置好的模型写纪要、导出 Word。

Meeting recorder plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): live or imported audio, FunASR transcription, and Word minutes using the model already configured in Harness.

版本 `0.3.0`。作者 Luc Zhang（GitHub `luczhang88-lang`）。

装上插件**还不能转写**。Python 虚拟环境、依赖和模型权重都要在第一次使用前单独准备，它们不在 git 里，也不在 npm 包里。

最短步骤见 [INSTALL.md](./INSTALL.md)。模型许可见 [THIRD_PARTY.md](./THIRD_PARTY.md)。

---

## 中文

### 功能

- **现场录音**：浏览器采集本机麦克风（需权限；HTTPS 或 localhost）
- **后期导入**：wav / mp3 / m4a / flac / ogg 等；非 wav 先转 16 kHz 单声道再转写（需 **ffmpeg**）
- **本机转写**：仓库自带 `engine/speech_engine` + **FunASR**，音频默认不出本机
- **说话人分离**：自动聚类；校对页可改姓名、改分段归属
- **重点标记**：录音中打标记，写入文字稿章节
- **交付物**：讲话文字稿 Word、发言要点提纲 Word、正式《会议纪要》Word（纪要正文走 Harness 已配置的大模型）

### 仓库里有什么 / 没有什么

| 进 Git / npm 包 | 不进仓库（首次 setup 或首次转写时下载） |
| --- | --- |
| Harness 插件（Host + Client） | `engine/.venv`（约 1.3–1.5 GB） |
| `engine/speech_engine` Python 源码 | FunASR 模型权重（约 2 GB+，默认落到 `engine/models/`） |
| `engine/requirements.txt`、`scripts/setup.*` | `__pycache__`、本地会议录音、`.env`、密钥 |

### 系统要求

1. DeepSeek Harness **0.2.x**（`engines.dsh`: `>=0.2.0-rc.1 <0.3.0`）
2. **Node.js 20+**（只用于 `npx` 调用 `dsh` 安装插件）
3. **Python 3.10+**（setup 用它创建 `engine/.venv`）
4. 磁盘约 **4–6 GB** 空闲（venv + 模型）
5. 访问 **PyPI** 和 **ModelScope** 的网络（装依赖、下模型）
6. **ffmpeg**（导入 mp3/m4a 等时；现场录音写的是 WAV，可不装）
7. 麦克风权限（现场录音）

### 哪些步骤是自动的

| 步骤 | 谁来做 |
| --- | --- |
| 把插件登记进 Harness | 你执行 `dsh plugin add`，或在插件页安装 |
| 创建 venv、安装 torch 与 FunASR 依赖 | `scripts/setup.*`，或插件里的「只安装依赖」 |
| 下载约 2GB+ 模型 | 只有你不加 `--skip-models` / 不点「只安装依赖」时才会下载。插件按钮默认**不**下载。第一次转写也可能再试一次 |
| 现场录音、调用 Harness 大模型写纪要 | 依赖装好并且 Harness 已配置模型之后，在界面里操作 |

### 安装

引擎目录必须是 **Harness 正在加载的那一份插件** 旁边的 `engine/`。在另一份克隆里跑 setup，不会作用到已经装进 Harness 的副本。

#### 1. 克隆

```bash
git clone https://github.com/luczhang88-lang/dsh-meeting-recorder.git
cd dsh-meeting-recorder
```

#### 2. 在这份目录里准备引擎

Windows（会下载模型；失败则脚本失败）：

```bat
scripts\setup.cmd
```

Windows，只要依赖、先不下载模型：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipModels
```

macOS / Linux（会下载模型）：

```bash
bash scripts/setup.sh
```

macOS / Linux，只要依赖：

```bash
bash scripts/setup.sh --skip-models
```

macOS 上的 torch 从 PyPI 安装。Linux 和 Windows 使用 `https://download.pytorch.org/whl/cpu`。发布环境没有在 macOS 上实际跑过安装。

#### 3. 把同一目录装进 Harness

```bash
npx -y @deepseek-ai/dsh plugin --profile web add .
```

桌面版把 `web` 换成 `desktop`。然后**完全退出并重启** Harness。

如果 `dsh plugin add` 复制了一份插件、没有带上 `.venv`，打开「会议录音」，看页面上的插件目录，用那里的按钮安装。按钮只会运行该目录里的 `scripts/setup.sh` 或 `setup.ps1`，不会执行你输入的命令。

`dsh plugin add github:luczhang88-lang/dsh-meeting-recorder` 同样只装插件代码。装完后要在**加载出来的那份目录**里 setup，或者用插件里的按钮。不要再另克隆一份来装环境。

### 路径

默认（可在 `cordis.patch.yml` 里改，也可用环境变量覆盖）：

- `engineRoot` → 本插件目录下的 `engine/`
- `modelCacheDir` → `engine/models/`
- Python → `engine/.venv/Scripts/python.exe`（Windows）或 `engine/.venv/bin/python`（macOS / Linux）

环境变量：`MEETING_RECORDER_ENGINE_ROOT`、`MEETING_RECORDER_MODEL_CACHE`、`MEETING_RECORDER_PYTHON`、`MEETING_RECORDER_MEETINGS_ROOT`。

一旦改了 `engineRoot`，界面里的安装按钮会拒绝执行，避免把依赖装到插件没在用的目录。

### 使用

1. 侧边栏打开「会议录音」
2. 若页面提示引擎未就绪，先安装依赖
3. 「现场录音」或「导入录音」
4. 停录后自动转写 →「校对」→「交付」

### 别人怎么发现这个插件

GitHub topic `dsh-plugin` 只是公开仓库上的社区标签，方便在 https://github.com/topics/dsh-plugin 里被找到。它**不保证**某个插件市场会自动收录。

可以这样安装（仓库公开之后）：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:luczhang88-lang/dsh-meeting-recorder
```

然后仍要完成本机 setup。`market-entry.json` 是给自己的 dsh-market 目录合并用的示例，本仓库不会写入你电脑上的市场文件。npm 包名是 `dsh-meeting-recorder`，这次发布**没有**执行 `npm publish`。

### 许可

插件与引擎封装代码是 MIT。FunASR 库是 MIT，ModelScope 库是 Apache-2.0。模型权重不在本仓库里，也不能把上面的 MIT 当成权重许可。细节见 [THIRD_PARTY.md](./THIRD_PARTY.md)。

---

## English

### Features

- **Live recording** via the browser microphone (HTTPS or localhost)
- **Import later**: wav / mp3 / m4a / flac / ogg; non-wav needs **ffmpeg**
- **Local ASR** via bundled `engine/speech_engine` + **FunASR** (audio stays on-device by default)
- **Speaker diarization** with a proofreading UI
- **Markers** during recording
- **Word deliverables**: transcripts, talking points, and formal minutes (the minutes body uses the LLM already configured in Harness)

### What ships / what downloads

| In git and the npm package | Not shipped (first setup or first transcription) |
| --- | --- |
| Harness plugin (Host + Client) | `engine/.venv` (~1.3–1.5 GB) |
| `engine/speech_engine` sources | FunASR weights (~2 GB+, default `engine/models/`) |
| `requirements.txt`, `scripts/setup.*` | caches, recordings, secrets |

### Requirements

1. DeepSeek Harness **0.2.x**
2. **Node.js 20+** for the `npx` install command
3. **Python 3.10+**
4. ~**4–6 GB** free disk
5. Network access to **PyPI** and **ModelScope**
6. **ffmpeg** for compressed imports
7. Microphone permission for live capture

### What is automated

Adding the plugin does not install Python dependencies or download models. `scripts/setup.*` creates the venv and installs dependencies. Model download runs only when you omit `--skip-models` / `-SkipModels`. The in-plugin button does not download models unless you choose the separate action. A failed model download fails the script.

### Install

The engine Harness uses is the `engine/` directory **next to the loaded plugin files**. Setup in a different clone does not affect that copy.

```bash
git clone https://github.com/luczhang88-lang/dsh-meeting-recorder.git
cd dsh-meeting-recorder
```

Windows, including the model download:

```bat
scripts\setup.cmd
```

Windows, dependencies only:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipModels
```

macOS / Linux, including the model download:

```bash
bash scripts/setup.sh
```

macOS / Linux, dependencies only:

```bash
bash scripts/setup.sh --skip-models
```

On macOS, torch comes from PyPI. On Linux and Windows it comes from `https://download.pytorch.org/whl/cpu`. The publishing environment did not run the macOS installer.

Then install this same directory and fully quit Harness:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add .
```

Use `desktop` instead of `web` for the desktop app. If Harness copied the plugin without `.venv`, open Meeting Recorder and press **只安装依赖**. The model download button is **安装依赖并下载模型**. Both run only the bundled setup script in the loaded plugin directory.

`dsh plugin add github:luczhang88-lang/dsh-meeting-recorder` installs the plugin code only. Run setup in the loaded copy, or use the button. Do not point a second clone at it.

### Paths

Defaults: `engineRoot` is `<plugin>/engine`, `modelCacheDir` is `<plugin>/engine/models`, Python is `.venv` inside that engine. Override with `MEETING_RECORDER_ENGINE_ROOT`, `MEETING_RECORDER_MODEL_CACHE`, `MEETING_RECORDER_PYTHON`, or `MEETING_RECORDER_MEETINGS_ROOT`. A custom `engineRoot` disables the in-plugin setup button.

### Discovery

The GitHub topic `dsh-plugin` is a community label (https://github.com/topics/dsh-plugin). It does not by itself insert the plugin into every market index. `market-entry.json` is a sample record for a local catalog merge. This release does not publish to npm.

### License

Project code is MIT. FunASR is MIT. ModelScope is Apache-2.0. Model weights are not in this repo and are not covered by this MIT license. See [THIRD_PARTY.md](./THIRD_PARTY.md).
