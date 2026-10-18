# 本地中文 BERT 分词器

供 `scripts/model_data.py` 离线编码 claim/evidence。

- `tokenizer.json`：快速分词器的完整规则。
- `tokenizer_config.json`：分词器类型及加载配置。
- `special_tokens_map.json`：`[CLS]`、`[SEP]`、`[PAD]` 等特殊 token 映射。
- `vocab.txt`：21,128 项词表，行号对应 token ID。

来源为 `google-bert/bert-base-chinese`，revision 为 `8f23c25b06e129b6c986331a13d8d025a92cf0ea`，与本地 BERT 权重一致。

在已安装项目依赖的环境中，从项目根目录执行以下命令下载固定版本：

```bash
python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('google-bert/bert-base-chinese', revision='8f23c25b06e129b6c986331a13d8d025a92cf0ea').save_pretrained('data/processed/bert-base-chinese-tokenizer')"
```

仅本说明纳入 Git，分词器文件留在本地。`scripts.download_bert` 仅下载模型配置和权重，不包含本目录文件。
