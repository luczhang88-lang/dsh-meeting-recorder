"""命令行入口。插件 Host 通过子进程调用它。

约定：
    - stdout 只输出机器可读的 JSON Lines（进度、结果），人看的日志走 stderr
    - 这样 Node 端可以边读边更新界面进度，不需要猜输出格式
    - 退出码：0 成功、2 参数错误、3 环境缺失、4 转写失败
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Sequence

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_ENVIRONMENT = 3
EXIT_TRANSCRIPTION = 4


def emit(event_type: str, **payload: Any) -> None:
    """输出一行 JSON，立刻刷盘，保证 Node 能实时读到。"""
    record = {"type": event_type, "at": round(time.time(), 3)}
    record.update(payload)
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="speech-engine",
        description="会议录音本地转写引擎（FunASR，CPU）",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe = subparsers.add_parser("transcribe", help="转写音频文件")
    transcribe.add_argument("--audio", required=True, help="音频文件路径")
    transcribe.add_argument("--out", required=True, help="转写结果 JSON 输出路径")
    transcribe.add_argument("--speakers", type=int, default=None, help="已知说话人数量（留空则自动判断）")
    transcribe.add_argument("--model-cache", default=None, help="模型权重缓存目录")
    transcribe.add_argument("--device", default="cpu", help="推理设备，默认 cpu")
    transcribe.add_argument("--no-diarization", action="store_true", help="跳过分人，只出文字")
    transcribe.add_argument("--asr-model", default="paraformer-zh", help="ASR 模型名")
    transcribe.add_argument("--vad-model", default="fsmn-vad", help="VAD 模型名")
    transcribe.add_argument("--punc-model", default="ct-punc", help="标点模型名")
    transcribe.add_argument("--speaker-model", default="cam++", help="声纹模型名")
    transcribe.add_argument("--text-out", default=None, help="同时输出一份纯文本时间轴稿")
    transcribe.add_argument("--merge-gap", type=float, default=1.2, help="同人相邻段合并间隔（秒）")
    transcribe.add_argument("--merge-max", type=float, default=90.0, help="合并后单段最长时长（秒）")

    subparsers.add_parser("selfcheck", help="检查运行环境与依赖")

    models = subparsers.add_parser("models", help="预下载模型权重")
    models.add_argument("--model-cache", default=None, help="模型权重缓存目录")

    desc = subparsers.add_parser("describe", help="打印音频基本信息")
    desc.add_argument("--audio", required=True, help="音频文件路径")

    normalize = subparsers.add_parser(
        "normalize",
        help="把任意音频转成 16 kHz 单声道 WAV（导入录音用）",
    )
    normalize.add_argument("--audio", required=True, help="原始音频路径")
    normalize.add_argument("--out", required=True, help="输出 WAV 路径")

    return parser


def command_selfcheck() -> int:
    """逐项检查环境，任何一项失败都明确说清怎么修。"""
    checks: list[dict[str, Any]] = []

    def record(name: str, ok: bool, detail: str, hint: str | None = None) -> None:
        entry: dict[str, Any] = {"name": name, "ok": ok, "detail": detail}
        if hint and not ok:
            entry["hint"] = hint
        checks.append(entry)

    record("python", sys.version_info >= (3, 10), f"{sys.version.split()[0]}")

    try:
        import numpy

        record("numpy", True, numpy.__version__)
    except ImportError as exc:
        record("numpy", False, str(exc), "pip install numpy")

    try:
        import torch

        record("torch", True, f"{torch.__version__} (cuda={torch.cuda.is_available()})")
    except ImportError as exc:
        record("torch", False, str(exc), "pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio")

    try:
        import funasr

        record("funasr", True, getattr(funasr, "__version__", "unknown"))
    except ImportError as exc:
        record("funasr", False, str(exc), "pip install funasr modelscope")

    try:
        import soundfile

        record("soundfile", True, soundfile.__version__)
    except ImportError as exc:
        record("soundfile", False, str(exc), "pip install soundfile")

    try:
        import sklearn

        record("scikit-learn", True, sklearn.__version__)
    except ImportError as exc:
        record("scikit-learn", False, str(exc), "pip install scikit-learn")

    try:
        import docx

        record("python-docx", True, getattr(docx, "__version__", "unknown"))
    except ImportError as exc:
        record("python-docx", False, str(exc), "pip install python-docx")

    try:
        from .audio_io import _ffmpeg_path

        ffmpeg = _ffmpeg_path()
        record(
            "ffmpeg",
            ffmpeg is not None,
            ffmpeg or "未找到（仅影响非 WAV 输入）",
            "非 WAV 音频（m4a/mp3）需要 ffmpeg 转码；本插件自己的录音是 WAV，不受影响",
        )
    except Exception as exc:
        record("ffmpeg", False, str(exc))

    all_ok = all(entry["ok"] for entry in checks if entry["name"] != "ffmpeg")

    emit("selfcheck", ok=all_ok, checks=checks)

    return EXIT_OK if all_ok else EXIT_ENVIRONMENT


def command_models(model_cache: str | None) -> int:
    """把模型权重预先下载到指定目录，避免第一次转写时卡在下载。"""
    if model_cache:
        import os

        os.environ.setdefault("MODELSCOPE_CACHE", model_cache)

    from .pipeline import EngineConfig, load_asr_model, load_speaker_model, load_vad_model

    config = EngineConfig(model_cache_dir=model_cache)

    for name, loader in (
        ("vad", load_vad_model),
        ("asr", load_asr_model),
        ("speaker", load_speaker_model),
    ):
        emit("progress", stage="models", ratio=0.0, message=f"下载并加载 {name} 模型…")
        try:
            model = loader(config, "ms")
            del model
            emit("progress", stage="models", ratio=1.0, message=f"{name} 模型就绪")
        except Exception as exc:
            emit("error", stage="models", message=f"{name} 模型下载失败：{exc}")
            return EXIT_ENVIRONMENT

    emit("models", ok=True, cacheDir=model_cache)

    return EXIT_OK


def command_describe(audio_path: str) -> int:
    from .audio_io import describe_silence_ratio, duration_seconds, load_audio, peak_dbfs

    audio = load_audio(audio_path)

    emit(
        "describe",
        audioSeconds=round(duration_seconds(audio), 3),
        peakDbfs=round(peak_dbfs(audio), 2),
        silenceRatio=round(describe_silence_ratio(audio), 4),
    )

    return EXIT_OK


def command_transcribe(args: argparse.Namespace) -> int:
    from .pipeline import EngineConfig, TranscriptionError, transcribe_file
    from .writers import render_timeline

    config = EngineConfig(
        asr_model=args.asr_model,
        vad_model=args.vad_model,
        punc_model=args.punc_model,
        speaker_model=args.speaker_model,
        device=args.device,
        speaker_hint=args.speakers,
        model_cache_dir=args.model_cache,
        enable_diarization=not args.no_diarization,
        merge_gap_seconds=args.merge_gap,
        merge_max_seconds=args.merge_max,
    )

    last_emit: dict[str, float] = {}

    def progress(stage: str, ratio: float, message: str) -> None:
        # 同阶段进度节流到 1%，避免刷屏拖慢管道
        previous = last_emit.get(stage, -1.0)
        if ratio - previous < 0.01 and ratio < 1.0:
            return
        last_emit[stage] = ratio
        emit("progress", stage=stage, ratio=round(max(0.0, min(1.0, ratio)), 4), message=message)

    try:
        result = transcribe_file(args.audio, config=config, progress=progress)
    except TranscriptionError as exc:
        emit("error", stage="transcribe", message=str(exc))
        return EXIT_TRANSCRIPTION
    except Exception as exc:  # 未预期异常也要给机器可读的错误
        emit(
            "error",
            stage="transcribe",
            message=f"{type(exc).__name__}: {exc}",
            traceback=traceback.format_exc()[-4000:],
        )
        return EXIT_TRANSCRIPTION

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.text_out:
        text_path = Path(args.text_out)
        text_path.parent.mkdir(parents=True, exist_ok=True)
        text_path.write_text(render_timeline(result["segments"]), encoding="utf-8")

    emit(
        "result",
        out=str(output),
        audioSeconds=result["audioSeconds"],
        inferenceSeconds=result["inferenceSeconds"],
        realTimeFactor=result["realTimeFactor"],
        speakers=result["speakers"],
        segmentCount=len(result["segments"]),
        diagnostics=result.get("diagnostics", {}),
    )

    return EXIT_OK



def command_normalize(audio_path: str, out_path: str) -> int:
    """导入录音：任意格式 → 16 kHz 单声道 WAV，供后续转写复用。"""
    from .audio_io import AudioError, duration_seconds, load_audio, write_wav_16k_mono

    try:
        audio = load_audio(audio_path)
    except AudioError as exc:
        emit("error", stage="normalize", message=str(exc))
        return EXIT_TRANSCRIPTION
    except Exception as exc:
        emit(
            "error",
            stage="normalize",
            message=f"{type(exc).__name__}: {exc}",
            traceback=traceback.format_exc()[-2000:],
        )
        return EXIT_TRANSCRIPTION

    seconds = duration_seconds(audio)
    if seconds < 0.5:
        emit("error", stage="normalize", message=f"音频时长仅 {seconds:.1f} 秒，太短无法转写")
        return EXIT_TRANSCRIPTION

    try:
        write_wav_16k_mono(out_path, audio)
    except Exception as exc:
        emit("error", stage="normalize", message=f"写入 WAV 失败：{exc}")
        return EXIT_TRANSCRIPTION

    emit(
        "normalize",
        ok=True,
        out=str(Path(out_path)),
        audioSeconds=round(seconds, 3),
        sampleRate=16000,
        channels=1,
    )
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "selfcheck":
        return command_selfcheck()

    if args.command == "models":
        return command_models(args.model_cache)

    if args.command == "describe":
        return command_describe(args.audio)

    if args.command == "normalize":
        return command_normalize(args.audio, args.out)

    if args.command == "transcribe":
        return command_transcribe(args)

    parser.error(f"未知命令：{args.command}")
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
