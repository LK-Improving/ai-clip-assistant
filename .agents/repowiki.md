# KK剪映架构 Wiki

## 1. 项目定位与运行时

KK剪映是本地优先的 AI 视频智能剪辑桌面应用。用户输入自然语言需求并选择素材目录，Agent 生成创意简报、分镜、素材匹配、视频补帧、旁白和时间线，最终由编辑器调整并通过 FFmpeg 导出 MP4。运行时是 Electron 三层进程：主进程承载文件、FFmpeg、Provider 和工程落盘；预加载暴露受限 IPC；渲染进程运行 React UI。无独立后端和数据库，工程与素材索引使用本地 JSON。

## 2. 源码分层

```text
apps/desktop/src/renderer.tsx / App.tsx
  └─ pages、components、hooks、lib
      └─ window.electronAPI（预加载最小桥）
          └─ apps/desktop/src/main/ipc.ts
              ├─ services/project-store.ts / library.ts
              ├─ services/agent.ts → packages/agent
              ├─ services/render/* → FFmpeg
              ├─ services/tts/*、llm/*、video-gen/* → 外部/离线 Provider
              └─ protocol.ts → miaoma:// 本地媒体 Range 预览

packages/core (video-project DSL, Zod, migrate)
  ↑ packages/agent (节点流水线、Provider、checkpoint)
  ↑ apps/desktop
```

依赖方向自下而上：`core` 不依赖桌面；`agent` 依赖 `core`；桌面端负责系统能力和 UI 编排。

## 3. 模块、页面与路由

| 模块或路径 | 文件/目录 | 职责 |
| --- | --- | --- |
| 桌面入口 | `apps/desktop/src/main.ts`, `preload.ts`, `renderer.tsx` | 进程启动、桥接和渲染入口 |
| 页面 | `apps/desktop/src/pages/` | 启动、项目、素材库、AI 工作流、分镜、编辑器、导出、设置 |
| 编辑器 | `apps/desktop/src/components/editor/` | 预览、素材面板、属性面板、时间线 |
| 工程 DSL | `packages/core/src/` | Asset/Clip/Track、迁移、Zod 校验和工程读写模型 |
| Agent | `packages/agent/src/` | LangGraph.js StateGraph 10 节点流水线、Provider、原生 interrupt 人机中断、JSON Checkpoint、素材语义特征（semantic.ts：embedding/余弦匹配与检索） |
| 媒体能力 | `apps/desktop/src/main/services/render/`, `probe.ts`, `thumbnail.ts` | ffprobe、缩略图、filter_complex、导出 |
| 外部能力 | `apps/desktop/src/main/services/llm/`, `tts/`, `video-gen/` | 供应商适配、离线降级与配置 |

## 4. 数据、接口与鉴权

工程 JSON、素材索引（含 P2 语义描述与 96 维特征向量，`library-cache.json`）和 Agent checkpoint 落在本地用户数据目录；`loadProject()` 先按 `schemaVersion` 迁移，再执行 Zod 校验。IPC 通过 `invoke/handle` 和 `send/on` 传递命令与进度；Agent 事件使用 `agent:event`（带 seq）；素材语义检索用 `library:search`。`miaoma://` 只允许白名单路径并支持 Range。外部 Provider 的 API Key 只来自运行时配置，不进入治理文档。

## 5. 异步、流式与第三方边界

Agent 是基于 @langchain/langgraph 的可暂停/恢复异步图流水线（storyboard-review 节点原生 interrupt，恢复经 Command({ resume })，Checkpoint 由 JsonFileCheckpointSaver 落盘）；主进程把节点进度以带序号（seq）的事件广播到渲染进程，断档由 status 快照补偿。LLM 经 @langchain/core 模型抽象（离线确定性/火山方舟 ChatOpenAI/本地 ChatOllama，结构化输出走 invokeStructured：Function Calling + Zod + 自动重试）；火山 TTS 使用 WebSocket 流式合成，MiniMax H3 和本地 TTS 通过 Provider 适配器接入。无密钥或不可达时使用离线 Provider/静音占位，相关状态必须可观察。

## 6. 开发约定与风险

- 页面不直接访问 Node 或文件系统；所有系统能力走预加载 API。
- 改动工程 DSL、IPC 名称、事件 payload、Provider 配置或 FFmpeg 参数时，必须同步接口契约和调用方。
- 最小验证：`pnpm typecheck`；Agent 用 `pnpm smoke:agent`；桌面全链路用 `pnpm smoke`。
- 待确认：当前工作区没有 Git 元数据，不能自动建立基于提交的变更基线。
