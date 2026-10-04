import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CircleAlert,
  Cpu,
  Folder,
  Gauge,
  Keyboard,
  Mic,
  Monitor,
  Moon,
  Play,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import type { ImageGenConfig, LlmConfig, TtsConfig, TtsProbeReport, VideoGenConfig, VoiceProfile } from '@/preload';
import { cn } from '@/lib/utils';

/** 10 设置中心（AI 设置为真实配置，其余沿用原有展示） */
const tabs = [
  { label: '播放设置', icon: Play },
  { label: '通用设置', icon: Gauge },
  { label: 'AI 设置', icon: Sparkles },
  { label: '快捷键', icon: Keyboard },
  { label: '关于', icon: Cpu },
] as const;

const themes = [
  { label: '深色', icon: Moon, active: true },
  { label: '浅色', icon: Sun, active: false },
  { label: '跟随系统', icon: Monitor, active: false },
];

const toggles = [
  { label: '自动保存', desc: '每 5 分钟自动保存工程进度', checked: true },
  { label: '硬件加速', desc: '优先使用 GPU 编解码，导出更快', checked: true },
  { label: '联网素材推荐', desc: '允许联网获取推荐素材与模板', checked: false },
];

function ConfiguredHint({ ok: ready, text }: { ok: boolean; text: string }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-xs', ready ? 'text-emerald-400' : 'text-muted-foreground')}>
      {ready ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      {text}
    </div>
  );
}

/** 连通性检测单行结论：不可用时把 hint 当成「下一步做什么」直接给出，不丢给用户一个错误码 */
function ProbeRow({ label, ok, configured, message, hints = [], extra }: {
  label: string;
  ok: boolean;
  configured: boolean;
  message: string;
  hints?: string[];
  extra?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        {ok ? <Check className="size-3 shrink-0 text-emerald-400" /> : <CircleAlert className="size-3 shrink-0 text-muted-foreground" />}
        <span className="font-medium">{label}</span>
        <span className={cn('rounded px-1.5 text-[10px]', ok ? 'bg-emerald-500/15 text-emerald-400' : configured ? 'bg-amber-500/15 text-amber-400' : 'bg-secondary text-muted-foreground')}>
          {ok ? '可用' : configured ? '不可用' : '未配置'}
        </span>
        {extra ? <span className="font-mono text-[10px] text-muted-foreground">{extra}</span> : null}
      </div>
      <p className="pl-4.5 text-[10px] leading-relaxed text-muted-foreground">{message}</p>
      {hints.map((hint) => (
        <p key={hint} className="pl-4.5 text-[10px] leading-relaxed text-muted-foreground">· {hint}</p>
      ))}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * 视频模型 id 输入 + 一键拉取可用模型。
 *
 * 方舟视频模型 id 是小写带日期版本（如 doubao-seedance-2-5-260628），手填极易写错，
 * 错一个字符就是 404，而生成失败在流水线里只体现为“没视频”，所以这里直接把可选列表拉回来选。
 * 不用 Field包裹：内部有按钮与下拉，放在 label 里会误触发输入框焦点。
 */
function VideoModelPicker({
  label,
  value,
  apiKey,
  baseUrl,
  onPick,
}: {
  label: string;
  value: string;
  apiKey: string;
  baseUrl: string;
  onPick: (model: string) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 当前填写的 id 不在拉回来的列表里（方舟常见：写了大写/缺日期后缀） */
  const notInList = Boolean(models && models.length > 0 && value && !models.includes(value));

  async function fetchModels() {
    const api = window.electronAPI;
    if (!api?.videoGen?.listModels) {
      setError('需在桌面端使用（浏览器预览模式无法拉取）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.videoGen.listModels({ apiKey, baseUrl });
      if (res.ok) {
        // 不自动改写用户已填的 id，只标记“不在列表里”，避免静默换模型
        setModels(res.models);
      } else {
        setModels(null);
        setError(res.error ?? '拉取失败');
      }
    } catch (e) {
      setModels(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          value={value}
          placeholder="如 doubao-seedance-2-5-260628"
          onChange={(e) => onPick(e.target.value)}
        />
        <Button size="sm" variant="outline" className="shrink-0 rounded-full px-3" onClick={() => void fetchModels()} disabled={busy}>
          {busy ? '拉取中…' : '拉取可用模型'}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {models && models.length > 0 ? (
        <>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            value={value}
            onChange={(e) => onPick(e.target.value)}
          >
            {models.includes(value) ? null : <option value={value}>{value || '（选择模型）'}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            共 {models.length} 个视频模型 id；能选到不代表已开通，未开通时生成会直接报错并给出提示。
          </p>
          {notInList ? (
            <p className="text-xs text-destructive">当前填写的 id 不在可用列表里（方舟为小写带日期版本），请从下拉重选</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * M3 自定义音色库（零样本克隆）：参考音频导入（带校验）/试听/删除/绑定云端复刻音色。
 * 分镜页每场可选音色；本地 Index-TTS 2 不可用（无 GPU / 服务未起）时自动降级云端复刻→在线→静音。
 */
function VoiceLibrarySection() {
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.voice) return;
    try {
      setVoices(await api.voice.list());
    } catch {
      /* 浏览器预览模式不可用，隐藏入口由空列表兑现 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function importVoice() {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    setMsg('');
    try {
      const files = await api.library.pickFiles();
      const file = files[0];
      if (!file) return;
      const profile = await api.voice.add(file);
      setMsg(`已导入音色「${profile.name}」（${(profile.durationMs / 1000).toFixed(1)}s），可在分镜页选择使用`);
      await refresh();
    } catch (e) {
      setMsg(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function preview(samplePath: string) {
    const url = window.electronAPI?.toMediaUrl(samplePath);
    if (!url) return;
    const audio = new Audio(url);
    audio.play().catch(() => setMsg('试听失败：请确认样本文件存在'));
  }

  async function remove(id: string, name: string) {
    const api = window.electronAPI;
    if (!api) return;
    if (!window.confirm(`确定删除音色「${name}」？参考音频样本将一并清理。`)) return;
    await api.voice.remove(id);
    await refresh();
  }

  /** 绑定/解绑云端复刻 Speaker ID（S_xxxxx）：没有 NVIDIA 显卡时零样本克隆的真实可用路径 */
  async function bindSpeaker(id: string, speaker: string) {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const updated = await api.voice.setSpeaker(id, speaker.trim());
      setMsg(speaker.trim() ? `音色「${updated.name}」已绑定云端复刻 ${updated.cloudSpeaker}` : `音色「${updated.name}」已解绑云端复刻`);
      await refresh();
    } catch (e) {
      setMsg(`绑定失败：${(e as Error).message}`);
      await refresh();
    }
  }

  return (
    <Section
      title="自定义音色（零样本克隆）"
      desc="导入 3–20 秒清晰人声样本；分镜页为每场选音色即用克隆旁白。优先走本地 Index-TTS 2（需自备 GPU 服务），不可用时自动降级云端复刻→在线音色→静音占位，不阻断成片"
    >
      {voices.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚无自定义音色；导入一段参考音频即可开始克隆。</p>
      ) : (
        <ul className="space-y-1.5">
          {voices.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
              <Mic className="size-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {(v.durationMs / 1000).toFixed(1)}s
                {v.meanVolumeDb !== null ? ` · ${v.meanVolumeDb.toFixed(0)}dB` : ''}
              </span>
              <button
                onClick={() => preview(v.samplePath)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                title="试听参考样本"
              >
                <Play className="size-3.5" />
              </button>
              <input
                defaultValue={v.cloudSpeaker ?? ''}
                placeholder={v.cloudSpeaker ? '' : '云端复刻 S_xxx（可留空）'}
                aria-label="云端复刻 Speaker ID"
                className="h-7 w-40 shrink-0 rounded border border-input bg-transparent px-2 text-[11px]"
                onBlur={(e) => {
                  if (e.target.value.trim() !== (v.cloudSpeaker ?? '')) void bindSpeaker(v.id, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
              <button
                onClick={() => void remove(v.id, v.name)}
                className="rounded p-1 text-muted-foreground hover:text-destructive"
                title="删除音色（连带样本）"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between pt-1">
        <Button size="sm" variant="outline" className="rounded-full px-4 gap-1.5" onClick={() => void importVoice()} disabled={busy}>
          <Upload className="size-3.5" /> 导入参考音频
        </Button>
        {msg ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <CircleAlert className="size-3 shrink-0" />
            <span className="max-w-[55%] truncate">{msg}</span>
          </span>
        ) : null}
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<string>('通用设置');
  const [tts, setTts] = useState<TtsConfig | null>(null);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [videoGen, setVideoGen] = useState<VideoGenConfig | null>(null);
  const [imageGen, setImageGen] = useState<ImageGenConfig | null>(null);
  const [saved, setSaved] = useState('');
  /** TTS 连通性检测结论（保存后立即重测可避免「改了配置但不知道能不能用」） */
  const [ttsProbe, setTtsProbe] = useState<TtsProbeReport | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    void (async () => {
      const api = window.electronAPI;
      if (!api) return;
      try {
        setTts(await api.tts.getConfig());
      } catch {
        /* 预览模式下不可用 */
      }
      try {
        setLlm(await api.llm.getConfig());
      } catch {
        /* 同上 */
      }
      try {
        setVideoGen(await api.videoGen.getConfig());
      } catch {
        /* 同上 */
      }
      try {
        setImageGen(await api.imageGen.getConfig());
      } catch {
        /* 同上 */
      }
    })();
  }, []);

  async function saveTts() {
    const api = window.electronAPI;
    if (!api || !tts) return;
    setTts(await api.tts.setConfig(tts));
    setSaved('TTS 配置已保存');
    setTtsProbe(null);
  }

  /** 先落盘再探活，保证测的是刚填的地址/协议；探活只读，不产生合成费用 */
  async function runTtsProbe() {
    const api = window.electronAPI;
    if (!api || !tts) return;
    setProbing(true);
    try {
      const next = await api.tts.setConfig(tts);
      setTts(next);
      const report = await api.tts.probe(true);
      setTtsProbe(report);
      setSaved('');
    } catch (e) {
      setTtsProbe(null);
      setSaved(`连通性检测失败：${(e as Error).message}`);
    } finally {
      setProbing(false);
    }
  }

  async function saveLlm() {
    const api = window.electronAPI;
    if (!api || !llm) return;
    setLlm(await api.llm.setConfig(llm));
    setSaved('LLM 配置已保存');
  }

  async function saveVideoGen() {
    const api = window.electronAPI;
    if (!api || !videoGen) return;
    setVideoGen(await api.videoGen.setConfig(videoGen));
    setSaved('视频生成模型配置已保存');
  }

  async function saveImageGen() {
    const api = window.electronAPI;
    if (!api || !imageGen) return;
    setImageGen(await api.imageGen.setConfig(imageGen));
    setSaved('图像模型配置已保存');
  }

  const ttsReady = tts
    ? tts.active === 'volcano'
      ? Boolean(tts.volcano.appId && tts.volcano.accessToken)
      : tts.active === 'custom'
        ? Boolean(tts.custom.baseUrl)
        : Boolean(tts.local.baseUrl)
    : false;
  const llmReady = llm
    ? llm.active === 'offline'
      ? true
      : llm.active === 'ollama'
        ? Boolean(llm.ollama.baseUrl && llm.ollama.model)
        : llm.active === 'custom'
          ? Boolean(llm.custom.apiKey && llm.custom.baseUrl && llm.custom.model)
          : Boolean(llm.ark.apiKey)
    : false;
  const videoGenReady = videoGen
    ? videoGen.active === 'offline'
      ? true
      : videoGen.active === 'seedance'
        ? Boolean(videoGen.seedance.apiKey && videoGen.seedance.model)
        : videoGen.active === 'custom'
          ? Boolean(videoGen.custom.apiKey && videoGen.custom.baseUrl && videoGen.custom.model)
          : Boolean(videoGen.minimax.apiKey)
    : false;
  const imageGenReady = imageGen
    ? imageGen.active === 'offline'
      ? true
      : Boolean(imageGen.qwen.apiKey)
    : false;

  return (
    <div className="flex h-full gap-4 p-4">
      {/* 左侧 tab */}
      <aside className="w-48 shrink-0 rounded-xl border bg-card/60 p-3">
        <nav className="space-y-1">
          {tabs.map(({ label, icon: Icon }) => (
            <button
              key={label}
              onClick={() => setTab(label)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                tab === label
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 内容 */}
      <section className="min-w-0 flex-1 space-y-6 overflow-y-auto rounded-xl border bg-card/60 p-5">
        {tab === 'AI 设置' ? (
          <div className="max-w-2xl space-y-5">
            <div>
              <h2 className="text-sm font-semibold">AI 设置</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                未配置时 AI 剪辑仍可运行：TTS 会降级为静音占位，LLM 会回退离线 Provider。
              </p>
            </div>

            {/* TTS */}
            <Section title="语音合成（TTS）" desc="决定 AI 旁白的音色来源">
              {tts ? (
                <>
                  <Field label="Provider">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={tts.active}
                      onChange={(e) => setTts({ ...tts, active: e.target.value as TtsConfig['active'] })}
                    >
                      <option value="volcano">火山引擎（v3 WebSocket 流式）</option>
                      <option value="local">本地 Index-TTS 2（自托管服务）</option>
                      <option value="custom">自定义（OpenAI 兼容 /audio/speech）</option>
                    </select>
                  </Field>

                  <Field label="克隆优先级（选自定义音色时生效）">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={tts.clonePreference}
                      onChange={(e) =>
                        setTts({ ...tts, clonePreference: e.target.value as TtsConfig['clonePreference'] })
                      }
                    >
                      <option value="local-first">本地优先（隐私最好，需自备 GPU 服务）</option>
                      <option value="cloud-first">云端优先（无显卡环境推荐，走火山复刻音色）</option>
                    </select>
                  </Field>

                  {tts.active === 'volcano' ? (
                    <>
                      <Field label="App ID">
                        <Input
                          value={tts.volcano.appId}
                          onChange={(e) =>
                            setTts({ ...tts, volcano: { ...tts.volcano, appId: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="Access Token（访问控制 API Key）">
                        <Input
                          type="password"
                          value={tts.volcano.accessToken}
                          onChange={(e) =>
                            setTts({ ...tts, volcano: { ...tts.volcano, accessToken: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="音色 / Speaker ID（复刻音色填 S_xxxxx）">
                        <Input
                          value={tts.volcano.voice}
                          placeholder="zh_female_vv_uranus_bigtts 或 S_EVeoGUVU1"
                          onChange={(e) =>
                            setTts({ ...tts, volcano: { ...tts.volcano, voice: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="Resource ID（留空按音色自动路由）">
                        <Input
                          value={tts.volcano.resourceId}
                          placeholder="S_* → seed-icl-2.0；_uranus_ → seed-tts-2.0；其余 → seed-tts-1.0"
                          onChange={(e) =>
                            setTts({ ...tts, volcano: { ...tts.volcano, resourceId: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="情感提示（可选，自然语言描述）">
                        <Input
                          value={tts.volcano.emotion}
                          placeholder="越具体越有效，如：声音很轻很慢，像在耳边说话"
                          onChange={(e) =>
                            setTts({ ...tts, volcano: { ...tts.volcano, emotion: e.target.value } })
                          }
                        />
                      </Field>
                    </>
                  ) : tts.active === 'local' ? (
                    <>
                      <Field label="服务地址">
                        <Input
                          value={tts.local.baseUrl}
                          placeholder="官方 WebUI：http://127.0.0.1:7860；兼容壳看启动日志"
                          onChange={(e) =>
                            setTts({ ...tts, local: { ...tts.local, baseUrl: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="协议模式">
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                          value={tts.local.mode}
                          onChange={(e) =>
                            setTts({ ...tts, local: { ...tts.local, mode: e.target.value as TtsConfig['local']['mode'] } })
                          }
                        >
                          <option value="auto">自动识别（探活后定型）</option>
                          <option value="gradio">官方 Index-TTS 2 WebUI（Gradio REST）</option>
                          <option value="openai">OpenAI 兼容壳（/audio/speech）</option>
                          <option value="custom">内置壳（/tts 与 /tts/zero-shot）</option>
                        </select>
                      </Field>
                      {tts.local.mode === 'gradio' ? (
                        <Field label="Gradio 端点名（留空自动挑 tts/generate/synth）">
                          <Input
                            value={tts.local.gradioApiName}
                            placeholder="如 tts / generate（需 --enable_api 启动）"
                            onChange={(e) =>
                              setTts({ ...tts, local: { ...tts.local, gradioApiName: e.target.value } })
                            }
                          />
                        </Field>
                      ) : null}
                      <Field label="音色">
                        <Input
                          value={tts.local.voice}
                          onChange={(e) =>
                            setTts({ ...tts, local: { ...tts.local, voice: e.target.value } })
                          }
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="接入点（OpenAI 兼容根路径）">
                        <Input
                          value={tts.custom.baseUrl}
                          placeholder="如 http://127.0.0.1:5000/v1（POST {base}/audio/speech）"
                          onChange={(e) =>
                            setTts({ ...tts, custom: { ...tts.custom, baseUrl: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="模型">
                        <Input
                          value={tts.custom.model}
                          placeholder="tts-1 或服务文档指定"
                          onChange={(e) =>
                            setTts({ ...tts, custom: { ...tts.custom, model: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="音色">
                        <Input
                          value={tts.custom.voice}
                          onChange={(e) =>
                            setTts({ ...tts, custom: { ...tts.custom, voice: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="API Key（可选，网关要求 Bearer 时填）">
                        <Input
                          type="password"
                          value={tts.custom.apiKey ?? ''}
                          onChange={(e) =>
                            setTts({ ...tts, custom: { ...tts.custom, apiKey: e.target.value } })
                          }
                        />
                      </Field>
                    </>
                  )}

                  {ttsProbe ? (
                    <div className="space-y-2 rounded-lg border bg-background/40 p-2.5 text-[11px]">
                      <ProbeRow
                        label="火山引擎（v3 WebSocket 握手）"
                        ok={ttsProbe.volcano.ok}
                        configured={ttsProbe.volcano.configured}
                        message={ttsProbe.volcano.message}
                        extra={`${ttsProbe.volcano.latencyMs}ms`}
                      />
                      <ProbeRow
                        label="本地 Index-TTS 2"
                        ok={ttsProbe.local.ok}
                        configured={ttsProbe.local.configured}
                        message={ttsProbe.local.message}
                        hints={ttsProbe.local.hints}
                      />
                      <ProbeRow
                        label="自定义 TTS"
                        ok={ttsProbe.custom.ok}
                        configured={ttsProbe.custom.configured}
                        message={ttsProbe.custom.message}
                        hints={ttsProbe.custom.hints}
                      />
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <ConfiguredHint
                      ok={ttsReady}
                      text={ttsReady ? '已配置，将使用真实语音合成' : '未配置，旁白将降级为静音占位'}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="rounded-full px-4" onClick={runTtsProbe} disabled={probing}>
                        {probing ? '检测中…' : '检测连通性'}
                      </Button>
                      <Button size="sm" className="rounded-full px-4" onClick={saveTts}>
                        保存 TTS
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">加载中…</p>
              )}
            </Section>

            {/* M3 自定义音色库（零样本克隆） */}
            <VoiceLibrarySection />

            {/* LLM */}
            <Section title="大语言模型（LLM）" desc="决定创意简报与分镜脚本由谁生成">
              {llm ? (
                <>
                  <Field label="Provider">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={llm.active}
                      onChange={(e) => setLlm({ ...llm, active: e.target.value as LlmConfig['active'] })}
                    >
                      <option value="offline">离线（确定性，无需联网）</option>
                      <option value="ark">火山方舟（豆包）</option>
                      <option value="ollama">本地 Ollama（私有化）</option>
                      <option value="custom">自定义（OpenAI 兼容，如 DeepSeek）</option>
                    </select>
                  </Field>

                  {llm.active === 'ollama' ? (
                    <>
                      <Field label="服务地址">
                        <Input
                          value={llm.ollama.baseUrl}
                          placeholder="http://127.0.0.1:11434"
                          onChange={(e) => setLlm({ ...llm, ollama: { ...llm.ollama, baseUrl: e.target.value } })}
                        />
                      </Field>
                      <Field label="模型">
                        <Input
                          value={llm.ollama.model}
                          placeholder="qwen2.5:7b"
                          onChange={(e) => setLlm({ ...llm, ollama: { ...llm.ollama, model: e.target.value } })}
                        />
                      </Field>
                      <Field label="视觉模型（可选，图片附件内容识别）">
                        <Input
                          value={llm.ollama.visionModel ?? ''}
                          placeholder="如 qwen2.5-vl:7b，需先 ollama pull；留空则不识别图片内容"
                          onChange={(e) => setLlm({ ...llm, ollama: { ...llm.ollama, visionModel: e.target.value } })}
                        />
                      </Field>
                    </>
                  ) : null}

                  {llm.active === 'custom' ? (
                    <>
                      <Field label="接入点（OpenAI 兼容根路径）">
                        <Input
                          value={llm.custom.baseUrl}
                          placeholder="https://api.deepseek.com/v1"
                          onChange={(e) => setLlm({ ...llm, custom: { ...llm.custom, baseUrl: e.target.value } })}
                        />
                      </Field>
                      <Field label="API Key">
                        <Input
                          type="password"
                          value={llm.custom.apiKey}
                          placeholder="留空则回退离线 Provider"
                          onChange={(e) => setLlm({ ...llm, custom: { ...llm.custom, apiKey: e.target.value } })}
                        />
                      </Field>
                      <Field label="模型">
                        <Input
                          value={llm.custom.model}
                          placeholder="以服务商控制台模型 id 为准，如 deepseek-chat"
                          onChange={(e) => setLlm({ ...llm, custom: { ...llm.custom, model: e.target.value } })}
                        />
                      </Field>
                      <Field label="视觉模型（可选，图片附件内容识别）">
                        <Input
                          value={llm.custom.visionModel ?? ''}
                          placeholder="同端点下支持图片输入的模型 id，如 qwen-vl-max；留空则不识别图片内容"
                          onChange={(e) => setLlm({ ...llm, custom: { ...llm.custom, visionModel: e.target.value } })}
                        />
                      </Field>
                    </>
                  ) : null}

                  {llm.active === 'ark' ? (
                    <>
                      <Field label="API Key">
                        <Input
                          type="password"
                          value={llm.ark.apiKey}
                          placeholder="留空则回退离线 Provider"
                          onChange={(e) => setLlm({ ...llm, ark: { ...llm.ark, apiKey: e.target.value } })}
                        />
                      </Field>
                      <Field label="模型">
                        <Input
                          value={llm.ark.model}
                          onChange={(e) => setLlm({ ...llm, ark: { ...llm.ark, model: e.target.value } })}
                        />
                      </Field>
                      <Field label="接入点">
                        <Input
                          value={llm.ark.baseUrl}
                          onChange={(e) => setLlm({ ...llm, ark: { ...llm.ark, baseUrl: e.target.value } })}
                        />
                      </Field>
                      <Field label="视觉模型（可选，M4 画面描述）">
                        <Input
                          value={llm.ark.visionModel ?? ''}
                          placeholder="如 doubao-vision-pro-32k，留空则用启发式描述"
                          onChange={(e) => setLlm({ ...llm, ark: { ...llm.ark, visionModel: e.target.value } })}
                        />
                      </Field>
                    </>
                  ) : llm.active === 'offline' ? (
                    <p className="text-xs text-muted-foreground">
                      离线 Provider 依据需求文本与素材清单确定性生成简报与分镜，适合无网络/无密钥环境；
                      可切到「火山方舟」「本地 Ollama」或「自定义 OpenAI 兼容（DeepSeek 等）」并填写密钥使用真实大模型。
                    </p>
                  ) : null}

                  <div className="flex items-center justify-between pt-1">
                    <ConfiguredHint
                      ok={llmReady}
                      text={llmReady ? '已配置，将使用真实大模型' : '未配置，将回退离线 Provider'}
                    />
                    <Button size="sm" className="rounded-full px-4" onClick={saveLlm}>
                      保存 LLM
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">加载中…</p>
              )}
            </Section>

            {/* 视频生成模型 */}
            <Section title="视频生成模型" desc="为没有真实素材的分镜生成 AI 视频片段（Seedance / MiniMax H3 / 自定义）">
              {videoGen ? (
                <>
                  <Field label="Provider">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={videoGen.active}
                      onChange={(e) =>
                        setVideoGen({ ...videoGen, active: e.target.value as VideoGenConfig['active'] })
                      }
                    >
                      <option value="offline">离线（不生成视频，仅字幕/标题）</option>
                      <option value="seedance">Seedance（火山方舟视频，与 LLM 同账号）</option>
                      <option value="minimax">MiniMax H3（海螺 3.0）</option>
                      <option value="custom">自定义（OpenAI 兼容视频任务）</option>
                    </select>
                  </Field>

                  {videoGen.active === 'seedance' ? (
                    <>
                      <Field label="API Key（方舟，可与 LLM 同一 Key）">
                        <Input
                          type="password"
                          value={videoGen.seedance.apiKey}
                          placeholder="留空则不生成 AI 视频"
                          onChange={(e) =>
                            setVideoGen({ ...videoGen, seedance: { ...videoGen.seedance, apiKey: e.target.value } })
                          }
                        />
                      </Field>
                      <VideoModelPicker
                        label="模型（以方舟控制台视频列表为准）"
                        value={videoGen.seedance.model}
                        apiKey={videoGen.seedance.apiKey}
                        baseUrl={videoGen.seedance.baseUrl}
                        onPick={(model) =>
                          setVideoGen({ ...videoGen, seedance: { ...videoGen.seedance, model } })
                        }
                      />
                      <Field label="接入点">
                        <Input
                          value={videoGen.seedance.baseUrl}
                          onChange={(e) =>
                            setVideoGen({ ...videoGen, seedance: { ...videoGen.seedance, baseUrl: e.target.value } })
                          }
                        />
                      </Field>
                    </>
                  ) : null}

                  {videoGen.active === 'custom' ? (
                    <>
                      <Field label="接入点（OpenAI 兼容根路径）">
                        <Input
                          value={videoGen.custom.baseUrl}
                          placeholder="POST {base}/videos 建任 + GET {base}/videos/{id} 轮询"
                          onChange={(e) =>
                            setVideoGen({ ...videoGen, custom: { ...videoGen.custom, baseUrl: e.target.value } })
                          }
                        />
                      </Field>
                      <Field label="API Key">
                        <Input
                          type="password"
                          value={videoGen.custom.apiKey}
                          onChange={(e) =>
                            setVideoGen({ ...videoGen, custom: { ...videoGen.custom, apiKey: e.target.value } })
                          }
                        />
                      </Field>
                      <VideoModelPicker
                        label="模型"
                        value={videoGen.custom.model}
                        apiKey={videoGen.custom.apiKey}
                        baseUrl={videoGen.custom.baseUrl}
                        onPick={(model) => setVideoGen({ ...videoGen, custom: { ...videoGen.custom, model } })}
                      />
                    </>
                  ) : null}

                  {videoGen.active === 'minimax' ? (
                    <>
                      <Field label="API Key">
                        <Input
                          type="password"
                          value={videoGen.minimax.apiKey}
                          placeholder="留空则不生成 AI 视频"
                          onChange={(e) =>
                            setVideoGen({
                              ...videoGen,
                              minimax: { ...videoGen.minimax, apiKey: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <Field label="接入点">
                        <Input
                          value={videoGen.minimax.baseUrl}
                          placeholder="https://api.minimax.io"
                          onChange={(e) =>
                            setVideoGen({
                              ...videoGen,
                              minimax: { ...videoGen.minimax, baseUrl: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <Field label="模型">
                        <Input
                          value={videoGen.minimax.model}
                          onChange={(e) =>
                            setVideoGen({
                              ...videoGen,
                              minimax: { ...videoGen.minimax, model: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <Field label="生成分辨率（按秒计费）">
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                          value={videoGen.minimax.resolution ?? '2K'}
                          onChange={(e) =>
                            setVideoGen({
                              ...videoGen,
                              minimax: {
                                ...videoGen.minimax,
                                resolution: e.target.value as '768P' | '2K',
                              },
                            })
                          }
                        >
                          <option value="2K">2K（2560×1440）— 0.80 元/秒，画质最好</option>
                          <option value="768P">768P — 0.50 元/秒，省 37.5%</option>
                        </select>
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        一次 6 场景成片至少生成 24 秒（H3 最短 4s/段）：2K 约 19.2 元、768P 约 12 元。
                        工程画布只有 1080p 时 2K 产物会被下采样，验证阶段建议选 768P；
                        挂上素材目录后命中真实素材的场景不会调模型。
                      </p>
                      <p className="text-xs text-muted-foreground">
                        接入点必须与 Key 同源：国内平台（platform.minimax.cn）注册的 Key 填
                        https://api.minimaxi.com，海外（minimax.io）填 https://api.minimax.io；
                        两者不通用（填错只会报 invalid api key，引擎会自动换区重试一次）。
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      离线模式下，AI 成片不会调用视频生成模型，缺失素材的场景将退化为纯字幕/标题；
                      切到「Seedance / MiniMax H3 / 自定义」并填入 API Key 与模型 id 后，
                      引擎会在分镜阶段自动为缺素材场景补齐 AI 视频（生成全部失败时会直接报错，不再静默出 0 素材）。
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <ConfiguredHint
                      ok={videoGenReady}
                      text={
                        videoGenReady
                          ? videoGen.active === 'offline'
                            ? '离线模式，不生成 AI 视频'
                            : '已填写；能否真生成取决于该模型在 Provider 后台已开通（可用「拉取可用模型」校验）'
                          : '未配置完整，不生成 AI 视频'
                      }
                    />
                    <Button size="sm" className="rounded-full px-4" onClick={saveVideoGen}>
                      保存视频模型
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">加载中…</p>
              )}
            </Section>

            {/* 图像生成模型（分镜关键帧） */}
            <Section title="图像模型（分镜关键帧）" desc="为分镜逐镜生成关键帧图，作为图生视频（I2V）的首帧（千问图像 qwen-image）">
              {imageGen ? (
                <>
                  <Field label="Provider">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={imageGen.active}
                      onChange={(e) =>
                        setImageGen({ ...imageGen, active: e.target.value as ImageGenConfig['active'] })
                      }
                    >
                      <option value="offline">离线（不生成关键帧，视频走文生视频）</option>
                      <option value="qwen">千问图像（阿里云百炼 DashScope）</option>
                    </select>
                  </Field>

                  {imageGen.active === 'qwen' ? (
                    <>
                      <Field label="API Key（DashScope）">
                        <Input
                          type="password"
                          value={imageGen.qwen.apiKey}
                          placeholder="sk-…，留空则不生成关键帧"
                          onChange={(e) => setImageGen({ ...imageGen, qwen: { ...imageGen.qwen, apiKey: e.target.value } })}
                        />
                      </Field>
                      <Field label="接入点">
                        <Input
                          value={imageGen.qwen.baseUrl}
                          placeholder="https://dashscope.aliyuncs.com"
                          onChange={(e) => setImageGen({ ...imageGen, qwen: { ...imageGen.qwen, baseUrl: e.target.value } })}
                        />
                      </Field>
                      <Field label="文生图模型">
                        <Input
                          value={imageGen.qwen.textModel}
                          placeholder="qwen-image-3.0-pro"
                          onChange={(e) => setImageGen({ ...imageGen, qwen: { ...imageGen.qwen, textModel: e.target.value } })}
                        />
                      </Field>
                      <Field label="图像编辑模型">
                        <Input
                          value={imageGen.qwen.editModel}
                          placeholder="qwen-image-edit-max"
                          onChange={(e) => setImageGen({ ...imageGen, qwen: { ...imageGen.qwen, editModel: e.target.value } })}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        启用后，分镜确认续跑时会自动为缺素材的镜头生成关键帧，并以首帧驱动 MiniMax H3 图生视频；
                        未填 Key 时该步跳过，视频退回文生视频。北京/新加坡为独立 Key 与域名，不可跨区。
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      离线模式下不生成关键帧，generate-clips 将走文生视频 + 跨段参考图锁主体。
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <ConfiguredHint
                      ok={imageGenReady}
                      text={
                        imageGenReady
                          ? imageGen.active === 'offline'
                            ? '离线模式，不生成关键帧'
                            : '已填写，分镜关键帧将启用千问图像'
                          : '未填 API Key，不会生成关键帧'
                      }
                    />
                    <Button size="sm" className="rounded-full px-4" onClick={saveImageGen}>
                      保存图像模型
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">加载中…</p>
              )}
            </Section>

            {saved ? <p className="text-xs text-emerald-400">{saved}</p> : null}
          </div>
        ) : tab === '通用设置' ? (
          <>
            <div>
              <h2 className="mb-3 text-sm font-semibold">界面外观</h2>
              <div className="grid w-96 grid-cols-3 gap-3">
                {themes.map(({ label, icon: Icon, active }) => (
                  <button
                    key={label}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-lg border p-4 text-xs transition-colors',
                      active
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:border-input',
                    )}
                  >
                    <Icon className="size-5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold">默认保存路径</h2>
              <div className="flex max-w-md items-center gap-2">
                <div className="relative flex-1">
                  <Folder className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input readOnly defaultValue="D:\MagicCut\Projects" className="bg-card/60 pl-8 text-xs" />
                </div>
                <button className="rounded-md border border-input px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                  选择
                </button>
              </div>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold">行为</h2>
              <div className="max-w-md divide-y rounded-lg border">
                {toggles.map(({ label, desc, checked }) => (
                  <div key={label} className="flex items-center justify-between gap-4 p-3.5">
                    <div>
                      <p className="text-sm">{label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                    </div>
                    <Switch checked={checked} />
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground">「{tab}」暂未实现</p>
          </div>
        )}
      </section>
    </div>
  );
}
