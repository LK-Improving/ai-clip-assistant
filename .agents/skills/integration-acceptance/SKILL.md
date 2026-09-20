---
name: integration-acceptance
description: 对KK剪映的渲染进程、IPC、Agent、Provider和FFmpeg进行跨边界联调验收。
---

# 联调验收

读取需求、契约、UI规格和实际改动。输出到 `.agents/Documents/联调验收/`，按页面入口、IPC 命令/事件、Agent 节点、工程读写、媒体导出、外部不可达、取消/恢复和安全边界记录预期、实际结果和阻塞项。只报告确实执行过的 `pnpm typecheck`、`pnpm smoke` 或 `pnpm smoke:agent`。
