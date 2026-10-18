# 部署与运维

面向 **Ubuntu 24.04 x86_64** 的小规模演示部署：Python 后端 + Nginx + systemd。前端无需 npm，CPU 推理无需重新训练模型。

## 先了解

- GitHub 仓库只有代码、文档与展示素材，运行还需要证据库、BERT 分词器和权重、已训练分类头。
- 发布包包含上述运行资源；不包含本机账号、会话和审阅档案，服务器首次启动创建自己的账号与档案库。
- 当前提交中的验证记录是本地验证，见 [VALIDATION.md](VALIDATION.md)；目标服务器仍需按流程验收。

## 发布步骤

1. **本机打包**：在项目对应的 WSL 目录运行：

   ```bash
   /usr/bin/python3 deploy/build_release.py
   ```

   输出 `dist/costume-verifier-ubuntu.tar.gz` 和 `.sha256`。构建器通过 WSL 读取模型软链接并校验资源，原始数据库保持不变。

2. **上传**：在项目根目录的 PowerShell 中，把 `SERVER_IP` 替换成实际服务器公网 IP：

   ```powershell
   scp ./dist/costume-verifier-ubuntu.tar.gz ./dist/costume-verifier-ubuntu.tar.gz.sha256 ubuntu@SERVER_IP:/home/ubuntu/
   ssh ubuntu@SERVER_IP
   ```

3. **首次安装**：在服务器上校验、解压并安装：

   ```bash
   cd /home/ubuntu
   sha256sum -c costume-verifier-ubuntu.tar.gz.sha256
   tar -xzf costume-verifier-ubuntu.tar.gz
   cd cmit-2026-costume-verifier
   sudo bash deploy/install-ubuntu.sh SERVER_IP
   ```

   仅在校验显示 `OK` 后继续。安装器面向新服务器；发现已有非本项目应用目录或 Nginx 时会停止。

4. **验收**：检查服务与 Nginx，打开网站完成注册 → 上传 → 审阅 → 保存意见 → 重开档案 → 导出报告；重启服务后核对数据仍在。

完整的防火墙、上传、验收、故障排查和恢复步骤见 [OPERATIONS.md](OPERATIONS.md)。

## 运维入口

| 文件 | 用途 |
| --- | --- |
| `build_release.py` / `preflight.py` | 构建发布包、检查资源与实际推理 |
| `install-ubuntu.sh` / `requirements.txt` | 首次安装及固定依赖 |
| `costume-verifier.service` / `nginx-*` | 服务托管、反向代理与流式响应 |
| `backup.py` / `restore.py` | 三份 SQLite 数据库的备份和恢复 |
| [USAGE_STATS.md](USAGE_STATS.md) / `usage_report.py` | 查看现有日志与数据库的使用统计 |

后端仅监听 `127.0.0.1:5173`，由 Nginx 对外提供访问。HTTP/IP 仅用于临时测试，使用一次性测试密码和示例文稿；正式使用前配置 HTTPS。模型一次处理一个任务，当前服务不面向高并发。

更新代码前先备份服务器数据库；首次安装脚本不作为通用更新工具。数据库、备份、密钥、模型权重和发布压缩包不提交到 GitHub。
