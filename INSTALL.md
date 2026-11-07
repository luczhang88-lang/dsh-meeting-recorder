# 安装

装完插件还要准备本机 Python 环境。依赖和模型不在仓库里。引擎必须装在 **Harness 加载的那一份插件目录** 里。

前置：DeepSeek Harness 0.2.x、Node.js 20+、Python 3.10+、约 4–6 GB 磁盘、能访问 PyPI 与 ModelScope。导入 mp3/m4a 另需 ffmpeg。现场录音需要麦克风权限。

## 克隆这份目录并在这里安装

```bash
git clone https://github.com/luczhang88-lang/dsh-meeting-recorder.git
cd dsh-meeting-recorder
```

Windows，安装依赖并下载模型（约 2GB+）。下载失败时脚本失败：

```bat
scripts\setup.cmd
```

Windows，只装依赖：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipModels
```

macOS / Linux，安装依赖并下载模型：

```bash
bash scripts/setup.sh
```

macOS / Linux，只装依赖：

```bash
bash scripts/setup.sh --skip-models
```

macOS 的 PyTorch 从 PyPI 安装，因为 CPU 索引没有 macOS wheel。Linux / Windows 使用 `https://download.pytorch.org/whl/cpu`。发布时没有在 macOS 上跑过这条命令。

把**同一目录**装进 Harness：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add .
```

桌面版把 `web` 换成 `desktop`。完全退出并重启 Harness，再打开「会议录音」。

如果 Harness 复制插件时丢掉了 `.venv`，以界面上显示的插件目录为准。点「只安装依赖」不会下载模型；点「安装依赖并下载模型」才会下载约 2GB+ 权重。页面显示脚本输出和退出码。

## 从 GitHub 规格安装

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:luczhang88-lang/dsh-meeting-recorder
```

这只把插件代码放到 Harness 的插件目录。打开「会议录音」，在页面显示的目录里安装依赖。不要另外克隆一份仓库再指望默认 `engineRoot` 指向它。

跳过模型时，第一次转写会再尝试从 ModelScope 下载。那一次下载失败会显示转写错误，不会假装已经就绪。

## English

Installing the plugin does not install Python packages or model weights. Setup must run in the plugin directory Harness actually loads.

Prerequisites: DeepSeek Harness 0.2.x, Node.js 20+, Python 3.10+, about 4–6 GB free disk, and network access to PyPI and ModelScope. Compressed imports also need ffmpeg.

```bash
git clone https://github.com/luczhang88-lang/dsh-meeting-recorder.git
cd dsh-meeting-recorder
```

Windows, with model download:

```bat
scripts\setup.cmd
```

Windows, dependencies only:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipModels
```

macOS / Linux, with model download:

```bash
bash scripts/setup.sh
```

macOS / Linux, dependencies only:

```bash
bash scripts/setup.sh --skip-models
```

macOS installs torch from PyPI. Linux and Windows use the PyTorch CPU index. The macOS command was not executed during publishing.

```bash
npx -y @deepseek-ai/dsh plugin --profile web add .
```

Fully quit and restart Harness. If the loaded copy has no `.venv`, open Meeting Recorder and press **只安装依赖**. Press **安装依赖并下载模型** only when you want the about-2GB download. The page shows the script output and exit code.

GitHub install loads code only:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:luczhang88-lang/dsh-meeting-recorder
```

Run setup in the directory shown in the plugin, not in a second clone.
