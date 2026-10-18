# 测试

后端使用 Python 标准库 `unittest`，前端使用 Node.js 内置测试、VM 与 DOM 替身。所有命令从项目根目录运行；不需要 `npm install`。

## 运行

完整 Python 套件需要 PyTorch、Transformers；BERT 测试使用随机初始化的小模型，无需下载权重或准备正式数据库：

```bash
python -B -m unittest discover -s tests
```

只检查不依赖模型库的服务逻辑：

```bash
python -B -m unittest discover -s tests -p 'test_auth.py' -v
python -B -m unittest discover -s tests -p 'test_review*.py' -v
python -B -m unittest discover -s tests -p 'test_workflow_api.py' -v
python -B -m unittest discover -s tests -p 'test_library*.py' -v
```

运行全部前端测试（Bash / WSL）：

```bash
for test_file in tests/test_*.cjs; do
  node "$test_file" || exit 1
done
```

Windows PowerShell 对应命令：

```powershell
Get-ChildItem tests/test_*.cjs | ForEach-Object {
    node $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "测试失败：$($_.Name)" }
}
```

单独运行前端场景或检查脚本语法：

```bash
node tests/test_workflow_frontend.cjs
node tests/test_login_frontend.cjs
node --check frontend/app.js
```

## 覆盖范围

| 模块 | 测试文件与内容 |
| --- | --- |
| 编码器 | `test_bert_encoder.py`：共享冻结 BERT、形状、mask、梯度及权重加载 |
| 审阅与留档 | `test_review*.py`、`test_workflow_api.py`：五态聚合、字符位置、JSON/NDJSON、快照、人工意见冲突及报告 |
| 账号 | `test_auth.py`、`test_account_frontend.cjs`、`test_login_frontend.cjs`：注册登录、会话、Origin/CSRF、限流、账号隔离与表单恢复 |
| 资料馆 | `test_library*.py`、`test_library_frontend.cjs`、`test_source_visuals.cjs`：已审核证据范围、原文定位、图文绑定、静态路由和异常恢复 |
| 审阅工作台 | `test_workflow_frontend.cjs`、`test_long_review.cjs`、`test_document_entry.cjs`：版本恢复、逐句处理、长文筛选、上传入口与未保存保护 |
| 编辑与草稿 | `test_sentence_map.cjs`、`test_draft_store.cjs`、`test_draft_recovery.cjs`：Unicode 定位、改句、草稿保存与恢复 |
| 选择与引导 | `test_source_picker.cjs`、`test_workspace_guide.cjs`、`test_guide_feedback.cjs`：资料筛选、教学示例、引导与本机反馈 |
| 展厅交互 | `test_museum_library.cjs`、`test_museum_entry.cjs`、`test_museum_backdrop.cjs`：目录、启幕、环形展台、暂停/恢复及低动态模式 |
| 使用统计 | `test_usage_report.py`：日志轮转、明细排序、IP 筛选、隐私字段隐藏、只读数据库和命令行参数 |

## 验证边界

测试使用临时 SQLite 数据库、内存数据或模拟 DOM，不写入正式账号、证据和文稿。HTTP 测试运行真实请求处理器，模型推理使用替身；旧接口套件在隔离服务器中关闭认证，认证套件单独验证真实 Cookie 与权限流程。Windows 无符号链接权限时，相关用例可能跳过，需查看实际输出。

这些检查证明实现行为，不代表服饰领域模型准确率。真实浏览器的桌面/手机布局、键盘操作、图片水印和动画效果需另行验收；历史验证和已知问题见 [开发记录](../docs/development_log.md)，模型评测见 [`reports/`](../reports/README.md)。
