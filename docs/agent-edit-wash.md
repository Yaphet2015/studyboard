# Agent 正文改动扫光

仅为表现层，不写入 Board、ConceptNode、存档或导出格式。

- `src/model/agent-edit.ts`：集中时间参数 `P`；中英文句末标点、换行切分；句级 LCS diff；按实际画布 y/x 排序；400ms 起步、150ms 错峰、最多 8 张扫光，第 9 张起 120ms 直接替换。减少动态效果走独立时间线。
- `src/components/AgentEditProse.tsx`：旧/新正文同宽叠放。测量旧句第一行顶部并固定扫线触发时间；未变句子的旧节点全程保留，新层只用不可见排版占位符。rAF 只写透明度和高度。结束清除动画元素、排版占位符与 aria-hidden 属性。辅助技术通过临时隐藏正文读取最终值，不使用 aria-live。
- `src/styles.css`：浅色 `#c8442a / 8%`、深色 `#f06a48 / 10%`；下沿 14px mask 渐隐。减少动态效果时深色底色也用 8%。

## 触发入口

`App.tsx` 的 `putBoard(next, record, agent)` 默认为非 Agent。仅以下 Agent 落地调用传入 `true`：

1. canvas agent 的 `commitCanvasRun`（整理、聊天 canvas 请求共用）；草稿结构仍可预览，已有正文保留到提交，防止动画前先闪出新字。
2. AI map/expand 完成后的 gate/applyGate、buildMapFromAI 落地。覆盖合并已有卡片的补充、reExpand 和 gate 内 regen 的最终结果。reExpand 归档/新建的卡片以及尚未上画布的 regen 草稿不播放扫光。
3. 聊天 `editRoute` 应用（包括原 ID 卡片正文被清空）。标题、顺序、重点等未改正文时不触发；移除原先的整卡 route-flash。

`onPatch` 是学习者四拍进度/答案更新，不标记为 Agent。普通编辑、撤销、导入和新建也不标记。正文替换立即进入正常保存数据流；正文改写成功时不额外弹完成提示条。

画布保留改动前的节点坐标，避免 React Flow 高度测量使其他卡跟着重排；结构、标题或下一次非 Agent 正文编辑发生变化后恢复正常布局。紧凑卡面沿用现有两行截断，全文和列表沿用抽屉正文呈现，不把卡面改成全文。

## 验证与截图

- `tests/agent-edit.test.ts`：标点/换行、替换/插入/删除/重复句、连续改句、排序/错峰/8 张上限、来源过滤、减少动态效果。
- `tests/e2e/agent-edit.spec.ts`：使用 fake-atlas 完整 Agent 提交流程，检查新值立即存入、未变句子 DOM 身份、其他卡坐标、行数变化、正文清空、扫光和无障碍层清理、撤销、减少动态效果。
- 截图使用 Playwright 时钟暂停、逐段 `runFor`，定格约提交后 500/1100/2400ms。浅/深各 start、middle、fade 三张，含两张同时改动的卡。开发环境写入 `/workspace/studyboard-agent-edit/shots/`，其他环境写入 Playwright 测试产物目录。

macOS 真机系统代理、签名打包及实际辅助技术朗读需在 macOS 验证；本次没有更改主进程或任何网络路径。

本次 Linux 验证结果：两套 tsc 通过；Vitest 49 个文件 / 454 项通过；Vite build 通过；全套 Playwright 单 worker 120 项通过、53 项按既有平台或截图条件跳过、0 失败。另一次改卡与侧栏专项回归 16 项通过。
