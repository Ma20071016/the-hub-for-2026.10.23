# 前端

原生 HTML、CSS 和 JavaScript，无 npm 安装或构建步骤。由 `python -m backend.serve` 提供页面与同源 API；直接双击 HTML 只能预览，无法完成登录或审阅。

| 页面 | 用途 |
| --- | --- |
| `index.html` | 文稿上传、资料选择、逐句审阅、人工意见与改稿复核 |
| `library.html` / `source.html` | 资料馆、藏品图文与原文定位，公开浏览 |
| `archive.html` | 当前账号的审阅档案、搜索和重开 |
| `guide.html` | 使用指南、练习 Word 与本机试用反馈 |
| `login.html` | 登录、注册与返回原页面 |

## 主要模块

- `app.js`：工作台主流程；`account.js`：会话与受保护请求。
- `source-picker.js` / `source-visuals.js`：资料选择与图文对照。
- `sentence-map.js`：句子定位；`draft-store.js` / `workspace-drafts.js`：草稿保存与恢复。
- `workspace-guide.js` / `guide-feedback.js`：操作提示、示例与试用反馈。
- `museum-backdrop.js` / `museum-entry.js`：展厅陈列与入馆动画，支持减少动态效果。
- `downloads/`：练习文稿，由 `scripts/build_review_practice.py` 生成。
- `img/`：馆藏配图与展厅素材，出处见 [library](img/library/README.md) 和 [museum](img/museum/README.md)。

档案保存在服务端并按账号隔离；草稿和反馈仅保存在当前浏览器，清除浏览器数据后会丢失。人工意见需保存，修改正文后需再次复核。

前端回归命令见 [tests/README.md](../tests/README.md)。界面布局、触控和打印效果仍需真实浏览器检查。
