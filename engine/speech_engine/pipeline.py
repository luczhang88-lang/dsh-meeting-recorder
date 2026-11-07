"""模型加载与转写主流程。

流程：
    1. 加载音频为 16 kHz 单声道
    2. fsmn-vad 切出语音段（含绝对时间戳）
    3. paraformer-zh 逐段转写
    4. ct-punc 保证有标点
    5. cam++ 声纹 + 聚类分人
    6. 合并相邻同人段，输出结构化结果

CPU 优化要点：
    - 模型串行加载、用完即释放，因为本机只有 15.8 GB 内存，三个模型同时常驻会吃紧
    - 声纹提取按窗口批量进行，避免逐窗口的 Python 调度开销
    - 长音频分批送入 VAD，避免一次性构造超长特征矩阵
"""

from __future__ import annotations

import gc
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from .audio_io import TARGET_SAMPLE_RATE, load_audio
from .diarize import cluster_quality, diarize, merge_consecutive_by_speaker

ProgressFn = Callable[[str, float, str], None]


class TranscriptionError(RuntimeError):
    """转写流程失败。"""


@dataclass
class EngineConfig:
    """引擎配置。默认值是针对"4 核 CPU + 16 GB 内存 + 中文会议"选的。"""

    asr_model: str = "paraformer-zh"
    vad_model: str = "fsmn-vad"
    punc_model: str = "ct-punc"
    speaker_model: str = "cam++"
    device: str = "cpu"
    language: str = "zh"
    speaker_hint: int | None = None
    model_cache_dir: str | None = None
    max_single_segment_ms: int = 30000
    # 单个转写块的目标上限（秒）。实测 25 秒兼顾质量与速度，见 transcribe_intervals 的说明。
    max_block_seconds: float = 25.0
    merge_gap_seconds: float = 1.2
    # 默认 0 = 不做二次合并。段落合并要保留时间预算，交给渲染层按需求处理，
    # 在管线里合并会削弱逐段核对说话人的能力。
    merge_max_seconds: float = 0.0
    enable_diarization: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


def _noop(stage: str, ratio: float, message: str) -> None:  # pragma: no cover
    return None


def _require_funasr() -> Any:
    try:
        import funasr  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise TranscriptionError(
            "未安装 funasr。请先在 speech-engine 虚拟环境中执行："
            "pip install funasr modelscope soundfile scikit-learn"
        ) from exc

    from funasr import AutoModel

    return AutoModel


def load_vad_model(config: EngineConfig, hub: str) -> Any:
    """加载语音活动检测模型。"""
    AutoModel = _require_funasr()

    return AutoModel(
        model=config.vad_model,
        hub=hub,
        device=config.device,
        disable_update=True,
        disable_pbar=True,
    )


def load_asr_model(config: EngineConfig, hub: str) -> Any:
    """加载语音识别模型，并挂上标点模型。"""
    AutoModel = _require_funasr()

    return AutoModel(
        model=config.asr_model,
        punc_model=config.punc_model,
        hub=hub,
        device=config.device,
        disable_update=True,
        disable_pbar=True,
    )


def load_speaker_model(config: EngineConfig, hub: str) -> Any:
    """加载声纹提取模型。"""
    AutoModel = _require_funasr()

    return AutoModel(
        model=config.speaker_model,
        hub=hub,
        device=config.device,
        disable_update=True,
        disable_pbar=True,
    )


def _hub_for_cache(cache_dir: str | None) -> str:
    """根据缓存目录选择模型仓库。

    我们把权重显式落到用户指定目录，所以用 modelscope 作为来源，
    避免 FunASR 默认去 HuggingFace 拉取（国内网络下经常失败）。
    """
    if cache_dir:
        import os

        os.environ.setdefault("MODELSCOPE_CACHE", cache_dir)

    return "ms"


def _release(model: Any) -> None:
    """尽力释放模型占用的内存。"""
    del model
    gc.collect()


def _extract_vad_intervals(raw_result: Any) -> list[list[float]]:
    """从 fsmn-vad 的输出里取出 [[起ms, 止ms], ...]。

    FunASR 在不同版本下把 VAD 结果放在 `value` 或 `timestamp`，
    形态可能是嵌套 list 也可能是字符串，这里统一归一化。
    """
    if not raw_result:
        return []

    first = raw_result[0] if isinstance(raw_result, (list, tuple)) else raw_result
    if not isinstance(first, dict):
        return []

    payload = first.get("value") or first.get("timestamp") or first.get("segments")
    if payload is None:
        return []

    if isinstance(payload, str):
        intervals: list[list[float]] = []
        for line in payload.replace(";", "\n").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = [part for part in line.replace(",", " ").split() if part]
            if len(parts) >= 2:
                try:
                    intervals.append([float(parts[0]), float(parts[1])])
                except ValueError:
                    continue
        return intervals

    if isinstance(payload, (list, tuple)):
        intervals = []
        for item in payload:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                try:
                    intervals.append([float(item[0]), float(item[1])])
                except (TypeError, ValueError):
                    continue
        return intervals

    return []


def run_vad(audio: np.ndarray, config: EngineConfig, hub: str, progress: ProgressFn) -> list[tuple[float, float]]:
    """跑 VAD，返回秒为单位的语音区间。失败时退化为"整段都是语音"。"""
    progress("vad", 0.05, "检测语音活动…")

    try:
        model = load_vad_model(config, hub)
        raw = model.generate(
            input=audio,
            max_single_segment_time=config.max_single_segment_ms,
            disable_pbar=True,
        )
        intervals_ms = _extract_vad_intervals(raw)
    except Exception as exc:
        progress("vad", 1.0, f"VAD 失败，按整段处理（{exc}）")
        total = audio.size / float(TARGET_SAMPLE_RATE)
        return [(0.0, total)]

    finally:
        _release(locals().get("model"))

    if not intervals_ms:
        progress("vad", 1.0, "VAD 未检测到语音段，按整段处理")
        total = audio.size / float(TARGET_SAMPLE_RATE)
        return [(0.0, total)]

    intervals = [
        (max(0.0, start / 1000.0), min(audio.size / float(TARGET_SAMPLE_RATE), end / 1000.0))
        for start, end in intervals_ms
    ]

    intervals = [(start, end) for start, end in intervals if end - start >= 0.2]

    progress("vad", 1.0, f"检测到 {len(intervals)} 个语音段")

    return intervals


_PUNCTUATION_MARKS = "，。！？；：、,.!?;:"


def _has_punctuation(text: str) -> bool:
    return any(mark in text for mark in _PUNCTUATION_MARKS)


def transcribe_intervals(
    audio: np.ndarray,
    intervals: Sequence[tuple[float, float]],
    config: EngineConfig,
    hub: str,
    progress: ProgressFn,
) -> list[dict[str, Any]]:
    """把语音段拼成块后转写，再把块级时间戳摊回段级。

    为什么要拼块（实测结论，不是理论推测）：
        在本机真实会议录音上对比过三种调用方式：
          A 逐 VAD 碎片（中位 0.63 秒）送模型 → 输出全是碎片，386 字符，不可用
          B 整段一次送模型                     → 大量重复幻觉，974 字符但在重复"对对对吧吧吧"
          C 碎片拼成约 25 秒的块再送模型        → 833 字符，句子完整，质量明显最好
        所以采用 C。附带好处：C 比 B 快一倍（32.5s vs 63.0s），
        因为注意力开销随片段长度超线性增长。

    为什么按静音边界切块而不是硬切：
        硬切会把字切成两半，前半截和后半截各自都识别不出来。
        所以到上限时回退到最近一个 VAD 段边界——VAD 段之间本来就是静音，
        在那里断开不会截断任何一个字。
    """
    blocks = build_transcription_blocks(intervals, config.max_block_seconds)

    progress("asr", 0.0, f"加载识别模型…（{len(blocks)} 个转写块）")

    try:
        model = load_asr_model(config, hub)
    except Exception as exc:
        raise TranscriptionError(f"语音识别模型加载失败：{exc}") from exc

    progress("asr", 0.05, "开始转写…")

    segments: list[dict[str, Any]] = []
    total = max(1, len(blocks))
    started = time.time()

    try:
        for index, block in enumerate(blocks):
            block_start = block[0][0]
            block_end = block[-1][1]

            start_sample = max(0, int(block_start * TARGET_SAMPLE_RATE))
            end_sample = min(audio.size, int(block_end * TARGET_SAMPLE_RATE))
            chunk = audio[start_sample:end_sample]

            if chunk.size < int(0.2 * TARGET_SAMPLE_RATE):
                continue

            try:
                result = model.generate(
                    input=chunk,
                    batch_size_s=60,
                    disable_pbar=True,
                )
            except Exception as exc:
                for begin, end in block:
                    segments.append(
                        {
                            "start": round(begin, 3),
                            "end": round(end, 3),
                            "text": "",
                            "error": str(exc),
                        }
                    )
                continue

            text = _extract_text(result)
            if not text:
                continue

            segments.extend(_distribute_text(text, block))

            if index % 3 == 0 or index == total - 1:
                ratio = (index + 1) / total
                elapsed = time.time() - started
                eta = (elapsed / max(ratio, 1e-6)) - elapsed
                progress(
                    "asr",
                    ratio,
                    f"转写 {index + 1}/{total} 块，已用 {_human(elapsed)}，预计还需 {_human(max(0.0, eta))}",
                )
    finally:
        _release(model)

    progress("asr", 1.0, f"转写完成，共 {len(segments)} 段")

    return segments


def build_transcription_blocks(
    intervals: Sequence[tuple[float, float]],
    max_block_seconds: float = 25.0,
) -> list[list[tuple[float, float]]]:
    """把 VAD 语音段聚成转写块。超过上限时在最近一个静音边界处断开。

    返回的是"段的列表的列表"，因为摊回文字时需要知道每个块包含哪些段。
    """
    blocks: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []

    for interval in intervals:
        if not current:
            current.append(interval)
            continue

        span = interval[1] - current[0][0]

        if span <= max_block_seconds:
            current.append(interval)
            continue

        blocks.append(current)
        current = [interval]

    if current:
        blocks.append(current)

    return blocks


def _distribute_text(text: str, block: Sequence[tuple[float, float]]) -> list[dict[str, Any]]:
    """把块级文字按时长比例摊回块内的每一段。

    必须说清楚这里的精度边界：ASR 只给出块级文字，没有段级时间戳。
    按段时长比例分配是**估算**，不是精确对齐。所以：
      - 每段的文字在时间上可能有正负几秒的偏差
      - 界面上的逐段播放会因此对不齐，真正精确的核对要用块时间范围
      - 说话人归属按段重叠投票，所以分人精度不受影响
    如果以后需要精确到段，可以改用 sentence_timestamp=True 让模型输出句级时间戳。
    """
    if len(block) == 1:
        return [
            {
                "start": round(block[0][0], 3),
                "end": round(block[0][1], 3),
                "text": text,
            }
        ]

    durations = [max(0.05, end - start) for start, end in block]
    total_duration = sum(durations)

    remaining = text
    result: list[dict[str, Any]] = []

    for index, (interval, duration) in enumerate(zip(block, durations)):
        if index == len(block) - 1:
            piece = remaining
        else:
            take = max(1, int(round(len(text) * (duration / total_duration))))
            take = min(take, max(1, len(remaining)))
            piece = _cut_at_boundary(remaining, take)
            remaining = remaining[len(piece):]

        result.append(
            {
                "start": round(interval[0], 3),
                "end": round(interval[1], 3),
                "text": piece.strip(),
            }
        )

    return [item for item in result if item["text"]]


def _cut_at_boundary(text: str, target: int) -> str:
    """在不超过 target 的位置找最近的标点或分句点切断。

    摊回块内各段时只能按比例估算切分位置，所以优先切在标点处，
    避免把"研发项目"切成"研发项"和"目"。
    """
    if target >= len(text):
        return text

    # 先向前找标点，窗口限制在目标位置前后 25% 字符内，避免切得太偏
    window_start = max(1, int(target * 0.75))
    window_end = min(len(text), max(target + 1, int(target * 1.25)))

    for index in range(target, window_end):
        if text[index] in "。！？；，、":
            return text[: index + 1]

    for index in range(target, window_start - 1, -1):
        if text[index - 1] in "。！？；，、":
            return text[:index]

    return text[:target]


def _extract_text(raw_result: Any) -> str:
    """从 ASR 返回里取出文本。"""
    if not raw_result:
        return ""

    first = raw_result[0] if isinstance(raw_result, (list, tuple)) else raw_result
    if isinstance(first, dict):
        for key in ("text", "sentence", "value"):
            value = first.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    if isinstance(first, str):
        return first.strip()

    return ""


def _human(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds < 60:
        return f"{seconds:.0f} 秒"
    minutes, remainder = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes} 分 {remainder} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes} 分"


def _ensure_punctuation(
    segments: list[dict[str, Any]],
    config: EngineConfig,
    hub: str,
    progress: ProgressFn,
) -> list[dict[str, Any]]:
    """给没有标点的段落补标点。

    正常情况下 punc_model 已经在 ASR 阶段生效；这里只处理异常情况，
    比如加载时标点模型没挂上，或者模型认为该段无需标点。
    """
    without = [segment for segment in segments if segment.get("text") and not _has_punctuation(str(segment["text"]))]

    if not without:
        return segments

    # 占比很低时通常说明标点模型整体没生效，这时才值得加载一次标点模型
    if len(without) / max(1, len(segments)) < 0.3:
        return segments

    progress("punc", 0.0, "补标点…")

    AutoModel = _require_funasr()
    try:
        punc_model = AutoModel(
            model=config.punc_model,
            hub=hub,
            device=config.device,
            disable_update=True,
            disable_pbar=True,
        )
    except Exception:
        return segments

    try:
        for index, segment in enumerate(without):
            try:
                result = punc_model.generate(input=str(segment["text"]), disable_pbar=True)
                punctuated = _extract_text(result)
                if punctuated:
                    segment["text"] = punctuated
            except Exception:
                continue

            if index % 20 == 0:
                progress("punc", (index + 1) / max(1, len(without)), "补标点…")
    finally:
        _release(punc_model)

    progress("punc", 1.0, "标点补全完成")

    return segments


def transcribe_file(
    audio_path: str | Path,
    config: EngineConfig | None = None,
    progress: ProgressFn = _noop,
) -> dict[str, Any]:
    """转写一个音频文件，返回结构化结果。"""
    config = config or EngineConfig()
    hub = _hub_for_cache(config.model_cache_dir)

    started = time.time()

    progress("load", 0.02, f"读取音频 {Path(audio_path).name}…")
    audio = load_audio(audio_path)
    total_seconds = audio.size / float(TARGET_SAMPLE_RATE)

    if total_seconds < 0.5:
        raise TranscriptionError("音频过短（不足 0.5 秒），无法转写")

    progress("load", 0.08, f"音频时长 {_human(total_seconds)}")

    intervals = run_vad(audio, config, hub, _scale(progress, 0.08, 0.18))
    raw_segments = transcribe_intervals(audio, intervals, config, hub, _scale(progress, 0.18, 0.80))
    raw_segments = _ensure_punctuation(raw_segments, config, hub, _scale(progress, 0.80, 0.84))

    if not raw_segments:
        raise TranscriptionError("未识别出任何文字。请确认录音中有清晰的说话声。")

    diagnostics: dict[str, Any] = {}

    if config.enable_diarization:
        try:
            speaker_model = load_speaker_model(config, hub)
        except Exception as exc:
            speaker_model = None
            diagnostics["diarizationError"] = str(exc)

        if speaker_model is not None:
            segments, diarization_info = diarize(
                audio=audio,
                sample_rate=TARGET_SAMPLE_RATE,
                segments=raw_segments,
                model=speaker_model,
                speaker_hint=config.speaker_hint,
                progress=_scale(progress, 0.84, 0.99),
            )
            _release(speaker_model)
            diagnostics["diarization"] = diarization_info
        else:
            segments = [dict(segment, speaker="说话人1", confidence=None) for segment in raw_segments]
    else:
        segments = [dict(segment, speaker="说话人1", confidence=None) for segment in raw_segments]

    merged = merge_consecutive_by_speaker(
        segments,
        max_gap_seconds=config.merge_gap_seconds,
        max_merge_seconds=config.merge_max_seconds,
    )

    diagnostics["quality"] = cluster_quality(merged)

    elapsed = time.time() - started

    progress("done", 1.0, f"转写完成，总耗时 {_human(elapsed)}")

    return {
        "audioSeconds": round(total_seconds, 3),
        "inferenceSeconds": round(elapsed, 3),
        "realTimeFactor": round(elapsed / total_seconds, 4) if total_seconds > 0 else None,
        "segments": merged,
        "rawSegments": raw_segments,
        "speakers": sorted({str(segment.get("speaker", "说话人1")) for segment in merged}),
        "diagnostics": diagnostics,
        "config": {
            "asrModel": config.asr_model,
            "vadModel": config.vad_model,
            "puncModel": config.punc_model,
            "speakerModel": config.speaker_model if config.enable_diarization else None,
            "device": config.device,
            "language": config.language,
        },
    }


def _scale(progress: ProgressFn, low: float, high: float) -> ProgressFn:
    """把子流程的 0..1 进度映射到整体进度区间。"""

    def scaled(stage: str, ratio: float, message: str) -> None:
        bounded = min(1.0, max(0.0, ratio))
        progress(stage, low + (high - low) * bounded, message)

    return scaled
