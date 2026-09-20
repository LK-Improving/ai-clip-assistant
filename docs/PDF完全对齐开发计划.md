# KK剪映 · PDF 完全对齐开发计划（M1–M6）

> 前置：P0–P3 已消除 PDF 与代码的全部硬差异（LangGraph.js 10 节点、Function Calling+重试、事件防丢、断点重试、转场消费、语义检索、三平台打包配置）。
> 本计划处理剩余差异（编号对应《残余差异清单》A/B/C/D 分类），目标是 **PDF 每一项声称能力真实落地、量化数据全部实测**。
> 原则：改代码就 PDF；仅两处「反向」例外见 §0。

## 0. 明确不照 PDF 改的三项（决策点，如推翻需单独评审）

| 项 | PDF 口径 | 维持现状的理由 |
|---|---|---|
| DSL 命名 | `kind` 判别字段、`VoiceClip/SubtitleClip/MusicClip` | 改名将破坏已验证的 Zod schema、全部冒烟与已落盘工程；属 PDF 陈旧而非能力缺失 |
| 本地 TTS 权重 | "内置 Index-TTS 2" | 权重数百 MB，与安装包体积冲突；保持"自托管服务 + zero-shot 协议适配"（M3 落地后能力即达成） |
| 官方火山 SDK | "字节火山引擎 SDK" | PDF P9 自述火山"兼容 OpenAI 接口协议"，经 `@langchain/openai` 接入即符合；LLM 侧不换 SDK，TTS 已按官方 WebSocket 协议实现 |

同理判定「已符合、无需动工」：fluent-ffmpeg（PDF 2.1 明示"或 child_process"）、Electron 版本（取更新 44）、"Node.js FFmpeg 封装"（spawn 即封装层）。

## M1 快速收尾（1–2 天）—— ✅ 已完成（2026-09-19）
| # | 任务 | 涉及文件 | 验收 | 状态 |
|---|---|---|---|---|
| 1.1 | 设置中心补 **Ollama** 选项（providerId/baseUrl/model，旧配置自动补齐） | `llm/config.ts`、`services/agent.ts resolveLlm`、`pages/settings.tsx` | 冒烟：选 ollama→providerId='ollama'；旧配置缺字段补默认 | ✅ 桌面冒烟 30/30 含新断言 |
| 1.2 | `git init` + **Husky + Commitlint**（pre-commit 跑 typecheck，commit-msg 走 conventional） | 根 package.json、`.husky/`、`commitlint.config.cjs` | 非法 message 被拒（实测 found 2 problems）；typecheck 钩子实测触发 | ✅（首次 commit 由用户自行执行） |
| 1.3 | 安装包体积基线 `pnpm bench:dist`；启动耗时由主进程 `[bench]` 日志 | `scripts/bench/startup.mjs`、`main.ts` | 实测：便携包 477.7MB（含 ffmpeg 98.1MB，@langchain 引入后 +7.3MB）；启动 ms 数待下次 `pnpm start` 读取 `[bench]` 日志补录 | ✅（启动数留待 GUI 实跑） |

## M2 SSE 真流式（2 天，A-5）—— ✅ 已完成（2026-09-19）
PDF P4/P12："流式即时响应、打字机效果"。
- 2.1 `invokeStructured` 增加 `onToken` 通道：Ark/Ollama 用 `model.stream()`；离线模型按 8–16 字符分块模拟（无密钥可演示）
- 2.2 `agent:event` 新增 `type:'token'`（node + delta + seq），渲染层日志区打字机
- 2.3 中断/取消语义：token 流期间 cancel 立即停流（AbortSignal 传递）
- 验收：冒烟断言离线 token 分块序列拼接 == 完整输出、seq 单调；对外口径恢复"流式响应"（仍非 HTTP SSE，桌面端无 HTTP 服务，IPC 等效表述保留）—— ✅ 实测：agent 冒烟⑥环拼接==节点产物、分块≤16ch、预 abort 即时阻断；agent-run 6 环 + smoke 31 环全绿

## M3 声音克隆 + 自定义音色库（4–5 天，A-1）—— ✅ 已完成（2026-09-19）
PDF P5/P6/P13/P18："零样本音色克隆、参考音频导入/预览/删除全链路安全管控、在线/本地自动路由"。
- 3.1 音色索引 `userData/voices.json`：**原子写**（tmp+rename，PDF P6"原子化音色索引存储"），字段 id/名称/样本路径/createdAt/校验结果
- 3.2 零样本协议：`local.ts` 扩展 `synthesizeWithReference()` → `POST {baseUrl}/tts/zero-shot`（Index-TTS 2 自托管服务约定：text+referenceAudioBase64+voicePrompt）
- 3.3 双路由降级链：voiceId 指定 → 本地零样本 → 失败回退火山在线 → 再退离线静音；`tts/index.ts` 路由表 + 决策日志
- 3.4 管控：导入 ffprobe 校验（时长 3–20s、采样率≥16k、非静音占比）、试听走 `miaoma://` 白名单、删除连带样本清理
- 3.5 流水线打通：`StoryboardScene.voiceId?`（Zod optional，不 bump schemaVersion）→ speech-synthesis 注入
- 验收：新冒烟环——音色 CRUD、非法参考音频拒绝、零样本失败自动回退在线链路的降级断言；简历口径恢复"声音克隆" —— ✅ 实测：桌面冒烟 31/31（M3 环含拒绝静音/短样本、零样本命中+缓存二命中、宕机降级可观察、删除连带清理）

## M4 多模态素材解析 + AI 智能转场（5–6 天，A-2/A-3）—— ✅ 已完成（2026-09-19）
- 4.1 **视觉 embedding**：`transformers.js` + 小体积 CLIP（ONNX 30–60MB，首次启动下载到 `userData/models/`，此后纯离线）；帧源复用 thumbnail 关键帧
- 4.2 `semantic.ts embedAsset` 升级：模型向量优先、词法向量兜底——`Asset.embedding` 协议不变，检索与 match-assets **零改动自动增强**（"按画面内容搜素材"成立）
- 4.3 **视觉描述**（条件路径）：配置方舟视觉模型时 scan-assets 生成真实画面 caption 写 `description`；未配置维持启发式描述
- 4.4 **AI 智能转场**：assemble-timeline 按节奏自动注入 effects——首段 fade-in、末段 fade-out、场景切换处成对 fade（时长由相邻 scene.durationMs 推导）；渲染链 P1 已就绪
- 验收：mock CLIP 输出确定性断言"海滩照片命中查询 sea sunset"；自动转场工程 filter_complex 含 fade；体积基线：模型文件不进安装包 —— ✅ 实测：引擎冒烟⑦环（转场分布）+ 桌面 M4 环（维度保护/未就绪静降级/规则幂等不覆盖/filter_complex 消纳/异步检索不变），agent 7 环 + smoke 32 环全绿；模型文件仅存 userData/.models 不进安装包
- 风险：transformers.js 在 Electron 主进程的 wasm/node 兼容需预研半天（失败备选：ONNX Runtime Node binding）—— 实测结论：v4.3 依赖 `import ... with` 语法，需 **Node ≥20.19**（项目 engines 本就要求；本机 20.0 无法跑真模型，降级链已验证）；动态 require 方案避免了对主进程构建/老 Node 用户的任何影响

## M5 云端协同版本管理（3–4 天，A-4）—— ✅ 已完成（2026-09-19）
PDF P19："云端协同版本管理"——用 git 引擎同时满足"版本管理+协同"，不建后端：
- 5.1 工程每次 save 自动快照提交到 `userData/project-repo`（isomorphic-git）
- 5.2 版本面板 UI：历史列表 / 字段级 diff（轨道·片段增删统计）/ 一键回滚
- 5.3 协同：设置远端（GitHub/Gitee https+token）push/pull 手动触发；离线本地历史完整可用（隐私定位不破坏）
- 验收：连续修改 3 次→3 版本→回滚第 1 版内容一致；坏仓库自愈（重建） —— ✅ 实测：M5 冒烟环（快照→历史≥4、字段级 diff、回滚作为新版本线性落盘、垃圾 .git/HEAD 自愈后快照可恢复、未配远端 push 中文错误），smoke 33 环全绿

## M6 量化实测基线（1–2 天，可穿插，D 类）—— ✅ 已完成（2026-09-20）
`scripts/bench/` 产出可复跑真数据，替换 PDF 虚构数字（5倍/90%/10倍）：
- TTS 缓存命中 vs 未命中耗时；增量扫描 vs 全量扫描；Zod+重试+降级 vs 裸 JSON.parse 坏输出拦截率；checkpoint 恢复耗时；大工程保存读取（复用性能基线环）
- 产出写入 `docs/性能与效果实测.md` + 简历安全表述节 —— ✅ 实测（首次采集）：增量扫描 20ms vs 全量 21.4s（≈1068x）；TTS 命中 1ms vs 未命中 1494ms；结构化防线 200/200 合法产出 0 崩溃（对照裸 parse 崩 80/200）；checkpoint 恢复 275ms；大工程存 21ms/读 40ms；报告已自动落盘

## C 类：真实联调（不设排期，设触发条件）
Ark Function Calling、火山 TTS 实链路、MiniMax H3、macOS 公证、Linux deb/rpm——代码与降级路径全部就绪；拿到 key/证书/Linux 环境后各半天验证。M5 的 git 远端可顺带承载 GitHub Actions ubuntu 打包验证 deb/rpm。

## 里程碑顺序与总量
```
M1(1-2d)✅ → M3(4-5d)✅ → M2(2d)✅ → M4(5-6d)✅ → M5(3-4d)✅ → M6✅
```
合计约 **3–4 周**单人量。每个里程碑完成即：typecheck + `pnpm smoke`/`smoke:agent` 全绿 + 文档叙事（README/对齐版/本计划状态列）同步，不允许声称未验证的"通过"。

## 对外口径的阶段性变化
| 完成点 | 新增可写 |
|---|---|
| M1 | "Conventional Commits + hooks 工程化"、"三引擎 LLM（方舟/Ollama/离线）" |
| M2 | "LLM token 级流式打字机（IPC 事件，带序号防丢）" |
| M3 | "零样本声音克隆 + 音色导入/预览/删除全链路管控"（PDF 最强卖点回归） |
| M4 | "CLIP 多模态素材理解、AI 自动转场" |
| M5 | "工程版本管理 + git 云端协同" |
| M6 | 全部量化指标换成实测数据 |
