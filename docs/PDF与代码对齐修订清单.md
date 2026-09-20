# PDF 与当前代码对齐修订清单

> ⚠️ **状态更新（2026-09-18）**：本清单第一、三、六节（LangGraph/LangChain、节点数、Function Calling）的修订建议已被后续工程升级推翻——引擎已真实迁移到 **@langchain/langgraph + @langchain/core**，流水线为 **10 节点**，结构化输出为 **Function Calling + Zod + 自动重试**，与 PDF 口径一致。以 `docs/项目介绍（对齐版）.md` 与根 `README.md` 为准。本清单仍有效的部分：声音克隆未实现、素材索引为 JSON 非 SQLite、SSE 实为 IPC 事件广播、判别字段 type、Electron 44。
>
> 背景（历史）：项目代码曾全部跑通、冒烟全绿，但与《企业级类剪映视频智能剪辑工具架构设计与实践项目介绍》这份对外介绍 PDF 存在多处"文档把计划/理想架构写成已实现"的差异。
> 经代码核实，**三处差异代码侧均已正确，纯属文档没跟上**，无需改代码，只改文档。
> 本清单给出 PDF 中每一处需改的位置、原文与修订建议。README.md 已同步修正。

---

## 一、LangGraph / LangChain（重大：PDF 称"基于 LangGraph.js"，代码实际是自研编排）

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P3 学习成果 | "熟练掌握 **LangGraph.js** 图状态机核心思想" | "掌握自研 **LangGraph 式编排引擎**的状态机思想（手写 execute 循环 + checkpoint，未依赖 @langchain/langgraph 库）" |
| P5 学习产物 | "基于 **LangGraph.js** 的完整智能体编排系统，包含 **10 节点**工作流流水线：扫描素材、分析素材、生成创意简报、规划分镜、分镜审批中断、匹配素材、合成语音、组装时间线、验证项目、保存项目" | 见第三节「节点数」 |
| P7 技术选型·智能体层 | "智能体编排: **LangGraph.js**" | "智能体编排: **自研 LangGraph 式编排引擎（非 @langchain/langgraph 库）**" |
| P7 技术选型·AI 基础层 | "**LangChain.js**" | "LLM/TTS 经**自研 DI Provider 适配器**接入（火山方舟 / 离线兜底），未依赖 @langchain/core、@langchain/ollama" |
| P10 @miaoma/video-agent | "**LangGraph.js**：图状态机框架，提供 State、Node、Edge 核心抽象，内置 Checkpoint 持久化、中断恢复、人机交互能力" | "**自研状态机**：手写 execute 循环 + checkpoint JSON 持久化，支持中断恢复与人机交互（非 @langchain/langgraph 库）" |
| P10 @miaoma/video-agent | "**LangChain.js（@langchain/core、@langchain/ollama）**：提供模型抽象、Prompt 模板、工具调用基础能力" | 删除此条，或改为 "LLM 经 DI Provider 注入（火山方舟 / 离线兜底），未依赖 LangChain.js" |
| P10 包名 | "**@miaoma/video-agent**（智能体核心引擎）" | "**@miaoma/agent**（智能体核心引擎）" |
| P14 简历·中级/高级 | "基于 **LangGraph.js** 设计实现了完整的剪辑智能体工作流" | "基于**自研 LangGraph 式编排引擎**实现完整剪辑智能体工作流" |

> 说明：`packages/agent` 仅依赖 `@miaoma/video-project`，流水线为 `pipeline.ts` 中手写 `execute()` 循环 + 手动 checkpoint JSON，README 已自述为「LangGraph 式编排」。简历/介绍若写"基于 LangGraph.js"会被追问翻车。

---

## 二、本地 TTS / 声音克隆（功能缺口，按你的决定：删描述，不实现）

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P5 学习产物·TTS | "**自定义音色库功能，支持声音克隆**" | **删除**（代码中无 clone/克隆/音色库实现，grep 全仓零命中） |
| P6 TTS 系统 | "本地开源 TTS 模型预留扩展（**Index-TTS 2** 等）" | "本地 TTS Provider（**baseUrl 适配**，可接 Index-TTS 2 等本地服务；**未内置模型权重**）" |
| P6 TTS 系统 | "在线/本地 TTS 服务自动路由与故障降级" | 保留（已通过 Provider 适配器 + 离线静音兜底实现） |
| P7 技术选型·TTS 架构 | "本地 **TTS: Index-TTS 2**" | "本地 TTS: **baseUrl 适配的本地 Provider**（可接 Index-TTS 2，未内置权重）" |
| P13 简历·初级/中级 | "支持本地素材管理、**自定义音色克隆**、成品视频导出" | 删除"**自定义音色克隆**" |
| P14 简历·中级/高级 | "支持本地**零样本音色克隆**" | **删除** |

> 说明：`apps/desktop/src/main/services/tts/providers/local.ts` 只是 POST `{baseUrl}/tts` 的通用适配，需用户自备本地服务；当前本地隐私兜底靠"离线静音占位 + 火山 TTS"，已够用。

---

## 三、智能体节点数（PDF 写 10，代码实际 7；含你已确认的 MiniMax H3 视频生成节点）

PDF 的"10 节点"把**中断暂停点、内联校验、桌面端保存**都算成了节点。代码 `packages/agent/src/constants.ts` 的 `PIPELINE_NODES` 实际注册 **7** 个：

`scan-assets` → `creative-brief` → `storyboard` → `match-assets` → `generate-clips`(MiniMax H3 文生视频) → `speech-synthesis` → `assemble-timeline`

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P4 学习成果 | "智能体执行流程与 **10 节点**流水线" | "**7 节点**流水线" |
| P5 学习产物 | "**10 节点**工作流流水线：扫描素材、分析素材、生成创意简报、规划分镜、分镜审批中断、匹配素材、合成语音、组装时间线、验证项目、保存项目" | "**7 节点**流水线：扫描素材→创意简报→分镜规划→素材匹配→**AI视频生成(generate-clips，MiniMax H3，替代火山视频生成)**→语音合成→时间线组装；分镜审批为**中断暂停点**、验证为**内联 Zod 校验**、保存由**桌面端**负责；无独立「分析素材/语义预处理」节点" |
| P10 图 | 流程图节点含"素材分析节点""项目验证节点""项目保存节点"作为独立节点 | 改为：素材分析并入"扫描素材"探测；验证并入"组装时间线"的 `ProjectSchema.parse`；保存由桌面端 `project-store` 负责（非引擎节点） |

> 说明：
> - `generate-clips` 节点已用 **MiniMax H3（Hailuo 3.0）v2 API** 完整实现（建任务→轮询→下载），桌面端 `agent.ts:127 resolveVideoGen()` 在配置就绪时注入 `MiniMaxH3VideoProvider`，设置页可填 apiKey/baseUrl/model。**"minimax-h3 替换火山做视频生成"在代码里已真实生效**，无需再做模型替换。
> - 缺素材场景由该节点补帧，未匹配素材的场景退化为字幕/标题；单段失败只记日志跳过，不中断整条链路。

---

## 四、存储选型（PDF 写 SQLite，代码用 JSON）

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P9 存储 | "素材索引: **SQLite**（支持高效查询、增量更新、事务，单文件存储）" | "素材索引: **本地 JSON 缓存（library-cache.json）**，增量扫描对比 size/mtime；无 SQLite" |
| P13 基础设施 | "**lowdb**（可选）：轻量级 JSON 数据库，用于项目元数据存储" | 保留为可选说明即可（实际用 JSON 文件） |

---

## 五、数据模型 DSL 命名（PDF 与代码字段/类型名不一致）

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P6 数据模型 | "判别联合类型设计（**VideoClip、VoiceClip、SubtitleClip、MusicClip**）" | "判别联合类型（**VideoClip、ImageClip、AudioClip、TextClip**），判别字段为 **type**" |
| P12 数据模型 | "通过 **kind** 字段区分不同类型的 TimelineClip" | "通过 **type** 字段区分（Zod `z.discriminatedUnion('type', …)`）" |
| P6 数据模型 | "版本字段与向前兼容设计（**schemaVersion: '1.0.0'**）" | "版本字段 `schemaVersion`（**number** 类型，配合 migrate 迁移，非字符串 '1.0.0'）" |

---

## 六、版本与次要项

| PDF 位置 | 原文 | 修订建议 |
|---|---|---|
| P12 桌面端 | "**Electron 38**" | "**Electron 44**（当前版本，README 已写 44）" |
| P1 文件名 | "…**Vue3**）项目介绍" | 文件名误写 Vue3；正文一致为 React 19，**无需改内容**，仅提示命名陈旧 |
| P4/5 AI 引擎 | "**SSE**（Server-Sent Events）技术：实现 AI 生成内容的流式即时响应" | "等效实现：渲染进程经 **IPC 事件广播**（`agent:event`）实时推送节点进度与状态" |
| P7 技术选型 | "可视化编辑: …可集成 **XYFlow (React Flow)**" | 保留（标注"可选，当前未采用"） |
| P12 桌面端 | "**Zustand**（可选）：轻量级状态管理" | 保留（可选，当前用 React 状态/hooks） |
| P3/5 自动分镜 | "**Zod Schema + Function Calling** 的技术方案" | "**JSON 模式 + Zod 运行时校验**：`llm.chat(...,{json:true})` 后 `Schema.parse(JSON.parse(raw))`，失败回退默认/降级"（代码未用 Function Calling） |

---

## 七、建议处理方式

1. **对外文档（PDF/简历）**：按本清单逐项改。重点改 **一（LangGraph 措辞）**、**二（删声音克隆）**、**三（节点数 10→7 + MiniMax H3）**——这三处最容易被面试追问。
2. **若需重出 PDF**：本环境无法直接改写二进制 PDF（会丢失水印/版式）。可用本清单作为校对稿，在原始设计稿上改文字后重新导出；或我可基于本清单生成一份"对齐版" Markdown/新 PDF（不含原水印）。
3. **README.md**：已同步修正（标题、技术选型表、目录注释、阶段二节点数 6→7 并注明 MiniMax H3）。

> 结论：功能链路（导入→AI→剪辑→导出）已全跑通，与《项目任务拆分与实施计划.md》一致；与对外介绍 PDF 的差异全部为**文档措辞/计数**问题，无功能性代码缺口。
