# 传统服饰说明核验

面向传统服饰介绍文稿的辅助审阅工具，也是 2026 年全国大学生数字媒体科技作品及创意竞赛项目。上传 Word / PDF，选择资料后逐句比对证据，记录人工意见、修改复核并导出报告。

## 可以做什么

- **文稿审阅**：支持 `.docx`、文字型 PDF 和粘贴文本，展示逐句结果、证据原文及出处。
- **资料馆**：搜索服饰对象与资料，查看图文对照、原文定位和馆方来源。
- **修改与留档**：定位改句、复核生成新版本、保存人工意见、重开档案和导出 HTML 报告。
- **账号与草稿**：登录后按账号隔离档案；本机草稿自动暂存，支持手动恢复与导出。
- **使用指南**：提供练习 Word 和三步体验流程，资料馆与指南无需登录。

## 本地运行

前端使用原生 HTML / CSS / JavaScript，**不需要 npm**；Python 后端同时提供网页、SQLite 接口和 PyTorch 模型推理。现有开发环境为 WSL Ubuntu + Conda `escnet`，CPU 部署依赖见 [deploy/requirements.txt](deploy/requirements.txt)。

仓库保存代码、文档、测试及展示素材，**不含数据库、训练数据和模型权重**。首次克隆后需准备下列资源，单独下载代码不能直接启动完整系统：

| 资源 | 位置 / 说明 |
| --- | --- |
| 已审核证据库 | `data/costume.db`，建库与导入见 [backend/README.md](backend/README.md) |
| BERT 分词器与权重 | `data/processed/`，下载及路径约定见 [scripts/README.md](scripts/README.md) |
| 已训练分类头 | `runs/ocnli_50k_20261007_01/best.pt`，需已有权重或按训练流程生成 |

在已配置依赖和资源的 WSL 终端，从项目根目录运行：

```bash
conda activate escnet
python -m backend.serve
```

模型加载完成后访问 `http://localhost:5173/`，注册或登录后进入工作台。端口占用时可加 `--port 5174`；按 `Ctrl+C` 停止服务。账号和审阅数据库在首次启动时自动创建，不提交到 Git。

推荐体验：打开使用指南 → 下载练习 Word → 上传并选择绿棉袍资料 → 审阅 → 对照证据修改一句 → 复核并导出报告。报告可通过浏览器打印为 PDF。

## 目录与文档

| 目录 | 内容 |
| --- | --- |
| [frontend](frontend/README.md) | 工作台、资料馆、档案、指南与登录页面 |
| [backend](backend/README.md) | 账号、证据检索、模型推理、文稿提取与审阅历史 |
| [models](models/README.md) | BERT 编码与三分类模型 |
| [scripts](scripts/README.md) | 数据准备、资源下载、训练、评估与练习文稿生成 |
| [configs](configs/README.md) | 模型诊断配置 |
| [data](data/README.md) / [runs](runs/README.md) | 本地数据和训练输出的目录约定 |
| [tests](tests/README.md) | Python 与 Node.js 回归测试 |
| [deploy](deploy/README.md) | Ubuntu 发布打包、安装、备份与运维 |
| [docs](docs/README.md) / [reports](reports/README.md) | 技术说明、开发记录、实验与验证结果 |

## 验证

在已安装模型依赖的 Python 环境中：

```bash
python -B -m unittest discover -s tests
```

前端测试只需要 Node.js。Bash / WSL 下运行全部套件：

```bash
for file in tests/test_*.cjs; do node "$file" || exit 1; done
```

PowerShell 命令和分模块说明见 [测试说明](tests/README.md)。

## 当前范围

- 当前整理的资料中有 **43 份可用来源、99 条已审核证据**；页面数量以实际数据库为准。检索使用对象名称、别名、馆藏编号和关键词，尚未实现语义检索。
- 模型为基于 ESCNet 共享原型立场模块的文本三分类改编，尚无图像核验分支。OCNLI 50k 清洗后训练样本为 37,072 条，验证 Macro-F1 为 **0.6495**、准确率为 **64.64%**；这不是服饰领域准确率。
- 五态结果、模型分数和覆盖率都用于辅助人工审阅，不能证明文稿真实；当前仍有误判，详见 [实验记录](docs/experiment_log_2026-10-10.md)。
- 上传上限 10 MiB；暂不支持旧版 `.doc`、扫描 PDF 或图片 OCR。本机草稿仅保存在当前浏览器，不跨设备同步。
- 当前面向小规模演示，模型串行处理请求。公开部署需按 [部署说明](deploy/README.md) 配置 HTTPS、备份并完成服务器实测。

馆藏图片保留原始出处、署名和水印，使用范围见 [资料配图说明](frontend/img/library/README.md) 与 [展厅素材说明](frontend/img/museum/README.md)。更多进度见 [开发记录](docs/development_log.md)。
