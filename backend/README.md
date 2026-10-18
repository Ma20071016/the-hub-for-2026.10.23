# 后端

Python 标准库 HTTP 服务，负责账号、资料检索、模型核验、审阅留档和报告导出。前端位于 [`frontend/`](../frontend/)，模型训练脚本位于 [`scripts/`](../scripts/)。

## 启动

从项目根目录运行；现有开发环境为 WSL 的 `escnet`：

```bash
conda activate escnet
python -m backend.serve
```

模型加载后访问 `http://localhost:5173/`，首次使用先注册账号。默认仅监听 `127.0.0.1`；端口占用可加 `--port 5174`，按 Ctrl+C 停止。

**仅克隆仓库不能直接运行模型服务**，还需要以下本地资源：

- PyTorch、Transformers；文档上传另需 `pypdf`、`python-docx`，安装见 [部署说明](../deploy/README.md)。
- `data/costume.db`：已导入来源并审核证据的数据库。
- `data/processed/bert-base-chinese-tokenizer/`：本地分词器。
- `reports/bert_assets.json` 中 `snapshot_directory` 指向的冻结 BERT。
- `runs/ocnli_50k_20261007_01/best.pt`：与当前模型结构匹配的训练权重。

模型启动时加载一次，优先使用 CUDA，否则使用 CPU。账号、HTTPS 和反向代理参数见 [账号说明](../docs/accounts.md)；当前服务使用 `ThreadingHTTPServer`，公网部署还需 HTTPS、资源限制和数据备份。

## 代码与数据

| 文件 | 职责 |
| --- | --- |
| [`serve.py`](serve.py) | 页面路由、检索、逐句/整篇核验及 HTTP 接口 |
| [`auth.py`](auth.py) | 用户名密码、会话、CSRF 与登录限流 |
| [`init_db.py`](init_db.py)、[`import_sources.py`](import_sources.py) | 建库、导入来源、切分和审核证据 |
| [`inference.py`](inference.py) | 加载模型，逐对预测说明与证据的关系 |
| [`text_prepare.py`](text_prepare.py)、[`document_upload.py`](document_upload.py) | 文字清洗、切句及 PDF/DOCX 文字提取 |
| [`library.py`](library.py)、[`library_visuals.py`](library_visuals.py) | 资料馆、原文定位、图片与证据热点 |
| [`review_history.py`](review_history.py) | 审阅快照、人工意见、版本与 HTML 报告 |

网站只读 `data/costume.db`；启动时自动初始化独立的 `data/accounts.db` 和 `data/review_history.db`。账号、会话和审阅记录不提交 Git，已保存档案按账号隔离。旧的无账号记录不会自动归给新账号；浏览器草稿仅存于本机浏览器。

## 准备证据库

将示例路径替换为包含 `资料清单.jsonl` 的实际资料目录：

```bash
python -m backend.init_db
python -m backend.import_sources "/path/to/source-archive" --check
python -m backend.import_sources "/path/to/source-archive"
python -m backend.import_sources --split --check
python -m backend.import_sources --split
python -m backend.import_sources --review 2
```

建库不会清空已有数据；`--check` 仅预览。切分生成 `pending` 草稿，审核时核对原文、对象及适用范围后才能标为 `approved`。`--review ID --check` 只读查看指定片段；已有精选归档也可用 `--starter --check` 预览首批 5 份资料的 8 条建议证据，再用 `--starter` 人工确认保存。资料导入和审核不运行模型。

只有 `approved` 片段进入检索及资料馆证据列表。`locator` 使用 `chars:起点:终点`，必须精确对应来源原文；按 Python Unicode 字符计数，从 0 开始、含起点不含终点。完整原文用于核对上下文，不表示每句话均已审核。迁移原资料时须核对 `archive_path`。历史审核见 [证据审核记录](../reports/evidence_review_2026-10-14.md)。

## HTTP 接口

资料馆、资料详情、指南及只读资料 API 公开；工作台、档案、提取、检索和核验需要登录。写请求检查同源 `Origin` 与 `X-CSRF-Token`，前端另附 `X-Account-ID` 防止切换账号后误写。登录/注册及 Cookie 约定见 [账号接口](../docs/accounts.md#http-接口)。

| 接口 | 用途 |
| --- | --- |
| `GET /api/sources` | 含已审核证据的来源与片段数 |
| `GET /api/library`、`GET /api/library/{id}` | 目录、筛选项、来源详情、对象、证据与全文 |
| `POST /api/extract` | 提取文字型 PDF/DOCX；文件上限 10 MiB、正文上限 50,000 字符 |
| `POST /api/search` | JSON `{claim, source_id}`；来源可省略，仅检索候选 |
| `POST /api/verify` | 同上，但要求选定来源；逐条返回模型标签和分数 |
| `POST /api/review` | 整篇审阅并保存新快照，约定见下文 |
| `GET /api/reviews?limit=50` | 当前账号的档案摘要，`limit` 范围 1–100 |
| `GET /api/reviews/{review_id}` | 重开完整快照及人工意见，不重新推理 |
| `POST /api/reviews/{review_id}/decisions` | 按修订号保存完整逐句人工意见 |
| `GET /api/reviews/{review_id}/report?revision=N` | 导出 HTML 报告，可打印为 PDF；修订号不匹配返回 409 |

上传请求使用 `Content-Type: application/octet-stream`、`X-Document-Type: pdf` 或 `docx`，正文直接发送文件字节；不是 multipart 表单。其余业务 POST 接口使用 JSON。

检索按对象名、别名或馆藏编号找候选，再按关键词和原文重合排序，最多返回 5 条；颜色、材质不是必须相同的筛选条件。`/api/search` 的 `model_status: not_connected` 仅表示本次没有运行模型。`/api/verify` 缺少资料或证据时返回 `needs_context` / `no_evidence`，不作预测。

资料馆不返回本地归档路径。图片清单位于 [`data/library_visuals.json`](../data/library_visuals.json)，出处与署名见 [图片说明](../frontend/img/library/README.md)。图片须匹配来源和已审核对象，热点引用当前唯一匹配的已审核原文；无图或清单错误时保留文字资料。图片不作为模型输入。

## 整篇审阅接口

`POST /api/review` 接收 `{"text":"正文","source_id":1,"title":"文稿名称"}`。正文非空且最多 50,000 个 Python 字符；来源必须存在；标题可省略，提供时为 1–120 字符。复核时附 `parent_id`，须指向当前账号已有的 32 位小写十六进制记录编号。句中明确对象先跨资料检索，未找到时再使用所选资料。

响应 `schema_version: 2`；`results` 按正文顺序保留每句及其位置、原因、证据和模型分数：

| `status` | 含义 |
| --- | --- |
| `supported` | 至少一条支持预测，且无反驳预测 |
| `refute` | 至少一条反驳预测，且无支持预测；界面显示疑似矛盾 |
| `insufficient` | 入选证据均被模型判为信息不足 |
| `conflicting` | 同时出现支持和反驳预测 |
| `uncovered` | 没有证据或字面相关性不足，未送入模型 |

`sentence_start` / `sentence_end` 基于 `normalized_text` 的 Python 字符位置，含起点不含终点；前端须转换成 UTF-16 下标，不能直接用于原文件定位。`coverage_ratio` 是送入模型句数占正文句数的比例，不是准确率；无正文时为 `null`。兼容字段 `problems` 仅含疑似矛盾，不能代替完整 `results`。

普通请求返回 JSON；设置 `Accept: application/x-ndjson` 后依次返回 `start`、`sentence`、`done`，失败为 `error`。只有快照保存成功才报告完成，并返回 `review_id`、`parent_id`、`created_at`、`model_version` 和人工意见字段。断开浏览器连接不保证取消服务端推理，可从档案确认结果。

## 人工意见与版本

每次审阅保存正文、证据和模型结果的新快照，复核用 `parent_id` 关联，不覆盖旧版。修改正文后须重新审阅；未复核草稿不会混入旧报告。

保存意见的请求只能包含 `expected_revision` 和完整 `decisions` 列表；每项为 `{index,state,note}`，须完整覆盖正文句子且索引唯一。状态为 `unreviewed`（未处理）、`confirmed`（确认有误）、`dismissed`（保留原句）、`pending`（待补证），备注最多 2,000 字符。保存成功增加 `decisions_revision`，旧修订号返回 409。人工意见不会修改模型判断；复核新版本的意见重新初始化。

## 使用边界

- 扫描 PDF、图片 OCR 和旧版 `.doc` 暂不支持；请上传文字型 PDF 或 `.docx`。
- 当前为小规模字面检索，句中对象不明确、多对象来源和否定表达仍可能误检或误判。单件藏品证据不能推广到整类服饰。
- 单句说明上限 500 个 UTF-16 代码单元；模型的说明与补充对象后的证据分别限 160 token，超长返回 422，不静默截断。推理串行，忙时返回 429。
- 模型标签和分数仅供核对线索；未检出矛盾、覆盖率和流程测试都不证明稿件正确或领域准确率达标。测试入口见 [`tests/`](../tests/README.md)。
