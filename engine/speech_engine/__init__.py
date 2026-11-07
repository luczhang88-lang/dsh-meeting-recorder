"""DSH 会议录音插件 · 本地语音引擎。

对外只暴露三件事：转写（transcribe_file）、把结果写成文本/字幕（writers）、
以及排版成 Word 交付物（docx_writers）。插件 Host 通过 CLI 调用本包。
"""

from .pipeline import EngineConfig, TranscriptionError, transcribe_file

__all__ = ["EngineConfig", "TranscriptionError", "transcribe_file", "__version__"]

__version__ = "0.3.0"
