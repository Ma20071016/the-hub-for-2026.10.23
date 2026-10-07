# bert-base-chinese-tokenizer：本地中文分词器

供 `scripts/model_data.py` 离线编码 claim/evidence。

- `tokenizer.json`：快速分词器的完整规则。
- `tokenizer_config.json`：分词器类型及加载配置。
- `special_tokens_map.json`：`[CLS]`、`[SEP]`、`[PAD]` 等特殊 token 映射。
- `vocab.txt`：21,128 项词表，行号对应 token ID。

来源为 `google-bert/bert-base-chinese`，revision 为 `8f23c25b06e129b6c986331a13d8d025a92cf0ea`，与本地 BERT 权重一致。
