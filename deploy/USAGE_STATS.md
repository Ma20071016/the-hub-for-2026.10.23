# 查看网站使用情况

这是读取现有记录的终端统计工具，不会增加追踪、改数据库或重启网站。脚本需上传到服务器后运行；本机数据库不能代表云端数据。

以下命令中的 `SERVER_IP` 和项目路径需替换为实际值。

## 第一次：在本机 Windows PowerShell 上传

    scp D:\path\to\cmit-2026-costume-verifier\deploy\usage_report.py ubuntu@SERVER_IP:/home/ubuntu/
    ssh ubuntu@SERVER_IP

## 在云服务器 Ubuntu 终端查看

最近7个北京时间自然日，包含今天：

    sudo python3 /home/ubuntu/usage_report.py --days 7

今天，并附账号的注册时间、已保存审阅次数和最近审阅时间：

    sudo python3 /home/ubuntu/usage_report.py --days 1 --users

查看最近30天，把7改为30；日志已经轮转删除的日期无法补查。当前、.1和.gz轮转日志都会读取。输出按北京时间统计，不受服务器UTC时区影响。没有找到日志或数据库时会显示未知，不把缺失当作0。

如需排除自己的公网访问，追加 --exclude-ip 你的实际公网IP。默认仅排除127.0.0.1/::1的回环检查，不会自动识别机器人或你自己的公网IP。

## 看实时原始日志

    sudo tail -n 30 -F /var/log/nginx/costume-access.log

Ctrl+C只退出日志查看，不停止网站。默认日志有请求时间、来源IP、路径、HTTP状态等；没有应用账号与请求正文。不要把含用户IP和记录编号的原始日志公开分享。

## 指标边界

- 独立IP不等于真实人数，页面请求数也不等于人数；包含自动扫描、自己测试、共用网络等情况。
- 网页浏览只统计已知HTML页面的成功GET，不把CSS/JS/图片/API请求误当作浏览。
- 注册、登录、上传提取、保存人工意见、报告等按对应接口状态统计；不代表所有前端点击。
- 流式审阅可能先返回200再失败，实际完成并保存的审阅要看review_history.db；复核的新版本会增加条数。
- 账号表能提供注册时间；已保存审阅能按owner_id统计到账号。当前日志不能可靠地将每次浏览、登录或上传关联到用户名，也没有完整历史登录表。
- 不统计页面停留、按钮点击、未提交草稿。若需要完整后台行为分析，后续应增加明确的事件记录和管理员访问控制。
- 默认只输出汇总；--users附用户名及审阅数量，不读取或输出密码哈希、会话令牌、稿件正文。

参考：Nginx内置combined日志格式 https://nginx.org/en/docs/http/ngx_http_log_module.html ；SQLite只读URI https://www.sqlite.org/uri.html 。
