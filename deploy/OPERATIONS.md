# Ubuntu 24.04 部署指南：先用公网 IP 测试

准备日期：2026-10-18。原准备环境为腾讯云轻量应用服务器、Ubuntu 24.04、2 核 / 4GB。命令中的 SERVER_IP、本机项目路径和对应 WSL 路径均需替换为实际值。

**验证范围：此文记录本地部署准备与服务器操作流程，不代表目标服务器已完成验收。** 这是低并发演示部署；正式使用还需域名、HTTPS 和服务器实测。以下命令分清“本机 Windows PowerShell”和“云服务器 Ubuntu 终端”，不要混用。

## 1. 部署的是什么

这个应用不需要 npm。网页、账号、资料接口和模型推理由同一个 Python 后端提供；Nginx 监听 80，把请求转交给仅监听本机的 127.0.0.1:5173。systemd 负责开机启动与异常重启。

发布包包含网页、Python 代码、分词器、约 411MB 的冻结 BERT 权重、已训练分类头、资料图片和真实证据库。仅 git clone 或上传 frontend 都不足以运行。

发布包不包含本机账号、会话或审阅档案。证据库使用 SQLite 一致性备份复制，副本里的历史核验记录被清空并整理；原始数据库保持不变。服务器首次启动后创建自己的账号库和审阅库，需重新注册测试账号。实际数据为 50 份来源、655 条片段，其中 99 条已审核证据；网页只显示含可用证据的资料。

## 2. 腾讯云控制台：登录准备与防火墙

1. 在该实例页面点 **登录**；也可在“重置密码”中设置 Ubuntu 登录密码，再用下方 SSH。Ubuntu 默认用户名是 ubuntu，不是 root。密码只在腾讯云或终端输入，不要粘贴到聊天里。
2. 打开实例控制台的 **防火墙** 标签，确认入站 TCP 22 允许你的电脑访问。不要删除现有 SSH 规则。
3. 第一次先上传和安装，不必立刻开放网站。需要用公网 IP 测试时，新增 HTTP / TCP 80 允许规则；仅自己测试时来源可限定为自己当前公网 IP/32，需要其他人测试时再按实际范围放行。
4. **不开放 5173**。后端仅允许 Nginx 访问。443 留待配置 HTTPS 时放行。

腾讯云的云防火墙和 Ubuntu 的 UFW 是两层配置。本安装脚本不修改两者，也不自动启用 UFW。若安装后外网不通，在服务器执行 sudo ufw status verbose；只有显示 active 时，按实际范围添加 sudo ufw allow 80/tcp。不要为了网站直接关闭所有防火墙。

腾讯云《是否需要备案》明确允许：域名不指向境内云资源、仅通过服务器公网 IP 直接访问测试，可暂不备案。这里仅做临时 IP 测试；日后把域名指向北京服务器提供网站服务时，先按腾讯云要求办理 ICP 备案。此说明不是绕过备案的长期方案。

## 3. 本机 Windows PowerShell：上传

先按第 9 节生成发布包，两个输出文件位于项目 dist 目录：

- costume-verifier-ubuntu.tar.gz
- costume-verifier-ubuntu.tar.gz.sha256

打开本机 PowerShell，复制运行：

    cd D:\path\to\cmit-2026-costume-verifier
    scp .\dist\costume-verifier-ubuntu.tar.gz .\dist\costume-verifier-ubuntu.tar.gz.sha256 ubuntu@SERVER_IP:/home/ubuntu/

首次 SSH 会提示主机指纹，请与腾讯云实例信息/可信控制台核对；确认是自己的服务器后接受。随后输入 ubuntu 的服务器密码，终端不显示密码字符是正常现象。若使用 SSH 密钥，在 scp / ssh 后加 -i 私钥路径。上传包约数百 MB，等待命令结束再继续。

然后登录：

    ssh ubuntu@SERVER_IP

如果 SSH 不通，先用腾讯云控制台“登录”检查实例与 22 端口。若报 Permission denied，检查用户名 ubuntu、密码或密钥，而不是反复修改应用文件。

## 4. 云服务器 Ubuntu 终端：校验、解压、安装

现在终端应该显示 ubuntu@…，在这里运行：

    cd /home/ubuntu
    sha256sum -c costume-verifier-ubuntu.tar.gz.sha256

必须显示 OK。不是 OK 就重新上传，不要忽略校验错误。首次安装再执行：

    tar -xzf costume-verifier-ubuntu.tar.gz
    cd cmit-2026-costume-verifier
    sudo bash deploy/install-ubuntu.sh SERVER_IP

此脚本只面向 **Ubuntu 24.04、x86_64、尚未配置网站的服务器**。发现既有 Nginx 或非本脚本管理的应用目录会停下，避免覆盖已有站点。它会：

1. 安装 Python venv、Nginx、cron 等系统依赖。
2. 将应用安装到 /opt/costume-verifier，以专用非 root 用户 costume 运行。
3. 安装 CPU 版 torch 2.7.0 及项目依赖；无需 CUDA，无需重新训练模型。
4. 校验模型 SHA-256、数据库、真实模型预测和 Word 提取。
5. 安装 systemd 和 Nginx，等真实资料接口成功后才显示 READY。
6. 安排数据库每日备份并立即备份一次，保留最近 14 次成功备份。

安装需要从 Ubuntu、PyTorch 和 PyPI 下载依赖，具体时间取决于网络。若下载超时，保留错误输出，网络恢复后从同一个解压目录重跑安装命令；它保留 /opt 中已有数据库。不要换来历不明的安装脚本或下载模型，也不要把这个首次安装脚本当作以后更新代码的通用工具。

安装器不会配置额外 swap，也不会宣称 4GB 可以支持多人并行审阅。服务内存上限为 3GiB，超过会被终止并由 systemd 重启；应按下方方式观察实际内存。模型本身一次只处理一份审阅，其他推理请求忙时会返回 429。

## 5. 服务器与浏览器验收

先在 Ubuntu 终端执行：

    sudo systemctl status costume-verifier --no-pager
    sudo nginx -t
    curl -f http://127.0.0.1:5173/api/sources
    curl -f -H 'Host: SERVER_IP' http://127.0.0.1/api/sources
    sudo ss -lntp

预期：服务 active (running)、Nginx 校验成功、两个 curl 返回真实资料列表；5173 只绑定 127.0.0.1，80 由 Nginx 监听。

云防火墙放行 TCP 80 后，本机浏览器用以下地址：

    http://SERVER_IP/library.html

先确认资料馆、图片和来源详情能显示，再打开：

    http://SERVER_IP/

首页未登录跳转登录页是正常行为。**当前是明文 HTTP，只使用一次性测试密码和示例文稿，不用常用密码或真实敏感文稿。** 完整演示按以下步骤验收：

1. 注册测试账号，确认登录后进入工作台。
2. 打开“使用指南”，下载示例 Word，上传后确认正文可提取。
3. 选择绿棉袍资料，运行审阅，观察逐句进度。
4. 保存人工意见，打开审阅档案，重新打开记录并导出报告。
5. 退出后注册另一测试账号，确认不能看到前一个账号的档案。
6. 在服务器重启服务后，确认第一个账号及档案仍存在：sudo systemctl restart costume-verifier。

必须在云服务器完成这些检查，才能说“部署成功”。本地检查不等于云端验证。

## 6. 常见问题与日常管理

| 现象 | 检查与处理 |
| --- | --- |
| SSH 超时 | 实例运行状态、正确 IP、云防火墙 TCP22、当前网络 |
| 浏览器连接超时 | 云防火墙 TCP80；Ubuntu UFW 是否启用；Nginx 是否运行 |
| 显示 Welcome to nginx | 检查 /etc/nginx/sites-enabled 中是否启用了项目配置；访问正确 IP |
| 502 Bad Gateway | 模型正在加载或后端失败；查看下方 journalctl，不要靠开放5173解决 |
| 注册403 / 登录立即失效 | 浏览器地址应准确为 http://SERVER_IP；环境文件 PUBLIC_ORIGIN 要一致；HTTP 测试必须 SECURE_COOKIES=0 |
| 429 | 模型忙或入口/认证限流；等待后再试。后端通过 Nginx 时所有人共享每5分钟30次登录/注册尝试额度，这是当前演示版本限制 |
| 上传413 | 文件超过10MiB；缩小文件，Word 用 .docx |
| 审阅较慢 | CPU 推理速度取决于文稿和并发；先短文验证，不要增加多个 worker 复制模型 |
| 模型文件不存在 | 校验上传包；不能只 git clone 或上传网页。不要运行建库脚本替换真实证据库 |
| 安装报 Python 版本/架构不符 | 执行 cat /etc/os-release 和 uname -m，确认 Ubuntu24.04 x86_64 |

日志、重启、内存：

    sudo journalctl -u costume-verifier -n 100 --no-pager
    sudo tail -n 80 /var/log/nginx/costume-error.log
    sudo systemctl restart costume-verifier
    sudo systemctl show costume-verifier -p MemoryCurrent -p MemoryPeak
    free -h

代理读取超时设置为 1800 秒，指相邻响应数据之间的空闲时间，不是取消计算时限。浏览器断开并不会立即停止已开始的模型推理。当前仍为 Python ThreadingHTTPServer 加入口保护的小规模演示，尚未改造成面向高并发的生产应用服务器。

## 7. 备份与恢复

安装后每天服务器本地时间 03:17 用 SQLite backup API 备份三份数据库，输出到 /var/backups/costume-verifier/backup-…，目录名时间为 UTC。保留最近14次成功快照；同盘备份无法抵御整机丢失，重要数据应再复制到可信的独立存储。

手动备份：

    sudo /opt/costume-verifier/.venv/bin/python /opt/costume-verifier/deploy/backup.py
    sudo ls -lt /var/backups/costume-verifier

在线备份保证每个数据库内部一致；涉及跨库恢复或迁移，先停止服务再备份，避免账号和档案处于不同时间点。账号、证据、档案三份库应一起保存。

如需恢复，**只在确实要恢复时**按以下流程执行；先把 BACKUP_DIR 改成已确认的具体备份目录。备份含账号哈希、会话和文稿，不能放到网页目录或公开仓库。

    sudo systemctl stop costume-verifier
    sudo /opt/costume-verifier/.venv/bin/python /opt/costume-verifier/deploy/backup.py --output /var/backups/costume-verifier-before-restore
    BACKUP_DIR=/var/backups/costume-verifier/backup-替换成实际目录名
    sudo /opt/costume-verifier/.venv/bin/python /opt/costume-verifier/deploy/restore.py "$BACKUP_DIR"
    sudo systemctl start costume-verifier
    curl -f http://127.0.0.1:5173/api/sources

恢复脚本会要求服务已停止、检查三份备份的完整性，再替换应用数据库；不会自动重启服务。恢复旧备份可能恢复当时的会话，若涉及泄露需另行撤销会话。

## 8. 有域名之后

针对北京实例，先完成适用的 ICP 备案和 DNS 解析，然后配置 HTTPS 证书/续期与 Nginx443入口，并将 /etc/costume-verifier.env 中的来源改为 https://实际域名，设置 COSTUME_SECURE_COOKIES=1，重启后端并验证登录/上传/流式审阅。最后把 HTTP 重定向到 HTTPS。不要仅把 IP 改成域名就开始收集真实用户密码。

## 9. 重新生成发布包（仅本机）

改完代码并验证后，在 Windows PowerShell 中：

    cd D:\path\to\cmit-2026-costume-verifier
    wsl /usr/bin/python3 /mnt/d/path/to/cmit-2026-costume-verifier/deploy/build_release.py

必须从 WSL 读取模型缓存：其中的权重是 Linux 软链接，Windows 文件信息可能显示为零字节。构建器会解引用并核对权重 SHA-256，生成独立可解压的包。构建不代表已更新云端，也不会迁移云端已有账号。后续更新先备份服务器数据库，再设计替换代码步骤，不能用旧发布包覆盖服务器数据。

## 官方依据

2026-10-18 已读取以下官方页面核对；后续以腾讯云当时的页面和实例控制台为准。

- 腾讯云《管理实例防火墙》：https://cloud.tencent.com/document/product/1207/44577
- 腾讯云《使用第三方 SSH 终端登录 Linux 实例》：https://cloud.tencent.com/document/product/1207/44578
- 腾讯云《是否需要备案》：https://cloud.tencent.com/document/api/243/19630
- PyTorch 历史版本与 CPU 安装源：https://pytorch.org/get-started/previous-versions/
- Nginx 代理与流式缓冲：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
