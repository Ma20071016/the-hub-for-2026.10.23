# 数据与本地资源

| 路径 | 用途 | 是否提交 Git |
| --- | --- | --- |
| [raw/](raw/README.md) | OCNLI 官方原始数据 | 仅 README |
| [processed/](processed/README.md) | 训练数据、中文 BERT 分词器和权重缓存 | 仅 README |
| `costume.db` | 资料与已审核证据库 | 否 |
| `review_history.db`、`accounts.db` | 审阅记录、账号及会话 | 否 |
| [library_visuals.json](library_visuals.json) | 5 份藏品、9 张配图和 18 个原文对照点 | 是 |

当前训练读取 `processed/ocnli_50k/`。数据来源、划分与准备步骤见[数据处理说明](../docs/data_preparation.md)；数据库使用见[后端说明](../backend/README.md)。

配图清单按来源、对象及原文引文绑定展示内容，不修改证据库，也不参与模型推理。图片来源与使用限制见[配图说明](../frontend/img/library/README.md)。
