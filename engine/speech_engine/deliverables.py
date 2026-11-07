"""交付物生成入口，供插件 Host 半边调用。

用法：
    python -m speech_engine.deliverables --request <请求.json>
    python -m speech_engine.deliverables < 请求.json      # 也可从 stdin 读

输出：stdout 上一行一个 JSON 对象（JSON Lines）。
    {"type":"deliverables","files":[{"name":...,"path":...}]}
出错时输出 {"type":"error","message":...} 并以非零码退出。

两种模式：
    bundle（默认）：由转写结果生成讲话文字稿等交付物
    minutes：把 Agent 写好的 Markdown 纪要渲染成 Word（只做格式转换，不改内容）

为什么纪要要分两步：
    正式纪要需要判断"领导强调的核心观点是什么"，这是语义理解任务，不是格式转换。
    让程序去猜会产出编造内容，所以纪要正文交给 DSH Agent 按《纪要写法》撰写，
    本模块只负责把 Markdown 渲染成符合规范的 Word 版式。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from .docx_writers import write_minutes_docx, write_per_speaker_docx, write_timeline_docx
from .writers import render_merged_by_speaker, render_srt, render_timeline


def emit(payload: dict[str, Any]) -> None:
    """向 stdout 写一行 JSON。Host 半边按行解析，所以必须是单行。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    """诊断信息走 stderr，避免污染 stdout 的 JSON Lines 协议。"""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def load_request(path: str | None) -> dict[str, Any]:
    if path:
        text = Path(path).read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()

    if not text.strip():
        raise ValueError("请求内容为空")

    return json.loads(text)


def output_name(base: str, suffix: str) -> str:
    return f"{base}_{suffix}" if suffix else base


def run_bundle(request: dict[str, Any]) -> int:
    """由转写结果生成讲话文字稿与提纲。"""
    transcript_path = Path(request["transcriptJsonPath"])
    output_dir = Path(request["outputDir"])
    recording_path = request.get("recordingPath")

    want = request.get("want") or {}
    base_name = str(request.get("baseName") or "讲话文字稿")
    meeting = request.get("meeting") or {}

    if not transcript_path.is_file():
        emit({"type": "error", "message": f"找不到转写结果文件：{transcript_path}"})
        return 3

    result = json.loads(transcript_path.read_text(encoding="utf-8"))
    segments = result.get("segments") or []

    if not segments:
        emit({"type": "error", "message": "转写结果里没有任何段落，无法生成文字稿"})
        return 3

    # 说话人清单以段落内容为准，按首次出现顺序重算。
    # 不直接信任 result["speakers"]：那个字段可能是引擎的原始标签或字符串排序的结果
    # （"说话人10" 会排到 "说话人2" 前面），而用户在界面上改过名之后，
    # 只有段落里的名字才是最新的。重算一次保证文档前后完全自洽。
    ordered_speakers: list[str] = []
    seen_speakers: set[str] = set()

    for segment in segments:
        speaker = str(segment.get("speaker") or "说话人1").strip() or "说话人1"
        segment["speaker"] = speaker
        if speaker not in seen_speakers:
            seen_speakers.add(speaker)
            ordered_speakers.append(speaker)

    result["speakers"] = ordered_speakers

    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[dict[str, str]] = []

    def record(path: Path) -> None:
        written.append({"name": path.name, "path": str(path)})

    # 1) 录音文件：复制到交付目录，让整个交付物在一个文件夹里
    if want.get("recording", True) and recording_path:
        source = Path(recording_path)
        target = output_dir / "录音.wav"
        if source.is_file():
            if source.resolve() != target.resolve():
                try:
                    shutil.copy2(source, target)
                    record(target)
                except OSError as error:
                    log(f"复制录音文件失败（不影响文字稿）：{error}")
        else:
            log(f"找不到录音文件，跳过：{source}")

    # 2) 讲话文字稿 · 按时间（带上录音时按下的重点标记）
    if want.get("transcript", True):
        path = output_dir / f"{base_name}_按时间.docx"
        write_timeline_docx(
            result,
            path,
            meeting=meeting,
            speaker_names=None,
            title="会议讲话文字稿",
            marks=request.get("marks"),
        )
        record(path)

    # 3) 讲话文字稿 · 按人合并
    if want.get("transcriptBySpeaker", True):
        path = output_dir / f"{base_name}_按人合并.docx"
        write_per_speaker_docx(result, path, meeting=meeting, speaker_names=None)
        record(path)

    # 4) 纯文本稿
    if want.get("plainText"):
        path = output_dir / f"{base_name}_按时间.txt"
        path.write_text(render_timeline(segments, None), encoding="utf-8")
        record(path)

        path = output_dir / f"{base_name}_按人合并.txt"
        path.write_text(render_merged_by_speaker(segments, None), encoding="utf-8")
        record(path)

    # 5) SRT 字幕
    if want.get("subtitles"):
        path = output_dir / f"{base_name}.srt"
        path.write_text(render_srt(segments, None), encoding="utf-8")
        record(path)

    # 6) 提纲：Host 半边已把 Markdown 写进交付目录，这里只做 Word 渲染
    outline_markdown = output_dir / "会议发言要点提纲.md"
    if want.get("outline", True) and outline_markdown.is_file():
        try:
            text = outline_markdown.read_text(encoding="utf-8")
            path = output_dir / "会议发言要点提纲.docx"
            write_minutes_docx(text, path, meeting=meeting)
            record(path)
        except Exception as error:  # noqa: BLE001 - 提纲失败不该让整批交付物失败
            log(f"渲染提纲失败（其余交付物不受影响）：{error}")

    emit({"type": "deliverables", "files": written})
    return 0


def run_minutes(request: dict[str, Any]) -> int:
    """把 Agent 写好的 Markdown 纪要渲染成 Word。只做版式转换，不改内容。"""
    markdown_path = Path(request["markdownPath"])
    output_dir = Path(request["outputDir"])
    file_name = str(request.get("fileName") or "会议纪要.docx")
    meeting = request.get("meeting") or {}

    if not markdown_path.is_file():
        emit({"type": "error", "message": f"找不到纪要 Markdown：{markdown_path}"})
        return 3

    markdown = markdown_path.read_text(encoding="utf-8")

    if not markdown.strip():
        emit({"type": "error", "message": "纪要 Markdown 是空文件"})
        return 3

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / file_name

    write_minutes_docx(markdown, target, meeting=meeting)

    emit({"type": "deliverables", "files": [{"name": target.name, "path": str(target)}]})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="speech_engine.deliverables",
        description="生成会议交付物（讲话文字稿 / 纪要 Word 渲染）",
    )
    parser.add_argument("--request", help="请求 JSON 文件路径；省略时从 stdin 读")
    args = parser.parse_args(argv)

    try:
        request = load_request(args.request)
    except Exception as error:  # noqa: BLE001 - 参数问题要给出可读信息而不是堆栈
        emit({"type": "error", "message": f"读取请求失败：{error}"})
        return 2

    mode = str(request.get("mode") or "bundle")

    try:
        if mode == "minutes":
            return run_minutes(request)
        if mode == "bundle":
            return run_bundle(request)

        emit({"type": "error", "message": f"不支持的 mode：{mode}"})
        return 2
    except KeyError as error:
        emit({"type": "error", "message": f"请求缺少必需字段：{error}"})
        return 2
    except Exception as error:  # noqa: BLE001 - 顶层兜底，保证 Host 拿到结构化错误
        import traceback

        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "message": f"生成交付物失败：{error}"})
        return 4


if __name__ == "__main__":
    sys.exit(main())
