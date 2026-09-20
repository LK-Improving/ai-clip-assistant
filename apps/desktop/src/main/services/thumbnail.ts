import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { runFfmpeg } from '../ffmpeg';

function thumbDir() {
  const dir = path.join(app.getPath('userData'), 'thumbs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 生成视频关键帧缩略图（模块 3.1）。
 * 同一素材 + 同一时间点会复用已生成的图片，避免重复解码。
 */
export async function generateThumbnail(
  filePath: string,
  options: { atMs?: number; width?: number } = {},
): Promise<string> {
  const atMs = options.atMs ?? 1000;
  const width = options.width ?? 320;
  const key = createHash('md5').update(`${filePath}|${atMs}|${width}`).digest('hex');
  const outPath = path.join(thumbDir(), `${key}.jpg`);

  if (existsSync(outPath)) return outPath;

  await runFfmpeg(
    [
      '-hide_banner',
      '-ss',
      (atMs / 1000).toFixed(3),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-y',
      outPath,
    ],
    20_000,
  );

  return outPath;
}
