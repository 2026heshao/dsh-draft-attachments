# dsh-draft-attachments

DeepSeek Harness（DSH）插件：**把输入框的草稿图片/文件像文字草稿一样持久化**。桌面端与 Web 端通用（插件 UI 运行在两端同源的浏览器渲染层，行为一致）。

DSH 的已知行为：在 A 会话输入框上传了几张图片，中途点到其他页面再切回来，输入的文字还在，但上传的图片消失了。本插件修复这个问题——切换页面、切换会话、甚至重启 DSH 之后回到该会话，未发送的附件会自动恢复到输入框，缩略图原样重现。桌面端与 Web 端表现相同。

> **兼容性**：已在 DeepSeek Harness 44.7.0（宿主内置 `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2` / cordis 4.0.5）上全量测试通过；声明的 peer 范围 `>=0.1.5-rc.1` 继续覆盖，本版本无需代码改动。

## 原理

| | 文字草稿（官方） | 附件草稿（官方） | 附件草稿（本插件） |
|---|---|---|---|
| 存储 | localStorage（`dsh.conversation.<sessionId>`） | 仅内存（`draftAttachments` Map + `attachmentIds` 数组） | IndexedDB（字节 + 元数据，按会话记序） |
| 重挂载 | 自动 seed 回输入框 | 被 release（objectURL revoke + Map 删除）→ 丢失 | 读回 IndexedDB → 官方 `createDrafts` 通道重建 |

- **捕获**：插件在 `conversation.input.dock`（官方 list 型会话级插槽，hero/composer 两种输入区形态都渲染）挂一个不可见哨兵组件，订阅输入态的 `attachmentIds`，每次变化把草稿附件字节写入 IndexedDB（300ms 去抖；卸载/切换会话时立即冲刷）。
- **恢复**：输入区重新挂载时读回记录，走 `conversation.createDrafts(sessionId, files)`（与点输入框「添加附件」完全同一条官方通道）重建草稿，再经 `inputActions.addAttachments` 回填 → 官方缩略图 rail 原样显示。
- **清空同步**：发送成功或手动删除附件后 `attachmentIds` 变化，捕获写入同样集合（空集合 = 清除记录），**不会复活已发送的图片**。

不 patch 任何官方函数；全部通过官方插槽与官方服务公开方法实现。任何一步失败只 `console.warn`，最坏退化为官方原行为（附件照旧丢失），绝不影响正常输入。

## 限制

- 单附件 ≤ 30 MB，单会话合计 ≤ 120 MB（超限的附件不持久化，行为同官方）。
- 附件恢复后走官方重新上传/编码流程（图片重建 objectURL 预览；文件类草稿会重新进入后台上传）。
- 恢复时机是「输入区挂载且当前没有附件」；若在提交锁定相位（adjudicating/submitting）挂载，回填会被拒绝并释放草稿，等下次挂载再试。

## 安装

装进哪个 profile，就在哪个端生效：`web` profile = 浏览器/网页版，`desktop` profile = 桌面应用（两处都装则两端都有）。

1. 在 `~/.dsh/profiles/<profile>/package.json`（桌面端为 `~/.dsh/profiles/desktop/package.json`）的 `dependencies` 加入：
   ```json
   "dsh-draft-attachments": "file:D:/桌面/AI Port/DSH plugins/dsh-draft-attachments"
   ```
2. 在同一文件 `dsh.profile.bundles` 数组加入 `"dsh-draft-attachments"`。
3. 在 profile 目录执行 `pnpm install`。
4. 重启 DeepSeek Harness。

卸载 = 从上面两处移除条目 + `pnpm install` + 重启，无残留（插件数据只存在于浏览器的 IndexedDB `dsh-draft-attachments` 库，可在 DevTools 清除）。

## License

MIT
