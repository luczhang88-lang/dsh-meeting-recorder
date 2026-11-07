"""说话人分离：声纹提取 + 聚类 + 按段归属。

设计说明（为什么不用 FunASR 的说话人一体化接口）：
    FunASR 的 `spk_model` / `sentence_timestamp` 参数在不同版本间签名有变化，
    而我们要交付的是"能改、能查、出错能定位"的东西。所以这里自己组合：

        cam++ 声纹模型  →  逐窗提取 embedding
        窗口聚类        →  归并成说话人簇
        区间投票        →  给每个语音段打上说话人标签

    好处：聚类阈值、窗口长度都能按会议实际情况调；某一步不准可以单独替换；
    不依赖某个特定 FunASR 版本的封装行为。

关于准确性的一句实话：
    这套方法是"声纹聚类"，不是"声纹识别"。它能把不同人分开，但不知道谁是谁，
    所以输出是"说话人1/2/3"，需要你在界面里绑定到姓名。会议桌上轮转发言时
    表现最好；两人抢话、距离麦克风远近差异大时会出错，所以逐段人工纠正的能力
    是必须的，不是可选项。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import numpy as np

from .silence_trim import speech_intervals

ProgressFn = Callable[[str, float, str], None]


@dataclass
class SpeakerWindow:
    """一个用于提取声纹的音频窗口。"""

    start: float
    end: float
    embedding: np.ndarray | None = None


@dataclass
class SpeakerAssignment:
    """一段语音的说话人归属。"""

    start: float
    end: float
    speaker: str
    confidence: float


def _noop(stage: str, ratio: float, message: str) -> None:  # pragma: no cover
    return None


def build_windows(
    audio: np.ndarray,
    sample_rate: int,
    window_seconds: float = 1.8,
    hop_seconds: float = 0.6,
    min_window_seconds: float = 0.8,
) -> list[SpeakerWindow]:
    """按固定步长在语音区间内切窗。

    只在检测到语音的位置切窗——静音窗的声纹是噪声，混进聚类会直接降低分人质量。
    """
    intervals = speech_intervals(audio, sample_rate)
    windows: list[SpeakerWindow] = []

    for start, end in intervals:
        cursor = start

        while cursor + min_window_seconds <= end:
            window_end = min(cursor + window_seconds, end)
            windows.append(SpeakerWindow(start=cursor, end=window_end))

            if window_end >= end:
                break

            cursor += hop_seconds

    return windows


def embed_windows(
    model: Any,
    audio: np.ndarray,
    sample_rate: int,
    windows: Sequence[SpeakerWindow],
    batch_size: int = 8,
    progress: ProgressFn = _noop,
) -> list[SpeakerWindow]:
    """给每个窗口算一个声纹向量。

    cam++ 需要至少约 0.3 秒有效音频，过短的窗口直接丢弃（返回 embedding=None）。
    """
    usable = [window for window in windows if window.end - window.start >= 0.3]

    if not usable:
        return []

    for index, window in enumerate(usable):
        start_sample = int(window.start * sample_rate)
        end_sample = int(window.end * sample_rate)
        chunk = audio[start_sample:end_sample]

        if chunk.size < int(0.3 * sample_rate):
            continue

        try:
            result = model.generate(
                input=chunk,
                input_len=np.array([chunk.size], dtype=np.int32),
                batch_size=1,
            )
        except Exception:
            # 单个窗口失败不该让整场会议转录失败，跳过即可
            continue

        embedding = _extract_embedding(result)
        if embedding is not None:
            window.embedding = embedding

        if index % 25 == 0:
            ratio = (index + 1) / max(1, len(usable))
            progress("speaker", ratio * 0.5, f"提取声纹 {index + 1}/{len(usable)}")

    return [window for window in usable if window.embedding is not None]


_EMBEDDING_KEYS = ("spk_embedding", "spk_emb", "embedding", "embeddings", "spk_model")


def _values_of(value: Any) -> list[Any]:
    """把可能包裹着向量的容器拆成候选列表。

    这里踩过一个导致分人全线失败的坑：cam++ 的实际返回是
    `[{'spk_embedding': tensor}]` —— 列表里套字典。
    早先对列表只做 extend，于是把整个 dict 当成候选交给转换函数，
    转换失败返回 None，又被静默跳过，最终"一个声纹都提取不到"。
    所以必须递归解包，而不是假设只有一层。
    """
    if value is None:
        return []

    if isinstance(value, np.ndarray):
        return [value]

    if isinstance(value, (list, tuple)):
        # 已是数值序列就直接当候选，否则逐项拆开
        try:
            np.asarray(value, dtype=np.float32)
            nested = [item for item in value if isinstance(item, (dict, list, tuple))]
            if not nested:
                return [value]
        except (ValueError, TypeError):
            pass

        collected: list[Any] = []
        for item in value:
            collected.extend(_values_of(item))
        return collected

    if isinstance(value, dict):
        preferred = [value[key] for key in _EMBEDDING_KEYS if key in value]
        if preferred:
            return preferred
        collected = []
        for item in value.values():
            collected.extend(_values_of(item))
        return collected

    # torch 张量等：既不拆开也不丢弃
    return [value]


def _extract_embedding(result: Any) -> np.ndarray | None:
    """从 cam++ 的各种返回形态里取出 embedding 向量。"""
    for candidate in _values_of(result):
        array = _to_numpy(candidate)
        if array is None:
            continue

        flattened = np.asarray(array, dtype=np.float32).reshape(-1)
        if flattened.size < 16:
            continue

        return normalize(flattened)

    return None


def _to_numpy(value: Any) -> np.ndarray | None:
    if value is None:
        return None

    if isinstance(value, np.ndarray):
        return value

    if isinstance(value, (list, tuple)):
        try:
            return np.asarray(value, dtype=np.float32)
        except (ValueError, TypeError):
            return None

    for attribute in ("numpy", "cpu", "detach"):
        method = getattr(value, attribute, None)
        if callable(method):
            try:
                return _to_numpy(method())
            except Exception:
                continue

    return None


def normalize(vector: np.ndarray) -> np.ndarray:
    """L2 归一化，让余弦距离退化成欧氏距离，便于聚类。"""
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-9:
        return vector

    return vector / norm


def estimate_speaker_count(
    embeddings: np.ndarray,
    max_speakers: int = 12,
) -> int:
    """用特征值分解粗估说话人数量。

    原理：把 embedding 矩阵做奇异值分解，有效秩大致对应说话人数量。
    这只是一个先验，用于给聚类一个上限，不是最终结果。
    """
    if embeddings.shape[0] < 2:
        return 1

    centered = embeddings - embeddings.mean(axis=0, keepdims=True)
    singular_values = np.linalg.svd(centered, compute_uv=False)

    if singular_values.size == 0 or singular_values[0] <= 1e-9:
        return 1

    energy = np.square(singular_values)
    explained = np.cumsum(energy) / np.sum(energy)

    count = int(np.searchsorted(explained, 0.85) + 1)

    return max(1, min(count, max_speakers, embeddings.shape[0]))


def cluster_speakers(
    embeddings: np.ndarray,
    speaker_hint: int | None = None,
    distance_threshold: float = 0.55,
    min_speaker_seconds: float = 8.0,
    window_seconds: float = 0.6,
    max_speakers: int = 12,
) -> np.ndarray:
    """把声纹向量聚成说话人簇，返回每个窗口的簇编号。

    优先用层次聚类（余弦距离 + average linkage）：
    它不需要预先知道人数，阈值语义直观，且对簇大小不敏感。

    簇太小的会被并进最近的簇——会议里没人只讲 3 秒钟，
    这种小簇几乎都是噪声或串音，留着只会污染文字稿。
    """
    count = embeddings.shape[0]
    if count == 0:
        return np.zeros(0, dtype=np.int32)

    if count == 1:
        return np.zeros(1, dtype=np.int32)

    from sklearn.cluster import AgglomerativeClustering

    if speaker_hint and speaker_hint > 1:
        labels = AgglomerativeClustering(
            n_clusters=min(speaker_hint, count),
            metric="cosine",
            linkage="average",
        ).fit_predict(embeddings)
    else:
        labels = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=distance_threshold,
            metric="cosine",
            linkage="average",
        ).fit_predict(embeddings)

    return _absorb_tiny_clusters(
        embeddings=embeddings,
        labels=np.asarray(labels, dtype=np.int32),
        min_cluster_windows=max(2, int(min_speaker_seconds / max(window_seconds, 0.1))),
        max_speakers=max_speakers,
    )


def _absorb_tiny_clusters(
    embeddings: np.ndarray,
    labels: np.ndarray,
    min_cluster_windows: int,
    max_speakers: int,
) -> np.ndarray:
    """把小簇并入最近的簇，并把簇数量压到上限内。"""
    labels = labels.copy()

    def cluster_centroids(current_labels: np.ndarray) -> dict[int, np.ndarray]:
        centroids: dict[int, np.ndarray] = {}
        for label in np.unique(current_labels):
            mask = current_labels == label
            centroids[int(label)] = normalize(embeddings[mask].mean(axis=0))
        return centroids

    # 反复合并最小簇，直到没有过小的簇为止
    for _ in range(32):
        centroids = cluster_centroids(labels)
        if len(centroids) <= 1:
            break

        sizes = {label: int(np.sum(labels == label)) for label in centroids}
        smallest_label, smallest_size = min(sizes.items(), key=lambda item: item[1])

        if smallest_size >= min_cluster_windows:
            break

        target_label = _nearest_cluster(
            centroids=centroids,
            exclude=smallest_label,
            source=centroids[smallest_label],
        )
        if target_label is None:
            break

        labels[labels == smallest_label] = target_label

    # 仍然超出上限时，继续合并最近的簇对
    while len(set(labels.tolist())) > max_speakers:
        centroids = cluster_centroids(labels)
        if len(centroids) <= 1:
            break

        pair = _closest_cluster_pair(centroids)
        if pair is None:
            break

        first, second = pair
        labels[labels == second] = first

    return _relabel_by_first_appearance(labels)


def _nearest_cluster(
    centroids: dict[int, np.ndarray],
    exclude: int,
    source: np.ndarray,
) -> int | None:
    best_label: int | None = None
    best_similarity = -2.0

    for label, centroid in centroids.items():
        if label == exclude:
            continue

        similarity = float(np.dot(source, centroid))
        if similarity > best_similarity:
            best_similarity = similarity
            best_label = label

    return best_label


def _closest_cluster_pair(centroids: dict[int, np.ndarray]) -> tuple[int, int] | None:
    labels = sorted(centroids)
    if len(labels) < 2:
        return None

    best_pair: tuple[int, int] | None = None
    best_similarity = -2.0

    for index, first in enumerate(labels):
        for second in labels[index + 1:]:
            similarity = float(np.dot(centroids[first], centroids[second]))
            if similarity > best_similarity:
                best_similarity = similarity
                best_pair = (first, second)

    return best_pair


def _relabel_by_first_appearance(labels: np.ndarray) -> np.ndarray:
    """重新编号，让第一次出现的说话人是"说话人1"。"""
    mapping: dict[int, int] = {}
    result = np.empty_like(labels)

    for index, label in enumerate(labels.tolist()):
        if label not in mapping:
            mapping[label] = len(mapping)
        result[index] = mapping[label]

    return result


def assign_speakers_to_segments(
    segments: Sequence[dict[str, Any]],
    windows: Sequence[SpeakerWindow],
    window_labels: np.ndarray,
) -> list[SpeakerAssignment]:
    """按时间重叠投票，给每个语音段分配说话人。

    投票用重叠时长加权，并对"该段自身声纹相似度"做一次微调：
    单纯按时长投票在抢话段落会翻车，加上声纹相似度能明显改善。
    """
    assignments: list[SpeakerAssignment] = []

    if not windows or window_labels.size == 0:
        for segment in segments:
            assignments.append(
                SpeakerAssignment(
                    start=float(segment.get("start", 0.0)),
                    end=float(segment.get("end", 0.0)),
                    speaker="说话人1",
                    confidence=0.0,
                )
            )
        return assignments

    labelled = [
        (window, int(window_labels[index]))
        for index, window in enumerate(windows)
        if index < window_labels.size and window.embedding is not None
    ]

    if not labelled:
        return assign_speakers_to_segments(segments, [], np.zeros(0, dtype=np.int32))

    for segment in segments:
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))

        overlap_by_label: dict[int, float] = {}
        embedding_sum: dict[int, np.ndarray] = {}
        embedding_count: dict[int, int] = {}

        for window, label in labelled:
            overlap = min(end, window.end) - max(start, window.start)
            if overlap <= 0:
                continue

            overlap_by_label[label] = overlap_by_label.get(label, 0.0) + overlap

            if window.embedding is not None:
                accumulated = embedding_sum.get(label)
                if accumulated is None:
                    embedding_sum[label] = window.embedding.copy()
                else:
                    embedding_sum[label] = accumulated + window.embedding

                embedding_count[label] = embedding_count.get(label, 0) + 1

        if not overlap_by_label:
            # 没有任何窗口覆盖这一段：取时间上最近的窗口所属说话人
            nearest = min(
                labelled,
                key=lambda item: min(
                    abs(item[0].start - end),
                    abs(start - item[0].end),
                ),
            )
            assignments.append(
                SpeakerAssignment(start=start, end=end, speaker=_speaker_name(nearest[1]), confidence=0.0)
            )
            continue

        total_overlap = sum(overlap_by_label.values())

        best_label = max(overlap_by_label.items(), key=lambda item: item[1])[0]
        best_score = overlap_by_label[best_label]

        # 用段内声纹与各簇中心的相似度修正投票结果
        for label, accumulated in embedding_sum.items():
            count = embedding_count.get(label, 0)
            if count == 0:
                continue

            centroid = normalize(accumulated / count)
            label_mask = np.array([candidate == label for _, candidate in labelled])
            label_embeddings = np.stack(
                [window.embedding for window, candidate in labelled if candidate == label],
            )

            if label_embeddings.shape[0] == 0:
                continue

            similarity = float(np.dot(centroid, normalize(label_embeddings.mean(axis=0))))
            weighted = overlap_by_label[label] * (1.0 + max(0.0, similarity))

            if weighted > best_score:
                best_score = weighted
                best_label = label

        best_overlap = overlap_by_label[best_label]
        confidence = best_overlap / total_overlap if total_overlap > 0 else 0.0

        assignments.append(
            SpeakerAssignment(
                start=start,
                end=end,
                speaker=_speaker_name(best_label),
                confidence=round(float(confidence), 4),
            )
        )

    return assignments


def _speaker_name(label: int) -> str:
    return f"说话人{label + 1}"


def merge_consecutive_by_speaker(
    segments: Sequence[dict[str, Any]],
    max_gap_seconds: float = 1.2,
    max_merge_seconds: float = 90.0,
) -> list[dict[str, Any]]:
    """把同一说话人相邻且间隔很小的段合成一段。

    ASR 切出来的段很碎（一句一段），直接给用户看会是一堆零行。
    合并时限制单段最长时长，避免某位领导连续讲 10 分钟形成一整块无法定位的文本。
    """
    merged: list[dict[str, Any]] = []

    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = str(segment.get("speaker", "说话人1"))
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))

        if merged:
            last = merged[-1]
            same_speaker = last["speaker"] == speaker
            small_gap = start - float(last["end"]) <= max_gap_seconds
            short_enough = end - float(last["start"]) <= max_merge_seconds

            if same_speaker and small_gap and short_enough:
                last["text"] = f"{last['text']}{_join_text(last['text'], text)}"
                last["end"] = end
                last["confidence"] = round(
                    min(float(last.get("confidence", 0.0)), float(segment.get("confidence", 0.0))),
                    4,
                ) if segment.get("confidence") is not None else last.get("confidence")
                continue

        merged.append(
            {
                "start": start,
                "end": end,
                "text": text,
                "speaker": speaker,
                "confidence": segment.get("confidence"),
            }
        )

    return merged


def _join_text(previous: str, current: str) -> str:
    """中文之间不留空格，英文单词之间留一个空格。"""
    if not previous:
        return current

    if previous[-1].isascii() and previous[-1].isalnum() and current[0].isascii() and current[0].isalnum():
        return f" {current}"

    return current


def diarize(
    audio: np.ndarray,
    sample_rate: int,
    segments: Sequence[dict[str, Any]],
    model: Any,
    speaker_hint: int | None = None,
    progress: ProgressFn = _noop,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """完整的分人流程：切窗 → 提声纹 → 聚类 → 按段归属。

    返回 (带说话人标签的段落, 诊断信息)。
    """
    started = time.time()

    progress("speaker", 0.0, "分析说话人…")

    windows = build_windows(audio, sample_rate)
    if not windows:
        progress("speaker", 1.0, "未检测到可用于分人的语音")
        return _stamp_single_speaker(segments), {
            "windows": 0,
            "speakers": 1,
            "elapsedSeconds": round(time.time() - started, 2),
            "note": "没有检测到语音窗口，全部归为说话人1",
        }

    embedded = embed_windows(model, audio, sample_rate, windows, progress=progress)
    if not embedded:
        progress("speaker", 1.0, "声纹提取失败，全部归为说话人1")
        return _stamp_single_speaker(segments), {
            "windows": len(windows),
            "speakers": 1,
            "elapsedSeconds": round(time.time() - started, 2),
            "note": "未能提取到任何声纹向量",
        }

    matrix = np.stack([window.embedding for window in embedded])

    detected = estimate_speaker_count(matrix)
    labels = cluster_speakers(
        matrix,
        speaker_hint=speaker_hint,
        min_speaker_seconds=6.0,
    )

    speaker_count = int(len(set(labels.tolist())))
    progress("speaker", 1.0, f"识别到 {speaker_count} 位说话人")

    assignments = assign_speakers_to_segments(segments, embedded, labels)

    stamped: list[dict[str, Any]] = []
    for segment, assignment in zip(segments, assignments):
        enriched = dict(segment)
        enriched["speaker"] = assignment.speaker
        enriched["confidence"] = assignment.confidence
        stamped.append(enriched)

    diagnostics = {
        "windows": len(embedded),
        "speakers": speaker_count,
        "estimatedSpeakers": detected,
        "speakerHint": speaker_hint,
        "elapsedSeconds": round(time.time() - started, 2),
    }

    return stamped, diagnostics


def _stamp_single_speaker(segments: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(segment, speaker="说话人1", confidence=None) for segment in segments]


def cluster_quality(segments: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """给出分人质量的可读指标，用于界面提示"哪几位需要重点复核"。

    置信度低的两类段是复查重点：说话人归属不明确、以及过短的段
    （短段声纹证据少，最容易串到隔壁）。
    """
    by_speaker: dict[str, dict[str, Any]] = {}
    low_confidence: list[int] = []

    for index, segment in enumerate(segments):
        speaker = str(segment.get("speaker", "说话人1"))
        entry = by_speaker.setdefault(speaker, {"segments": 0, "seconds": 0.0, "avgConfidence": None})
        entry["segments"] += 1
        entry["seconds"] = round(entry["seconds"] + (float(segment.get("end", 0)) - float(segment.get("start", 0))), 2)

        confidence = segment.get("confidence")
        if isinstance(confidence, (int, float)):
            if entry["avgConfidence"] is None:
                entry["avgConfidence"] = float(confidence)
            else:
                entry["avgConfidence"] = round((entry["avgConfidence"] + float(confidence)) / 2, 4)

            if confidence < 0.6:
                low_confidence.append(index)

    for speaker, entry in by_speaker.items():
        entry["share"] = None

    total_seconds = sum(entry["seconds"] for entry in by_speaker.values()) or 1.0
    for entry in by_speaker.values():
        entry["share"] = round(entry["seconds"] / total_seconds, 4)

    return {
        "bySpeaker": by_speaker,
        "totalSegments": len(segments),
        "lowConfidenceSegments": len(low_confidence),
        "lowConfidenceIndexes": low_confidence[:500],
    }
