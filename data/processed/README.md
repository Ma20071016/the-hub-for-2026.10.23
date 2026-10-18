# 处理数据与模型资源

| 目录 | 内容 |
| --- | --- |
| [ocnli/](ocnli/README.md) | 历史 3k 实验：训练 2,993 条、验证 2,950 条 |
| [ocnli_50k/](ocnli_50k/README.md) | 当前训练集：训练 37,072 条、验证 2,950 条 |
| [bert-base-chinese-tokenizer/](bert-base-chinese-tokenizer/README.md) | 本地分词器配置与词表 |
| `.hf-cache/` | 固定版本中文 BERT 配置、权重及缓存索引 |

在项目根目录运行 `python -m scripts.prepare_ocnli` 处理当前训练数据，运行 `python -m scripts.download_bert` 准备 BERT 配置与权重。后者不下载分词器，须按[分词器说明](bert-base-chinese-tokenizer/README.md)单独准备。数据划分见[数据处理说明](../../docs/data_preparation.md)，权重版本和哈希见[资源报告](../../reports/bert_assets.json)。

本目录只提交 README，数据、分词器和权重均留在本地。
