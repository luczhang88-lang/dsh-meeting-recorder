# speech_engine

本目录是会议录音插件自带的 FunASR 转写引擎源码。权重不在这里。

- 源码：`speech_engine/`
- 虚拟环境：在插件根目录运行 `scripts/setup.sh`、`scripts/setup.cmd` 或 `scripts/setup.ps1` 后出现 `.venv/`（不进 git）
- 模型缓存：默认 `models/`（setup 不加跳过参数时下载，或第一次转写时下载，约 2GB+，不进 git）

依赖装好后自检：

```bash
# Windows
.venv/Scripts/python -m speech_engine selfcheck
# macOS / Linux
.venv/bin/python -m speech_engine selfcheck
```

只预下载模型：

```bash
# Windows
.venv/Scripts/python -m speech_engine models --model-cache models
# macOS / Linux
.venv/bin/python -m speech_engine models --model-cache models
```

模型别名和许可见仓库根目录 `THIRD_PARTY.md`。本目录的 MIT 许可不覆盖模型权重。
