# 账号、登录与注册

更新日期：2026-10-18。本轮完成账号入口与访问控制，未执行公网部署。

## 使用

按原方式在 WSL 的 `escnet` 环境运行 `python -m backend.serve`。打开 `http://localhost:5173/`，未登录时进入登录页。页内可切换登录、注册；注册只需要用户名和密码，并在界面再次确认密码。创建成功自动登录，可从页头退出。

用户名为3–24个汉字、英文字母、数字、下划线或短横线；去除首尾空白、全半角归一后检查，英文不区分大小写。密码为8–128个 Unicode 字符，区分大小写，不去空白、不归一化。当前没有找回密码、邮箱验证、管理员管理或第三方登录入口。

资料馆、资料详情、指南与对应只读资料 API 公开。工作台、档案、文稿提取、检索/模型审阅及档案 API 必须登录。登录成功返回之前的站内页面，返回地址只接受已知页面。

## 保存范围

- `data/accounts.db`：账号与会话，已加入 Git 忽略；密码为随机盐 PBKDF2-HMAC-SHA256（600,000次），不保存明文。
- `data/review_history.db`：增加 `owner_id`；列表、详情、报告、意见保存和父版本关联均限制在当前账号。
- `data/costume.db`：原证据库继续只读。
- 浏览器草稿及试用反馈：存储键包含账号 ID；访客反馈使用单独访客空间。草稿不会跨浏览器同步。存储命名空间用于防止应用中的账号误读，并非对同一浏览器设备拥有者加密。

已有无账号档案及旧草稿保留原样，但不会显示为任何新账号的数据，避免首个注册者自动获得旧文稿。没有自动认领或迁移入口；若要归属旧记录，需要另行明确指定账号并备份后迁移。

会话有效期7天，登录时生成新的随机令牌；服务器仅保存令牌哈希，退出后撤销。Cookie 使用 `HttpOnly`、`SameSite=Lax`，浏览器脚本不保存密码或会话令牌。写入请求检查 Origin 与 CSRF，页面请求附账号 ID，防止另一标签页切换账号后把旧页面的文稿写入新账号。登录过期或账号变化时保留当前文稿并提示重新连接或登录。

## HTTP 接口

| 接口 | 请求与结果 |
| --- | --- |
| `POST /api/auth/register` | JSON `{username,password}`，成功201并登录；用户名重复409 |
| `POST /api/auth/login` | 同上，成功200；密码或用户名不匹配401 |
| `GET /api/auth/session` | 登录时200 `{user:{id,username},csrf_token}`；未登录401 |
| `POST /api/auth/logout` | Cookie + Origin + `X-CSRF-Token`，空正文可用；成功200并清除 Cookie |

登录与注册要求同源 Origin。其他写入请求还要求当前会话的 `X-CSRF-Token`。认证尝试按连接地址与用户名限流，超过返回429及 `Retry-After: 300`；计数保存在本进程，重启会清除。没有信任客户端提交的代理 IP 头；反向代理部署时应在入口另外处理真实客户端限流，避免所有用户共享代理连接地址的额度。

## 启动参数与上线边界

默认仍监听 `127.0.0.1:5173`，不会自动对外开放。可配置：

- `--accounts-db PATH` 或 `COSTUME_ACCOUNTS_PATH`：账号库路径。
- `--public-origin https://你的域名` 或 `COSTUME_PUBLIC_ORIGIN`：允许的公网来源；HTTPS 自动启用 Secure Cookie。
- `--secure-cookies` 或 `COSTUME_SECURE_COOKIES=1`：仅 HTTPS 发送 Cookie。
- `--host` / `--port`：监听地址与端口。

上线前需要实际域名、HTTPS 入口、生产服务托管、请求大小/超时/并发与上传资源限制、账号和档案数据库备份及恢复方案。当前服务仍是 Python `ThreadingHTTPServer`，本次没有改造为生产级应用服务器，也没有开通公网端口。上述参数只是认证接入配置，不表示部署工作已完成。

## 验证

新增 `tests/test_auth.py` 验证账号存储、哈希、会话轮换/过期/撤销、Origin/CSRF、私有路由、限流和跨用户档案隔离；`tests/test_account_frontend.cjs` 验证账号请求及草稿隔离；`tests/test_login_frontend.cjs` 验证表单、登录注册、失败恢复、重复提交与返回地址。自动化使用独立临时数据库或内存替身，不写正式账号与文稿。

```bash
python -B -m unittest discover -s tests -p 'test_auth.py' -v
node tests/test_account_frontend.cjs
node tests/test_login_frontend.cjs
```
