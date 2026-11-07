"""把转写结果写成各种纯文本形态。

三种形态各有用途：
    txt        给人读的时间轴稿（[00:12:33] 张三：……）
    txt_merged 按人合并，便于单看某位领导的完整观点
    srt        带说话人前缀的字幕，方便对着录音核对
    json       给界面用的完整数据
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence


def format_timestamp(seconds: float, with_millis: bool = False) -> str:
    """秒 → HH:MM:SS 或 HH:MM:SS,mmm。"""
    seconds = max(0.0, float(seconds))
    hours, remainder = divmod(int(seconds), 3600)
    minutes, secs = divmod(remainder, 60)

    if with_millis:
        millis = int(round((seconds - int(seconds)) * 1000))
        if millis == 1000:
            millis = 0
            secs += 1
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def format_clock(seconds: float) -> str:
    """秒 → 人类可读时长（用于会议里说"这段讲了 12 分 30 秒"）。"""
    seconds = max(0.0, float(seconds))
    minutes, secs = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes} 分 {secs} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes} 分"


def compact_timestamp(seconds: float) -> str:
    """秒 → 简短时间戳（00:12:33），用于每段行首。"""
    return format_timestamp(seconds)


def render_timeline(
    segments: Sequence[dict[str, Any]],
    speaker_names: dict[str, str] | None = None,
) -> str:
    """按时间顺序渲染，每段一行「[时间] 说话人：内容」。"""
    names = speaker_names or {}
    lines: list[str] = []

    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = names.get(str(segment.get("speaker", "")), str(segment.get("speaker", "说话人1")))
        start = compact_timestamp(float(segment.get("start", 0.0)))
        lines.append(f"[{start}] {speaker}：")
        lines.append(text)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_merged_by_speaker(
    segments: Sequence[dict[str, Any]],
    speaker_names: dict[str, str] | None = None,
    max_gap_seconds: float = 30.0,
) -> str:
    """按人合并：同一人 30 秒内的发言并成一段，段首标出起始时间。

    这样领导汇报的完整逻辑链不会被切碎，同时仍保留时间定位。
    """
    names = speaker_names or {}

    blocks: list[dict[str, Any]] = []

    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = str(segment.get("speaker", "说话人1"))
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))

        if blocks:
            last = blocks[-1]
            if last["speaker"] == speaker and start - float(last["end"]) <= max_gap_seconds:
                joiner = " " if last["text"][-1:].isascii() and text[:1].isascii() else ""
                last["text"] = f"{last['text']}{joiner}{text}"
                last["end"] = end
                continue

        blocks.append({"speaker": speaker, "start": start, "end": end, "text": text})

    lines: list[str] = []
    for block in blocks:
        speaker = names.get(str(block["speaker"]), str(block["speaker"]))
        start = compact_timestamp(float(block["start"]))
        end = compact_timestamp(float(block["end"]))
        lines.append(f"{speaker}（{start} — {end}）：")
        lines.append(str(block["text"]).strip())
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_per_speaker_sections(
    segments: Sequence[dict[str, Any]],
    speaker_names: dict[str, str] | None = None,
) -> str:
    """把每个人的所有发言集中到一个小节，便于单独查看某人观点。"""
    names = speaker_names or {}

    order: list[str] = []
    grouped: dict[str, list[dict[str, Any]]] = {}

    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = str(segment.get("speaker", "说话人1"))
        if speaker not in grouped:
            grouped[speaker] = []
            order.append(speaker)

        grouped[speaker].append(segment)

    def total_seconds(speaker: str) -> float:
        return sum(float(item.get("end", 0)) - float(item.get("start", 0)) for item in grouped[speaker])

    order.sort(key=total_seconds, reverse=True)

    lines: list[str] = []
    for speaker in order:
        display = names.get(speaker, speaker)
        lines.append(f"【{display}】发言合计 {format_clock(total_seconds(speaker))}")
        lines.append("")

        for segment in grouped[speaker]:
            start = compact_timestamp(float(segment.get("start", 0.0)))
            lines.append(f"[{start}] {str(segment['text']).strip()}")

        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_srt(
    segments: Sequence[dict[str, Any]],
    speaker_names: dict[str, str] | None = None,
) -> str:
    """渲染为 SRT 字幕，字幕内容前带说话人名。"""
    names = speaker_names or {}
    blocks: list[str] = []
    index = 1

    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = names.get(str(segment.get("speaker", "")), str(segment.get("speaker", "")))
        start = format_timestamp(float(segment.get("start", 0.0)), with_millis=True)
        end = format_timestamp(float(segment.get("end", 0.0)), with_millis=True)

        blocks.append(f"{index}")
        blocks.append(f"{start} --> {end}")
        blocks.append(f"{speaker}：{text}")
        blocks.append("")

        index += 1

    return "\n".join(blocks).rstrip() + "\n"


def speaker_summary(
    result: dict[str, Any],
    speaker_names: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """统计每位说话人的发言时长和占比，用于界面展示和纪要参考。"""
    names = speaker_names or {}
    totals: dict[str, dict[str, Any]] = {}

    for segment in result.get("segments", []):
        speaker = str(segment.get("speaker", "说话人1"))
        entry = totals.setdefault(speaker, {"speaker": speaker, "seconds": 0.0, "segments": 0, "chars": 0})
        entry["seconds"] += float(segment.get("end", 0.0)) - float(segment.get("start", 0.0))
        entry["segments"] += 1
        entry["chars"] += len(str(segment.get("text", "")))

    total_seconds = sum(entry["seconds"] for entry in totals.values()) or 1.0

    summary: list[dict[str, Any]] = []
    for speaker, entry in sorted(totals.items(), key=lambda item: item[1]["seconds"], reverse=True):
        summary.append(
            {
                "speaker": speaker,
                "name": names.get(speaker, speaker),
                "seconds": round(entry["seconds"], 2),
                "duration": format_clock(entry["seconds"]),
                "share": round(entry["seconds"] / total_seconds, 4),
                "segments": entry["segments"],
                "chars": entry["chars"],
            }
        )

    return summary


def write_text_files(
    result: dict[str, Any],
    output_dir: str | Path,
    base_name: str,
    speaker_names: dict[str, str] | None = None,
) -> dict[str, str]:
    """把文字稿的各种形态落盘，返回"形态 → 路径"。"""
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)

    written: dict[str, str] = {}

    timeline = directory / f"{base_name}_按时间.txt"
    timeline.write_text(render_timeline(result["segments"], speaker_names), encoding="utf-8")
    written["timeline"] = str(timeline)

    merged = directory / f"{base_name}_按人合并.txt"
    merged.write_text(render_merged_by_speaker(result["segments"], speaker_names), encoding="utf-8")
    written["merged"] = str(merged)

    sections = directory / f"{base_name}_按人分组.txt"
    sections.write_text(render_per_speaker_sections(result["segments"], speaker_names), encoding="utf-8")
    written["sections"] = str(sections)

    subtitles = directory / f"{base_name}.srt"
    subtitles.write_text(render_srt(result["segments"], speaker_names), encoding="utf-8")
    written["srt"] = str(subtitles)

    return written
