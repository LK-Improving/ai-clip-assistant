---
name: react-page-implementation
description: 依据KK剪映需求、UI规格和IPC契约实现React渲染进程页面与组件。
---

# React 页面实现

先读取对应需求、UI规格、接口契约、`.agents/repowiki.md` 和 React/Electron 规则。沿用 React 19、TailwindCSS 4、现有组件和 `window.electronAPI`，不让渲染进程直接访问 Node。实现后检查加载、空态、错误、取消、离线降级和成功路径，并运行 `pnpm typecheck`。
