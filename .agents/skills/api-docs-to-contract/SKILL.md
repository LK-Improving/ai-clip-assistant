---
name: api-docs-to-contract
description: 将KK剪映的IPC、Agent事件、工程DSL或Provider资料整理为可执行的规范化契约。
---

# 文档到契约

来源优先使用代码类型、IPC 注册、预加载声明、Provider 接口和已有设计文档。输出到 `.agents/Documents/接口设计/`，记录命令/事件、输入输出、错误、取消、重试、断连、降级、版本兼容和调用方；必须明确这是 IPC、WebSocket 还是 HTTP，不把 IPC 写成 SSE。
