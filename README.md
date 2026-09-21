# KK剪映（KK Jianying）

企业级类剪映视频智能剪辑工具 —— Electron + Vite + React 19 + LangGraph.js（@langchain/langgraph）+ FFmpeg。

## 技术选型

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 44 + Electron Forge 7 | 主进程 / 预加载 / 渲染进程三层隔离 |
| 前端 | React 19 + Vite 7 + TailwindCSS 4 + shadcn/ui | 经典五区剪辑布局；属性面板变换/音量/转场全量真实接线（bridge 回写工程→filter_complex 消费，往返不漂移） |
| 数据模型 | `@miaoma/video-project`（Zod 4） | 判别联合 + `schemaVersion` 迁移；Asset 含语义描述与 96 维特征向量（P2，optional 向后兼容） |
| 智能体 | `@miaoma/agent`（**LangGraph.js** `@langchain/langgraph` StateGraph 编排，LLM 经 **LangChain.js** `@langchain/core` 模型抽象，另接 `@langchain/openai` / `@langchain/ollama`） | 10 节点流水线 + 原生 interrupt 人机中断 + Checkpoint 断点续传；match-assets 语义贪心匹配；**多模型引擎（火山方舟 / 本地 Ollama / 离线 / 自定义 OpenAI 兼容如 DeepSeek，设置中心可切）**（Function Calling + Zod + 自动重试）+ 离线/火山/本地/自定义 TTS 四路由（未内置模型权重）；视频生成 Seedance/MiniMax/自定义任务协议可选 |
| 渲染 | FFmpeg（阶段四已完成 + P1 效果消费） | 时间线 JSON → `filter_complex` → MP4；消费片段 `effects`（fade-in/fade-out 转场、eq/blackwhite/blur 滤镜白名单，未知效果降级告警）；失败/取消自动回滚半成品产物 |

## 目录结构

```
apps/desktop          # Electron 桌面应用（@miaoma/desktop）
packages/core         # @miaoma/video-project 视频工程数据模型 DSL
packages/agent        # @miaoma/agent AI 智能体引擎（LangGraph.js StateGraph 10 节点流水线）
```

## 常用命令

```bash
pnpm install     # 安装全部依赖
pnpm dev         # 构建 core 后启动桌面端（Forge + Vite 热更新）
pnpm typecheck   # 全量类型检查
pnpm build       # 构建 core + 桌面端产物
pnpm make        # 打包安装包（模块 5.1 配置 maker 后可用）
pnpm smoke       # 阶段五 5.2 P0+P1 全链路冒烟测试（无需 GUI，Node 端跑真实主进程逻辑）
pnpm smoke:agent # 阶段二 AI 智能体引擎端到端冒烟测试（离线 Provider + 真实 ffmpeg 探测，验证流水线/中断 resume/checkpoint）
pnpm bench:dist  # 打包体积基线（实测：win32-x64 便携包 477.7MB，含完整版 ffmpeg 98.1MB）
pnpm vision:warmup # M4：预下载 CLIP 视觉模型到 .models/（需 Node ≥20.19；未下载时视觉检索自动降级词法向量，功能不损）
pnpm bench:metrics # M6：性能与效果实测基线（TTS 缓存/增量扫描/结构化防线/Checkpoint 恢复/大工程往返），-- --write 落盘 docs/性能与效果实测.md
```

提交规范（M1）：仓库已 `git init` 并接入 **Husky + Commitlint**——pre-commit 跑 `pnpm typecheck`，commit message 须符 conventional 规范（如 `feat(llm): 设置中心支持 Ollama 本地模型`）。

## 数据模型约定

- 时间单位统一为**毫秒整数**，渲染层再换算成秒交给 FFmpeg；
- `Asset`（磁盘素材）与 `Clip`（时间线上的一次摆放）分离，一个素材可被多个片段引用；
- `Asset` / `Clip` / `Track` 全部为**判别联合**，判别字段 `type`，便于 `switch` 收窄与 FFmpeg 构建；
- 工程读写统一走 `loadProject()`：先按 `schemaVersion` 迁移，再交给 Zod 校验。

## 实施进度

- [x] 阶段一 1.1 Monorepo 仓库初始化
- [x] 阶段一 1.2 数据模型 DSL
- [x] 阶段一 1.3 Electron 桌面端骨架
- [x] 阶段二 2.1 ~ 2.3 智能体引擎（`packages/agent` 已实现：**@langchain/langgraph StateGraph 编排的 10 节点流水线**（scan-assets / creative-brief / storyboard-plan / **storyboard-review（原生 interrupt 人机中断）** / match-assets / generate-clips(MiniMax H3 文生视频) / speech-synthesis / assemble-timeline / **validate（Zod 校验）** / **save-project（工程落盘）**）；LangGraph Checkpoint 经 `JsonFileCheckpointSaver` 落盘 JSON 支持崩溃后断点续跑；LLM 经 **@langchain/core 模型抽象**（离线确定性 / 火山方舟 ChatOpenAI 兼容 / 本地 ChatOllama），结构化输出统一走 **Function Calling + Zod 运行时校验 + 失败自动重试 + 降级兜底**（invokeStructured）；内置离线 Provider 让无密钥/无网络环境也能端到端跑通，真实实现经 env 或桌面端注入火山方舟 LLM / 火山·本地 TTS / desktop probeMedia。端到端冒烟测试 `apps/desktop/scripts/smoke/agent-run.mjs` 验证：①视频+图片+音频混合→四轨工程 ②人机中断(storyboard-review,interrupt)→resume(竖屏画布识别) ③空素材库离线兜底分镜+TTS 旁白 ④checkpoint 断点续传。`pnpm smoke:agent` 可复跑）。**桌面端已接入**：IPC 通道 `agent:start/resume/status/cancel` + `agent:event` 带序号（seq）事件广播（渲染进程断档自动用 status 快照补偿对齐）；`pages/ai-workflow`（需求输入+素材目录+真实节点进度）与 `pages/storyboard`（分镜可编辑 → 确认后经 `Command({ resume })` 回注续跑 → 落盘工程并跳编辑器）已由静态 mock 改为真实驱动；TTS 未配置或服务不可达时自动降级为静音占位，LLM 未配置时回退离线 Provider，保证无密钥也能跑通整条链路。设置中心「AI 设置」已实现真实配置（TTS provider/火山 appId·accessToken/本地 baseUrl/音色 + LLM provider/火山方舟 apiKey/model/接入点，落盘 `userData/{tts,llm}-config.json`）
- [x] 阶段三 3.1 ~ 3.3 素材管理 / 编辑器 UI / TTS
- [x] 阶段四 4.1 ~ 4.3 FFmpeg 渲染 / IPC / 本地协议（含 miaoma:// 路径白名单修复与预览失败诊断）
- [x] 阶段五 5.1 跨平台打包（`extraResources` 已含完整版 ffmpeg；P3 补齐 Linux 官方 maker-deb/maker-rpm 配置与 macOS 公证 `osxNotarize` 条件接线（APPLE_ID/APPLE_ID_PASSWORD/APPLE_TEAM_ID 齐备才启用，无证书不影响本地打包；Linux makers 需在对应平台 `make` 时生效，Windows 开发现场仅验证配置可加载与 package 流程）
- [x] 阶段五 5.2 全链路 P0+P1+更细异常+P1扩展冒烟测试（端到端脚本 `apps/desktop/scripts/smoke/`，含 P1/P2 新环共 **29 环全绿**：8 核心 + 3 异常兜底 + 6 P1 更深场景 + 2 更细异常 + 6 P1 深度扩展。P1 覆盖：①多素材类型组合（视频+图片+音频+字幕混合渲染）②缩略图生成+缓存命中 ③工程迁移+Zod 默认值补齐（老工程缺省字段补默认、非法 id 被拒）④大工程往返（~110 片段保存→读取一致、时长无漂移）⑤性能基线（20 片段保存/读取耗时阈值）⑥素材库扫描目录 vs 手动导入（imported 标记、重扫保留导入素材）。更细异常：⑦**导出目标不可写**（file-as-dir 触发 ffmpeg 写盘失败 → renderProject 优雅抛错）⑧**火山引擎鉴权 code 分支**（未配置/返回错误码4001/连接失败 三分支均优雅报错，伪造 WebSocket 确定性触发）。P1 深度扩展：⑨空工程渲染兜底（无轨道→合法空画布视频）⑩竖屏/1080x1920 非 16:9 画布渲染（输出尺寸校验）⑪纯音频工程渲染（无视频轨→纯色底+音轨）⑫素材库批量扫描（20 文件数量正确+性能基线）⑬工程列表容错（坏文件跳过、有效工程保留）⑭TTS 空文本边界（空/空白文本被拒并给提示）。`pnpm smoke` 可复跑）

- [x] 阶段二续 P1：结构化输出自动重试（invokeStructured：Function Calling + Zod + 错误回灌重试 + 降级兜底）、`agent:event` 带序号防丢与断档快照补偿、失败回滚与断点重试（`agent:retry` 从磁盘 LangGraph Checkpoint 恢复，AI 工作台/分镜页提供「断点重试」入口）、渲染转场/滤镜效果消费（filter-builder 消费 `effects`，编辑器属性面板支持片段淡入/淡出）、项目管理页搜索/排序/批量删除（新冒烟环：effects→filter_complex + 转场导出 + 失败产物回滚 + 断点重试，`pnpm smoke` 共 28 环）

- [x] 阶段二续 P2：素材语义预处理与检索——扫描/生成即产出启发式描述 + 96 维本地确定性特征向量（中文 bigram + 哈希词袋 + L2 归一化，`@miaoma/agent` semantic.ts，离线可跑）；`library:search` IPC 语义检索 + 素材库页「语义搜索」开关（防抖、断档回退关键词匹配）；Agent match-assets 升级为余弦得分全局贪心匹配（无信号时等价于原轮转，确定性不变）；`pnpm smoke:agent` 共 5 环、`pnpm smoke` 共 29 环全绿

- [x] 阶段二续 P3：导出异常体验——渲染前 `fs.statfs` 磁盘空间预检（按码率×时长估算，不足则在启动 ffmpeg 前拒绝；statfs 不可用时静默跳过绝不阻断导出）+ `classifyFfmpegFailure` 把英文 stderr 归一为五类中文可行动错误（磁盘不足/导出不可写/素材缺失/编码器/未知，仅编码器类触发 mpeg4 回退）+ 失败产物回滚兼容；新冒烟环 `pnpm smoke` 共 30 环。工程已 `git init` 并接入 Husky + Commitlint（见上“提交规范”节）

- [x] 阶段二续 M3：零样本声音克隆 + 自定义音色库——参考音频导入校验（ffprobe 时长 3–20s + volumedetect 非静音）、`voices.json` 原子写、`POST {baseUrl}/tts/zero-shot` 克隆协议（对接自托管 Index-TTS 2，未内置权重）、零样本→火山→离线静音双路由降级（原因可观察）、试听走 miaoma:// 白名单、删除连带样本清理、分镜页逐场选音色经流水线透传；IPC `voice:list/add/remove`；新冒烟环共 **31 环全绿**

- [x] 阶段二续 M2：LLM token 级流式——`invokeStructured` 增 onToken 通道（真实模型 `model.stream()` + `AIMessageChunk.concat` 聚合，含流式 tool_call 合并解析；离线模型 12 字符分块同构模拟）；`agent:event` 新增 `type:'token'`（带 seq）；AI 工作台打字机区（streamText 节点切换重置、限长尾部）；`AgentDeps.signal` 由 runPipeline 注入，stream 迭代中 abort 即时停流；`pnpm smoke:agent` 共 **6 环全绿**

- [x] 阶段二续 M4：多模态素材解析 + AI 智能转场——[vision.ts](apps/desktop/src/main/services/vision.ts) CLIP 视觉向量（transformers.js q8，**运行期动态 require 加载**：未装依赖/未下模型/推理失败全链路静降级回词法向量，扫描与检索绝不触发意外下载；`pnpm vision:warmup` 显式预下载，需 Node ≥20.19）；`library:search` 双空间 max 融合；可选方舟 `visionModel` 生成真实画面描述；agent `embedAsset` 向量空间维度保护（512 维视觉向量不回工程、match 不会截断比较）；assemble-timeline 确定性节奏自动转场（首段淡入/末段淡出/快切换场成对，幂等不覆盖用户配置）；`pnpm smoke:agent` 共 **7 环**、`pnpm smoke` 共 **32 环全绿**

- [x] 阶段二续 M5：工程版本管理 + 云端协同——isomorphic-git 实现：`project-store.save` 挂 fire-and-forget 快照钩子（内部全捕获，绝不阻断保存）；`userData/project-repo` 本地 git 仓，一工程一文件天然可 diff；`project:history/read-version/diff-versions/restore-version` + `version:remote-*/push/pull` IPC 链路；回滚作为新版本线性落盘（历史不重写）；仓库损坏（垃圾 .git）自愈重建；可选 GitHub/Gitee 远端 https+token 手动 push/pull（token 仅存本机，离线历史完整）；项目页版本面板（列表/双版对比/回滚/远端配置）；`pnpm smoke` 共 **33 环全绿**（真实 push/pull 待远端凭证，属 C 类联调）

- [x] 阶段二续 M6：量化实测基线——`scripts/bench/metrics.*`（esbuild 打包真实主进程服务，Node 端可复跑）五组指标实测：增量重扫 20 文件 20ms vs 全量 21.4s（≈1068x）、TTS 命中 1ms vs 未命中 1.5s、200 坏样本经 Zod+重试+兜底后崩溃 0（对照裸 parse 崩 80/200）、checkpoint 崩溃恢复 275ms、110 片段工程存 21ms/读 40ms；报告 `docs/性能与效果实测.md`

- [x] 自定义模型提供者（P-自定义）：三类模型均可接任意 OpenAI 兼容端点——LLM 加 `custom`（DeepSeek 等，ChatOpenAI 兼容 baseURL，支持 bindTools）；TTS 加 `custom`（POST {base}/audio/speech）；视频生成加 `seedance`（方舟任务协议）与 `custom`（OpenAI /videos 任务协议），统一 `HttpTaskVideoProvider` 建任→轮询→下载，未填模型 id 不猜测默认值；设置中心三区块均新增选项与字段；新冒烟环 mock 验证全链路，`pnpm smoke` 共 **35 环全绿**

MVP 顺序：1.1 → 1.2 → 1.3 → 2.1/2.2（控制台跑通 AI）→ 3.1/4.1（FFmpeg 渲染验证）→ 3.2/4.2（界面串联）→ TTS 与细节优化。
