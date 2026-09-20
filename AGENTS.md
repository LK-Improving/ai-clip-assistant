# KK剪映项目代理规则

## 项目事实

- 技术栈：pnpm Monorepo；Electron 44 + Electron Forge 7；React 19 + Vite 7 + TypeScript + TailwindCSS 4；LangGraph.js（@langchain/langgraph）+ LangChain.js（@langchain/core）Agent 编排（10 节点流水线）；Zod 4；FFmpeg/ffprobe；火山/本地(Ollama)/离线 LLM、TTS 与 MiniMax H3 Provider。
- 入口与主要目录：`apps/desktop/src/main.ts` 为 Electron 主进程入口，`apps/desktop/src/preload.ts` 为预加载桥，`apps/desktop/src/renderer.tsx`/`src/App.tsx` 为渲染入口；`packages/core` 是视频工程 DSL，`packages/agent` 是 Agent 引擎；页面在 `apps/desktop/src/pages/`，主进程服务在 `apps/desktop/src/main/services/`。
- API 与文档来源：无独立 HTTP 后端；跨进程契约以 `apps/desktop/src/main/ipc.ts`、`src/preload.ts`、`src/types/electron-api.d.ts` 为准；外部 Provider 和 TTS WebSocket 适配器位于 `apps/desktop/src/main/services/`；项目事实以根 `README.md` 与 `docs/项目介绍（对齐版）.md` 为准。

## 最小上下文

- 先读取目标文件、直接调用处、关联样式/测试与最近项目规则。
- 跨页面、Agent 节点、IPC、工程 DSL、渲染或 Provider 变更前读取 `.agents/repowiki.md`。
- 遵守三层隔离：渲染进程不直接访问 Node/文件系统，预加载只暴露最小 API，主进程承载系统能力；不要在初始化任务中修改运行时代码。
- 保留当前工作区已有改动和生成产物，只修改任务范围内文件；不要把密钥写入文档或规则。

## 规则与技能路由

- 修改 React/TSX 页面、组件、Hooks、客户端状态或样式：读取 `.agents/rules/react-frontend.mdc`。
- 修改 Electron 主进程、预加载、IPC、文件系统、FFmpeg、TTS/LLM/视频生成 Provider：读取 `.agents/rules/electron-desktop.mdc`。
- 修改 IPC、外部 Provider、TTS WebSocket、Agent 事件或工程 DSL 契约：读取 `.agents/rules/api-contract.mdc`。
- 涉及需求、接口、UI 与实现角色交接：读取 `.agents/rules/artifact-handoff.mdc`。
- PRD/需求触发条件：使用 `.agents/skills/prd-to-design/SKILL.md`。
- 接口、IPC 或 Provider 文档触发条件：使用 `.agents/skills/api-docs-to-contract/SKILL.md`。
- UI/原型触发条件：使用 `.agents/skills/prototype-to-ui/SKILL.md`。
- React 页面实现触发条件：使用 `.agents/skills/react-page-implementation/SKILL.md`。
- 主进程、Agent、IPC 或媒体能力交付触发条件：使用 `.agents/skills/api-backend-delivery/SKILL.md`。
- 跨层联调、冒烟和验收触发条件：使用 `.agents/skills/integration-acceptance/SKILL.md`。

## 交付与验证

- 页面/组件：至少运行 `pnpm typecheck`；涉及桌面行为时补充 `pnpm smoke` 或 `pnpm smoke:agent`。
- `packages/core`、`packages/agent`：运行对应包的 `typecheck` 或根 `pnpm typecheck`，并保持 JSON/Zod/Checkpoint 兼容。
- FFmpeg、IPC、Provider 或协议变更：覆盖成功、失败、取消、离线降级和断点恢复路径；不要声称未实际运行的构建或冒烟通过。
- 最终说明变更、实际验证、未验证风险以及是否影响跨进程/外部服务契约。
