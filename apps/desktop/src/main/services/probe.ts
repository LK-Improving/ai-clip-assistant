import { runFfmpeg } from '../ffmpeg';

export interface ProbeResult {
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** kbps */
  bitrate: number | null;
  hasAudio: boolean;
}

/**
 * 解析 `ffmpeg -i` 的 stderr（本机无 ffprobe，剪映内置版本亦未编译 ffprobe）。
 * 后续若引入 ffprobe，可改为 `-print_format json` 解析，保持 ProbeResult 结构不变即可。
 */
function parseFfmpegOutput(stderr: string): ProbeResult {
  const result: ProbeResult = {
    durationMs: 0,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    sampleRate: null,
    channels: null,
    bitrate: null,
    hasAudio: false,
  };

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durationMatch) {
    const [, h, m, s] = durationMatch;
    result.durationMs = Math.round(
      Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000,
    );
  }

  const videoMatch = stderr.match(/Stream #\d+:\d+.*?:\s*Video:\s*([^,\n]+)/);
  if (videoMatch) {
    result.videoCodec = videoMatch[1]!.trim().split(' ')[0] ?? null;
    const line = stderr.slice(stderr.indexOf(videoMatch[0]));
    const resolution = line.slice(0, 260).match(/(\d{2,5})\s*x\s*(\d{2,5})/);
    if (resolution) {
      result.width = Number(resolution[1]);
      result.height = Number(resolution[2]);
    }
    const fps = line.slice(0, 260).match(/([\d.]+)\s*(?:fps|tbr)/);
    if (fps) result.fps = Number(fps[1]);
  }

  const audioMatch = stderr.match(/Stream #\d+:\d+.*?:\s*Audio:\s*([^,\n]+)/);
  if (audioMatch) {
    result.hasAudio = true;
    result.audioCodec = audioMatch[1]!.trim().split(' ')[0] ?? null;
    const line = stderr.slice(stderr.indexOf(audioMatch[0]), stderr.indexOf(audioMatch[0]) + 200);
    const sampleRate = line.match(/(\d{3,6})\s*Hz/);
    if (sampleRate) result.sampleRate = Number(sampleRate[1]);
    if (/mono|1\.0/.test(line)) result.channels = 1;
    else if (/stereo|2\.0/.test(line)) result.channels = 2;
    else if (/5\.1/.test(line)) result.channels = 6;
  }

  const bitrateMatch = stderr.match(/bitrate:\s*(\d+)\s*kb/);
  if (bitrateMatch) result.bitrate = Number(bitrateMatch[1]);

  return result;
}

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', filePath]);
  if (/Invalid data|No such file|Error opening input/.test(stderr)) {
    throw new Error(`无法解析媒体文件：${filePath}`);
  }
  return parseFfmpegOutput(stderr);
}
