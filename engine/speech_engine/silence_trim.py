"""基于能量和过零率的静音切分。

这不是用来替代 fsmn-vad 的语音活动检测，而是它的前置粗筛：
会议室录音里常见的长时间空调噪声、椅子拖动、走廊人声会让 VAD 误判，
先用一个偏保守的阈值把"绝对没有信号"的区域切掉，能显著减少 VAD 的
误触发，同时把送进声纹提取的窗口数量降下来（这对 4 核 CPU 很关键）。

原则：宁可保留，不可误删。阈值取得很低，真正的语音永远不会被切掉。
"""

from __future__ import annotations

import numpy as np

FRAME_MS = 30
HOP_MS = 10


_MIN_ENERGY = 1e-6


def _hysteresis_activity(
    rms: np.ndarray,
    zero_crossing: np.ndarray,
    on_threshold: float,
    off_threshold: float,
    quiet_reference: float,
    crossing_threshold: float,
) -> np.ndarray:
    """带滞回的逐帧活动判定。

    起始一帧需要能量超过 on_threshold；
    已在语音里的帧只需要超过更低的 off_threshold，
    或者能量不算太低(高于 quiet_reference)但过零率明显，
    这样句尾的摩擦音、气声不会被切断。
    """
    active = np.zeros(rms.shape, dtype=bool)
    inside = False

    for index in range(rms.size):
        energy = float(rms[index])

        if inside:
            kept = energy > off_threshold or (
                energy > quiet_reference and float(zero_crossing[index]) > crossing_threshold
            )
            if not kept:
                inside = False
            active[index] = inside
            continue

        if energy > on_threshold:
            inside = True
            active[index] = True

    return active


def _frame_signal(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    """把波形切成帧，返回 (每帧 RMS 能量, 每帧过零率)。"""
    frame_length = max(1, int(sample_rate * FRAME_MS / 1000))
    hop_length = max(1, int(sample_rate * HOP_MS / 1000))

    if audio.size < frame_length:
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        return np.array([rms]), np.array([0.0])

    frame_count = 1 + (audio.size - frame_length) // hop_length

    # stride_tricks 取窗，避免复制整段音频
    windows = np.lib.stride_tricks.as_strided(
        audio,
        shape=(frame_count, frame_length),
        strides=(audio.strides[0] * hop_length, audio.strides[0]),
        writeable=False,
    ).astype(np.float32)

    rms = np.sqrt(np.mean(np.square(windows), axis=1))

    # 过零率只统计真正有信号的帧：signbit 在零值上会翻转，
    # 不加这个判断的话数字静音的过零率会等于 1.0，反而比语音还"活跃"。
    sign_bits = np.signbit(windows)
    crossings = np.abs(np.diff(sign_bits, axis=1)).mean(axis=1)
    has_signal = rms > _MIN_ENERGY
    zero_crossing = np.where(has_signal, crossings, 0.0)

    return rms, zero_crossing


def speech_intervals(
    audio: np.ndarray,
    sample_rate: int = 16000,
    min_speech_seconds: float = 0.30,
    min_silence_seconds: float = 0.35,
    padding_seconds: float = 0.12,
) -> list[tuple[float, float]]:
    """返回可能含语音的区间列表 [(起, 止), ...]，单位秒。

    设计定位（重要）：本函数只做**粗筛**，用于挑出值得提取声纹的窗口，
    不承担精确切分职责——精确边界由 fsmn-vad 负责。因此：
      - 阈值偏保守，宁可多带一点静音，也不切掉句首字
      - 不追求秒级以下精度，帧长 30ms/步长 10ms 决定了它的分辨率上限
      - 不做归一化：会议录音里远近变化是真实信息，归一化会抹平它

    判定规则：帧能量越过自适应门限（起始用高阈值、延续用低阈值），
    过零率只参与延续判定。
    """
    if audio.size == 0:
        return []

    rms, zero_crossing = _frame_signal(audio, sample_rate)

    loud_reference = float(np.percentile(rms, 95))

    if loud_reference <= _MIN_ENERGY:
        # 整段几乎是数字静音，没有任何值得转写的内容
        return []

    # 本底噪声估计：取低百分位。
    #
    # 这里踩过一个坑：早先版本用 median(rms) 估计噪声，但只要语音占比过半，
    # 中位数就落在语音能量上（一半静音帧、一半语音帧时，中位≈语音的 70%），
    # 门限随之上浮到语音之上，整段音频被判定为无语音。
    # 所以必须用低百分位，并且对"低位为 0"的情况用强信号做相对兜底。
    noise_floor = float(np.percentile(rms, 10))
    if noise_floor <= _MIN_ENERGY:
        noise_floor = loud_reference * 0.02

    on_threshold = max(noise_floor * 4.0, loud_reference * 0.08, _MIN_ENERGY)
    off_threshold = max(noise_floor * 2.0, loud_reference * 0.04, _MIN_ENERGY)

    # 过零率只作为"延续"的辅助判据，不参与起始判定：
    # 因为白噪声的过零率本身就在 0.5 左右，用它判定起始会把底噪当成语音。
    crossing_threshold = 0.35
    quiet_reference = max(noise_floor * 1.2, _MIN_ENERGY)

    active = _hysteresis_activity(
        rms=rms,
        zero_crossing=zero_crossing,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        quiet_reference=quiet_reference,
        crossing_threshold=crossing_threshold,
    )

    frame_seconds = HOP_MS / 1000.0
    frame_span_seconds = FRAME_MS / 1000.0

    # 帧数换算时长时必须加上一帧的跨度：第 i 帧覆盖的是 [i*hop, i*hop+frame]，
    # 所以 n 帧的时间跨度是 n*hop + frame，而不是 n*hop。
    # 之前漏掉这一项，导致 1 秒的语音被算成 0.97 秒，整段语音被当作噪声丢掉。
    minimum_speech_frames = max(
        1,
        int((min_speech_seconds - frame_span_seconds) / frame_seconds),
    )
    gap_frames = max(1, int(min_silence_seconds / frame_seconds))

    intervals: list[tuple[float, float]] = []
    run_start: int | None = None
    silence_run = 0

    for index, is_active in enumerate(active):
        if is_active:
            if run_start is None:
                run_start = index
            silence_run = 0
            continue

        if run_start is None:
            continue

        silence_run += 1
        if silence_run >= gap_frames:
            end_index = index - silence_run + 1
            if end_index - run_start >= minimum_speech_frames:
                intervals.append((run_start * frame_seconds, end_index * frame_seconds))
            run_start = None
            silence_run = 0

    if run_start is not None:
        end_index = active.size
        if end_index - run_start >= minimum_speech_frames:
            intervals.append((run_start * frame_seconds, end_index * frame_seconds))

    total_seconds = audio.size / float(sample_rate)
    padded = [
        (max(0.0, start - padding_seconds), min(total_seconds, end + padding_seconds))
        for start, end in intervals
    ]

    return merge_intervals(padded, max_gap=min_silence_seconds)


def merge_intervals(
    intervals: list[tuple[float, float]],
    max_gap: float = 0.0,
) -> list[tuple[float, float]]:
    """合并重叠或间隔小于 max_gap 的区间。"""
    if not intervals:
        return []

    ordered = sorted(intervals)
    merged = [ordered[0]]

    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]

        if start - last_end <= max_gap:
            merged[-1] = (last_start, max(last_end, end))
            continue

        merged.append((start, end))

    return merged


def speech_ratio(intervals: list[tuple[float, float]], total_seconds: float) -> float:
    """语音区间占总时长的比例。"""
    if total_seconds <= 0:
        return 0.0

    covered = sum(end - start for start, end in intervals)

    return min(1.0, covered / total_seconds)
