# Daily Hub

一个 Obsidian 整页主页插件，围绕「按日期命名的笔记」（`YYYY-MM-DD.md`）来组织日常记录和各个项目。适配手机。

A full-page home view for Obsidian built around date-named notes (`YYYY-MM-DD.md`): heatmap calendar, per-project timelines, one-tap note creation, and optional AI sorting of your daily journal into project notes. Works on desktop and mobile.

## 功能

- **热力日历**：颜色越深表示当天笔记越多；支持月视图 / 周视图，手机上左右滑动翻页。
- **今日内容**：「日期记录」和每个项目一个按钮，已有笔记显示 ✓ 直接打开，没有则一键新建。
- **当天内容**：日期记录固定排在最前，其余按你设定的项目顺序显示；可按项目筛选，长笔记自动折叠。
- **项目时间线**：在日历上方选择一个项目，日历只高亮该项目的日期，并按月列出它所有的记录日期。
- **项目管理**：一键新建项目；上移 / 下移 / 置顶；按近 30 天使用频率自动排序；超出数量的项目收进「更多」。
- **存档**：不再使用的项目可以存档，不会删除文件夹，历史笔记照常显示。
- **AI 整理到项目**：读取当天的日期记录，识别其中属于其他项目的内容，生成简短要点；你确认后写入对应项目当天的笔记。日期记录本身不会被修改，同一天重复运行只会替换上次 AI 写入的那一段。
- **写给自己**：一张可自定义的 Markdown 卡片，放座右铭或提醒。

## 目录约定

默认结构如下（目录名都可以在设置里改）：

```
日期记录/
  2026-10-04.md
项目/
  英语听力/
    2026-10-04.md
  论文/
    综述论文/
      2026-10-03.md
```

`项目` 下含有 Markdown 文件的文件夹、或没有子文件夹的文件夹都会被当作一个项目；`attachments` 等文件夹默认忽略。

## 安装

**通过 BRAT（推荐）**

1. 安装并启用社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 在 BRAT 中选择 *Add Beta plugin*，填入 `Unclesam-13/obsidian-daily-hub`。
3. 在「第三方插件」中启用 **Daily Hub**。

**手动安装**

1. 从 [Releases](https://github.com/Unclesam-13/obsidian-daily-hub/releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放到库的 `.obsidian/plugins/daily-hub/` 目录下。
3. 重新加载 Obsidian，在「第三方插件」中启用 **Daily Hub**。

启用后，点击左侧栏的仪表盘图标，或运行命令「打开主页」。

## AI 设置

AI 整理使用 OpenAI 兼容接口，默认是 DeepSeek：

| 设置 | 默认值 |
| --- | --- |
| 接口地址 | `https://api.deepseek.com` |
| 模型 | `deepseek-chat` |
| API Key | 需要自己填写 |

也可以换成任何兼容 `/chat/completions` 的服务（例如 `https://api.openai.com/v1`）。在「项目说明」里每行写一个 `项目名: 说明`，可以帮助 AI 判断得更准确。

> API Key 保存在插件自己的 `data.json` 中。如果你的库会同步到云端或公开仓库，请注意不要泄露。日期记录的内容只会在你点击「AI 整理到项目」时发送给你配置的接口。

## 设置项

- 主页标题、日期记录目录、项目根目录、忽略的文件夹名、排除的路径前缀
- 今日内容默认显示数量
- 「写给自己」卡片的开关和内容
- 长笔记折叠、手机默认周视图
- 启动时打开主页、新标签页显示主页

## License

MIT

## 发布新版本（维护者）

1. 修改 `manifest.json` 和 `versions.json` 中的版本号。
2. 更新 `.github/release-notes.md`。
3. 提交并推送到 `main`。GitHub Actions 发现这个版本还没有 Release 时，会自动创建同名标签和 Release，并附上 `main.js`、`manifest.json`、`styles.css`。
