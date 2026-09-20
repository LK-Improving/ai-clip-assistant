import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * JSON 文件 Checkpoint 持久化（模块 2.2「Checkpoint 断点续传」）。
 *
 * LangGraph 原生 MemorySaver 把序列化后的通道值（Uint8Array）保存在内存 Map 中；
 * 本实现继承 MemorySaver，在每次 put/putWrites 后把 storage/writes 落盘为
 * `langgraph-checkpoint.json`，进程重启后从同目录重建，实现崩溃恢复——
 * 恢复时以原生 LangGraph 语义续跑（含 pending interrupt），而非手写状态回放。
 */

const CKPT_FILE = 'langgraph-checkpoint.json';

function encodeNode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeNode);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeNode(v);
    return out;
  }
  return value;
}

function decodeNode(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.__b64 === 'string' && Object.keys(obj).length === 1) {
      return new Uint8Array(Buffer.from(obj.__b64, 'base64'));
    }
    if (Array.isArray(obj)) return obj.map(decodeNode);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeNode(v);
    return out;
  }
  return value;
}

export class JsonFileCheckpointSaver extends MemorySaver {
  private readonly file: string;

  constructor(dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, CKPT_FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        storage?: unknown;
        writes?: unknown;
      };
      if (raw.storage) this.storage = decodeNode(raw.storage) as typeof this.storage;
      if (raw.writes) this.writes = decodeNode(raw.writes) as typeof this.writes;
    } catch {
      //  checkpoint 文件损坏时按空库处理，让流水线可以重新起跑而不是带病恢复
      this.storage = Object.create(null);
      this.writes = Object.create(null);
    }
  }

  private flush(): void {
    const payload = JSON.stringify(
      encodeNode({ storage: this.storage, writes: this.writes }),
    );
    writeFileSync(this.file, payload, 'utf8');
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const saved = await super.put(config, checkpoint, metadata);
    this.flush();
    return saved;
  }

  override async putWrites(config: RunnableConfig, writes: never[], taskId: string): Promise<void> {
    await super.putWrites(config, writes, taskId);
    this.flush();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.flush();
  }
}
