# processed：处理数据与本地资源

保存可直接加载的数据及固定版本 BERT 资源。

- [ocnli/](ocnli/README.md)：3k 实验数据，训练 2,993 条、验证 2,950 条。
- [ocnli_50k/](ocnli_50k/README.md)：当前加载目录，训练 37,072 条、验证 2,950 条；已清洗并隔离同源分组。
- [bert-base-chinese-tokenizer/](bert-base-chinese-tokenizer/README.md)：本地分词器配置和词表。
- `.hf-cache/`：Hugging Face 缓存，包含 BERT 配置、safetensors 权重和版本索引；路径与哈希见[资源报告](../../reports/bert_assets.json)。

数据加载入口为 `scripts/model_data.py`；权重准备入口为 `scripts/download_bert.py`。此目录仅 README 纳入 Git。
