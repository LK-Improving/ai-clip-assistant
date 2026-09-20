/**
 * M4 视觉模型预下载（pnpm vision:warmup）。
 *
 * 用 @huggingface/transformers 把 CLIP ViT-B/32（q8）下载到仓内 .models/clip 目录；
 * 运行期 vision.ts 的候选目录含 MIAOMA_MODELS_DIR / userData/models，首启不再需要联网。
 * transformers 未安装或网络不可用时给出明确指引，不崩脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_DIR = path.join(ROOT, '.models');
const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';

fs.mkdirSync(MODEL_DIR, { recursive: true });
process.env.MIAOMA_MODELS_DIR = MODEL_DIR;

let tfs;
try {
  tfs = await import('@huggingface/transformers');
} catch (e1) {
  try {
    tfs = await import(pathToFileURL(path.join(ROOT, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
  } catch (e2) {
    console.error('[vision:warmup] @huggingface/transformers 加载失败：');
    console.error('  bare import:', e1 && e1.message);
    console.error('  直连回退:', e2 && e2.message);
    process.exit(1);
  }
}

tfs.env.localModelPath = [MODEL_DIR];
tfs.env.allowRemoteModels = true;
tfs.env.allowLocalModels = true;

console.log(`[vision:warmup] 下载 ${CLIP_MODEL_ID}（q8）到 ${MODEL_DIR} …`);
try {
  const extractor = await tfs.pipeline('feature-extraction', CLIP_MODEL_ID, { dtype: 'q8' });
  // 用一段纯色文本触发一次完整加载，确认模型可用
  const out = await extractor('a sunset over the sea', { pooling: 'mean', normalize: true });
  console.log(`[vision:warmup] 完成：文本向量 ${out.data.length} 维；重跑 pnpm vision:warmup 可秒级验证本地命中。`);
} catch (e) {
  console.error('[vision:warmup] 下载/加载失败（检查网络或 HF 镜像 HF_ENDPOINT=https://hf-mirror.com）：', e && e.message);
  process.exit(1);
}
