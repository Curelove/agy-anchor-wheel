---
name: anchor-wheel-edits
description: >-
  Read user-authored document edit records and unified diffs saved in Antigravity's right sidebar via AnchorWheel (`agy-anchor-wheel`). Activate whenever the user asks AI to inspect, review, or continue from edits they just made to a `.md`, `.json`, `.txt`, or config/code document in the sidebar ("看看我刚才改了什么", "查看我在侧边栏的修改记录", "看我的文档编辑记录").
---

# 查看用户在侧边栏的文档编辑记录 (`anchor-wheel-edits`)

当用户使用「锚点轮盘 · AnchorWheel」插件在 Antigravity 右侧边栏直接编辑并自动保存 `.md`、`.json`、`.txt` 等文档时，插件会自动将每次编辑会话的前后差异（`unified diff`、修改时间与增删行数）持久化写入本地记录文件。

## 读取方式

当用户提到「看看我在这个文档里改了什么」「查看我的编辑记录」或要求结合其刚刚的手工修改继续处理时，按以下顺序用 `read_file` 读取最新的用户编辑记录：

1. **优先读取 Sidecar 运行时记录**：
   - Windows：`~/.gemini/antigravity/sidecar_data/agy-anchor-wheel/anchor_wheel/data/edit_history/RECENT_USER_EDITS.md`
   - macOS / Linux：`~/.gemini/antigravity/sidecar_data/agy-anchor-wheel/anchor_wheel/data/edit_history/RECENT_USER_EDITS.md`
2. **独立工作台回退路径**（若上述文件不存在或时间较旧）：
   - `~/.gemini/config/plugins/agy-anchor-wheel/data/edit_history/RECENT_USER_EDITS.md`
3. **补充核对当前磁盘文件全文**：
   - 读完 `RECENT_USER_EDITS.md` 定位用户修改的具体行号与意图后，再用 `read_file` 读取目标文档本身，确保上下文完整一致。
