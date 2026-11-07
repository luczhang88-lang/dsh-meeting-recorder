"""音频读取与格式转换。

统一把任意音频输入转成 16 kHz 单声道 float32，这是 FunASR 要求的输入格式。
优先用 soundfile（WAV/FLAC 无需外部依赖），兜底用 ffmpeg 处理 m4a/mp3 等压缩格式。
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

TARGET_SAMPLE_RATE = 16000


class AudioError(RuntimeError):
    """音频无法读取或转码。"""


def _ffmpeg_path() -> str | None:
    """找一个可用的 ffmpeg：PATH 优先，其次工作区内的自带副本。"""
    found = shutil.which("ffmpeg")
    if found:
        return found

    bundled = Path(__file__).resolve().parents[2] / "bin" / "ffmpeg.exe"
    if bundled.is_file():
        return str(bundled)

    return None


def _decode_with_ffmpeg(path: Path) -> np.ndarray:
    """用 ffmpeg 解码成 16 kHz 单声道 PCM，全程走管道，不落临时文件。"""
    ffmpeg = _ffmpeg_path()
    if not ffmpeg:
        raise AudioError(
            f"无法读取 {path.name}：soundfile 不支持该格式，且系统里找不到 ffmpeg。"
            "请安装 ffmpeg，或把音频转成 WAV 后重试。"
        )

    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(path),
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-ac", "1",
        "-ar", str(TARGET_SAMPLE_RATE),
        "pipe:1",
    ]

    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", errors="replace").strip()
        raise AudioError(f"ffmpeg 解码失败（{path.name}）：{detail or '未知错误'}")

    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size == 0:
        raise AudioError(f"ffmpeg 解码结果为空：{path.name}")

    return audio


def _decode_with_soundfile(path: Path) -> np.ndarray:
    """soundfile 路径：只做声道合并和重采样，不做格式转码。"""
    import soundfile as sf

    data, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)

    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]

    if sample_rate != TARGET_SAMPLE_RATE:
        mono = resample_linear(mono, sample_rate, TARGET_SAMPLE_RATE)

    return np.ascontiguousarray(mono, dtype=np.float32)


def resample_linear(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """线性插值重采样。

    对 16 kHz 目标而言足够：说话人识别和 ASR 都不依赖高频细节，
    而线性插值不会引入 polyphase 滤波器那样的相位拖尾。
    """
    if source_rate == target_rate:
        return audio

    if audio.size == 0:
        return audio

    duration = audio.size / float(source_rate)
    target_length = max(1, int(round(duration * target_rate)))

    source_positions = np.arange(audio.size, dtype=np.float64)
    target_positions = np.linspace(0.0, audio.size - 1, target_length, dtype=np.float64)

    resampled = np.interp(target_positions, source_positions, audio.astype(np.float64))

    return resampled.astype(np.float32)


def load_audio(path: str | Path) -> np.ndarray:
    """读取任意音频为 16 kHz 单声道 float32，幅度范围约 [-1, 1]。"""
    target = Path(path)
    if not target.is_file():
        raise AudioError(f"音频文件不存在：{target}")

    suffix = target.suffix.lower()

    if suffix in {".wav", ".flac", ".ogg", ".aiff", ".aif", ".au"}:
        try:
            return _decode_with_soundfile(target)
        except AudioError:
            raise
        except Exception as exc:  # soundfile 打不开就交给 ffmpeg 兜底
            try:
                return _decode_with_ffmpeg(target)
            except AudioError as fallback_error:
                raise AudioError(
                    f"无法读取 {target.name}：soundfile 报错（{exc}），ffmpeg 也失败（{fallback_error}）"
                ) from exc

    return _decode_with_ffmpeg(target)


def write_wav_16k_mono(path: str | Path, audio: np.ndarray, sample_rate: int = TARGET_SAMPLE_RATE) -> None:
    """把 float32 波形写成 16-bit PCM WAV。"""
    import soundfile as sf

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    clipped = np.clip(audio, -1.0, 1.0)
    sf.write(str(target), clipped, sample_rate, subtype="PCM_16")


def peak_dbfs(audio: np.ndarray) -> float:
    """整体峰值电平（dBFS），用于判断录音是否爆音或过小。"""
    if audio.size == 0:
        return float("-inf")

    peak = float(np.max(np.abs(audio)))
    if peak <= 0.0:
        return float("-inf")

    return 20.0 * float(np.log10(peak))


def duration_seconds(audio: np.ndarray, sample_rate: int = TARGET_SAMPLE_RATE) -> float:
    return audio.size / float(sample_rate)


def describe_silence_ratio(audio: np.ndarray, sample_rate: int = TARGET_SAMPLE_RATE) -> float:
    """粗略估算静音占比，用于提示录音是否有效（比如麦克风被静音）。"""
    if audio.size == 0:
        return 1.0

    frame = max(1, int(0.05 * sample_rate))
    usable = audio.size - (audio.size % frame)

    if usable < frame:
        return 0.0

    frames = audio[:usable].reshape(-1, frame)
    energies = np.sqrt(np.mean(np.square(frames.astype(np.float64)), axis=1))

    if energies.size == 0:
        return 1.0

    threshold = max(1e-4, float(np.percentile(energies, 95)) * 0.02)

    return float(np.mean(energies < threshold))
