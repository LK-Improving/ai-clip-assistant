---
name: api-backend-delivery
description: 依据契约交付KK剪映主进程、Agent、IPC、媒体处理和Provider适配能力。
---

# 桌面能力交付

将“后端”解释为 Electron 主进程与 `packages/agent` 能力边界。先确认契约，再实现主进程服务、Provider、IPC 和渲染调用方；保持预加载最小暴露、文件路径白名单、密钥运行时注入、取消/超时/错误/离线降级。涉及 FFmpeg 或 Agent 时运行对应 smoke，并记录实际结果。
