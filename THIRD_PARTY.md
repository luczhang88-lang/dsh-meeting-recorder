# 第三方与模型许可

本仓库自己的插件和 `engine/speech_engine` 封装代码使用根目录 `LICENSE`（MIT，Copyright 2026 Luc Zhang）。这不表示依赖库或模型权重也是 MIT。本仓库不包含、也不分发模型权重。

## 代码依赖

| 组件 | 角色 | 许可 | 来源 |
| --- | --- | --- | --- |
| FunASR | 转写运行时 | MIT | https://github.com/modelscope/FunASR/blob/main/LICENSE |
| ModelScope | 模型下载 | Apache-2.0 | https://github.com/modelscope/modelscope/blob/master/LICENSE |
| PyTorch / torchaudio | 推理 | 见各自发行包 | 由 setup 安装，不随本仓库分发 |
| requirements.txt 里的其他包 | 音频、聚类、Word | 见安装后各包的 LICENSE | `pip show <name>` |

## 本插件实际请求的模型

`engine/speech_engine/pipeline.py` 默认使用 FunASR 别名，并从 ModelScope（`hub="ms"`）下载，不从本仓库读取权重：

| 别名 | FunASR `main` 在 2026-11-07 的 `name_maps_ms` | 当天 ModelScope 模型卡 `License` 字段 |
| --- | --- | --- |
| `paraformer-zh` | `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` | Apache License 2.0 |
| `fsmn-vad` | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` | Apache License 2.0 |
| `ct-punc` | `iic/punc_ct-transformer_cn-en-common-vocab471067-large` | Apache License 2.0 |
| `cam++` | `iic/speech_campplus_sv_zh-cn_16k-common` | Apache License 2.0 |

别名表出处：https://github.com/modelscope/FunASR/blob/main/funasr/download/name_maps_from_hub.py

2026-11-07 在 Linux x86_64 上用本仓库 `scripts/setup.sh` 做了一次干净安装。装上的 FunASR 是 1.4.22，`name_maps_ms` 与上表相同，并且模型下载日志写的是这四个 ID 的 `@master`。这次安装没有把权重放进 git。

核对方式：对上述模型 ID 请求 `https://www.modelscope.cn/api/v1/models/<id>`，读取 `Data.License`。四个模型当时返回的都是 `Apache License 2.0`，`Revision` 为 `master`。这是模型卡字段，不是本仓库附带的许可证文件。

约束：

- `requirements.txt` 允许 `funasr>=1.1.0,<2`。别名最终落到哪个 ModelScope ID、哪个 revision，由**安装到虚拟环境里的那一版 FunASR** 决定。上表只描述 2026-11-07 的 FunASR `main` 映射，不是锁定版本。
- 本插件没有把 `model_revision` 写死。下载完成后，以该次落到 `engine/models/` 的模型卡为准。
- 模型卡标 Apache-2.0，不表示训练数据没有另外的权利限制。这里没有把权重重新声明成 MIT，也没有把整个项目说成全是 MIT。
- 不要把权重提交进 git，也不要打进 npm 包。

## English

Project code is MIT. FunASR the library is MIT. ModelScope the library is Apache-2.0. Model weights are downloaded from ModelScope at setup or first transcription and are not in this repository. The aliases above resolved, on 2026-11-07 FunASR `main`, to the listed `iic/...` model IDs, whose ModelScope card `License` field was `Apache License 2.0`. The installed FunASR release may resolve aliases differently. Read the card for the revision you actually download. This MIT license does not relicence those weights.
