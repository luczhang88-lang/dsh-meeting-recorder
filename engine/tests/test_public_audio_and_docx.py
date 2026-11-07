"""合成音频和公开样例文本。不读取、不生成真实会议内容。"""

from __future__ import annotations

import json
import sys
import unittest
import zipfile
from pathlib import Path

import numpy as np

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from speech_engine.audio_io import duration_seconds, load_audio, write_wav_16k_mono
from speech_engine.cli import main
from speech_engine.docx_writers import write_minutes_docx, write_timeline_docx
from speech_engine.writers import render_timeline


class PublicAudioAndDocxTest(unittest.TestCase):
    def test_synthetic_wav_roundtrip_and_word_export(self) -> None:
        folder = Path(self.id().replace(".", "_"))
        # unittest 的默认临时目录不稳定，这里用 TemporaryDirectory 更直接。
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tone = 0.2 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000).astype(np.float32)
            wav_path = root / "synthetic.wav"
            write_wav_16k_mono(wav_path, tone)

            loaded = load_audio(wav_path)
            self.assertAlmostEqual(duration_seconds(loaded), 1.0, places=2)
            self.assertEqual(loaded.dtype, np.float32)

            describe_code = main(["describe", "--audio", str(wav_path)])
            self.assertEqual(describe_code, 0)

            result = {
                "audioSeconds": 1.0,
                "inferenceSeconds": 0.1,
                "speakers": ["spk0"],
                "segments": [
                    {
                        "speaker": "spk0",
                        "start": 0.0,
                        "end": 1.0,
                        "text": "这是合成测试句，没有真实会议内容。",
                    }
                ],
            }
            timeline = render_timeline(result["segments"])
            self.assertIn("合成测试句", timeline)

            docx_path = root / "timeline.docx"
            write_timeline_docx(
                result,
                docx_path,
                meeting={"title": "合成样例"},
                speaker_names={"spk0": "测试说话人"},
            )
            minutes_path = root / "minutes.docx"
            write_minutes_docx(
                "# 会议纪要\n\n合成样例纪要，仅用于导出测试。\n",
                minutes_path,
                meeting={"title": "合成样例"},
            )

            for path in (docx_path, minutes_path):
                self.assertTrue(path.is_file())
                self.assertGreater(path.stat().st_size, 1000)
                with zipfile.ZipFile(path) as package:
                    document = package.read("word/document.xml").decode("utf-8")
                self.assertTrue("合成" in document or "纪要" in document)

            transcript = root / "result.json"
            transcript.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            self.assertIn("没有真实会议内容", transcript.read_text(encoding="utf-8"))
            del folder


if __name__ == "__main__":
    unittest.main()
