# Issue Tracker：本地 Markdown

本仓库的规格和 issue 保存在 `.scratch/`。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格文件：`.scratch/<feature-slug>/spec.md`
- 实现票据：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 每张票一个文件，从 `01` 开始按依赖顺序编号
- `Status:` 记录 triage 状态
- 评论追加到文件底部的 `## Comments`

技能要求发布到 issue tracker 时，按以上结构创建文件。

`wayfinder` 使用 `.scratch/<effort>/map.md` 作为地图，子票据通过 `Blocked by:`、`Status: claimed` 和 `Status: resolved` 管理依赖与状态。
