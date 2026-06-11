# Waypoint — 旅行点评平台 (TripAdvisor 风格 Demo)

综合点评网站:酒店 / 餐厅 / 体验活动,共 12 个示例条目(8 家酒店,含真实数据参考的 Støtvig Hotel),
每个条目都有真人风格点评 + Claude 生成的 AI 点评总结。

## 本地运行

```bash
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-xxx npm start
# 打开 http://localhost:3000
```

不设置 `ANTHROPIC_API_KEY` 也能运行,AI 总结会显示本地降级版本。

开发模式(热更新):
```bash
npm run dev          # 前端 http://localhost:5173
node server.js       # 另开终端跑后端,/api 会自动代理
```

## 部署到 Railway 🚂

1. 把这个文件夹推到 GitHub:
   ```bash
   git init && git add . && git commit -m "waypoint"
   git remote add origin <你的仓库地址> && git push -u origin main
   ```
2. 打开 [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**,选择该仓库。
3. Railway 会自动检测 Node 项目:执行 `npm install` → `npm run build` → `npm start`,无需额外配置。
4. 在项目的 **Variables** 标签里添加环境变量:
   - `ANTHROPIC_API_KEY` = 你的 Anthropic API key(在 console.anthropic.com 获取)
   - 可选:`ANTHROPIC_MODEL`(默认 `claude-sonnet-4-20250514`)
5. 在 **Settings → Networking** 点 **Generate Domain**,拿到公开网址。

> `PORT` 由 Railway 自动注入,server.js 已经读取 `process.env.PORT`,不用手动设。

## English quick-deploy

Push to GitHub → Railway "Deploy from GitHub repo" → add `ANTHROPIC_API_KEY` in Variables →
Generate Domain. Build (`npm run build`) and start (`npm start`) are auto-detected.

## 项目结构

```
├── server.js          # Express:托管前端 + /api/summarize(服务端调用 Anthropic,key 不暴露给浏览器)
├── index.html         # 入口 + Google Fonts
├── vite.config.js
└── src/
    ├── main.jsx
    ├── App.jsx        # 全部 UI:探索页、详情页、点评、AI 总结、写点评
    └── data.js        # 12 个条目 + 示例点评(加酒店就改这个文件)
```

## 添加新酒店

编辑 `src/data.js`:
1. 在 `LISTINGS` 数组里加一个对象(id、name、rating、subRatings、amenities…)
2. 在 `REVIEWS_BY_LISTING` 里用同样的 id 加几条点评
3. 重新部署即可。

## 说明

- 所有条目和点评均为演示样本数据(Støtvig 的评分/设施参考了其公开页面,点评为原创示例)。
- AI key 只存在于服务端环境变量,前端通过 `/api/summarize` 调用,不会泄露。
- 生产化方向:数据库(Railway 可一键加 Postgres)、用户登录、真实照片授权、点评审核。
