#!/usr/bin/env node
'use strict';

// CaptionDuo — 本地字幕服务
// 控制面板 --音频或识别文本--> 本服务 --OpenRouter 听写/翻译--> OBS 浏览器源(SSE)
// 不装任何依赖也能跑（Node 20.3+）；本机听写、Silero 人声检测是可选依赖，连接 OBS 需要 Node 22+。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';
const STARTED_AT = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = process.env.CAPTIONDUO_CONFIG || path.join(__dirname, 'config.json');
const TRANSCRIPT_DIR = process.env.CAPTIONDUO_TRANSCRIPTS || path.join(__dirname, 'transcripts');
const BASE_URL =(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// code: BCP-47 代码（Chrome 识别用）；name: 写进提示词的语言名；label: 面板显示名
const LANGS = [
  { code: 'zh-CN', name: 'Simplified Chinese', label: '中文（简体）' },
  { code: 'zh-TW', name: 'Traditional Chinese', label: '中文（繁體）' },
  { code: 'yue-Hant-HK', name: 'Cantonese', label: '粤语' },
  { code: 'en-US', name: 'English', label: 'English' },
  { code: 'ja-JP', name: 'Japanese', label: '日本語' },
  { code: 'ko-KR', name: 'Korean', label: '한국어' },
  { code: 'es-ES', name: 'Spanish', label: 'Español' },
  { code: 'fr-FR', name: 'French', label: 'Français' },
  { code: 'de-DE', name: 'German', label: 'Deutsch' },
  { code: 'ru-RU', name: 'Russian', label: 'Русский' },
  { code: 'pt-BR', name: 'Portuguese', label: 'Português' },
  { code: 'it-IT', name: 'Italian', label: 'Italiano' },
  { code: 'th-TH', name: 'Thai', label: 'ไทย' },
  { code: 'vi-VN', name: 'Vietnamese', label: 'Tiếng Việt' },
  { code: 'id-ID', name: 'Indonesian', label: 'Bahasa Indonesia' },
  { code: 'ar-SA', name: 'Arabic', label: 'العربية' },
];

const CONFIG_VERSION = 2;
const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  apiKey: '',
  model: 'deepseek/deepseek-v4.1-flash', // 翻译模型
  asrEngine: 'local', // local: 本机 SenseVoice 听写（没装或语言不支持时自动改用云端）| cloud: OpenRouter 听写模型
  audioModel: 'qwen/qwen3.8-omni-flash', // 云端听写模型
  disableReasoning: true, // 让模型不要先“思考”，字幕才跟得上
  recognition: 'auto', // auto: 音频交给听写模型，自动判断说的是 A 还是 B | chrome: Chrome 实时识别，固定说 A
  langA: 'zh-CN',
  langB: 'en-US',
  audioSource: 'mic', // mic | display
  translateInterim: true, // 说话过程中就出字幕（更实时，调用更多）
  interimIntervalMs: 900,
  contextPairs: 3, // 带上最近几句作为上下文
  glossary: '',
  replacements: '', // 替换规则：听写纠错和屏蔽词，每行一条（见 compileRules）
  translateBase: '', // 自定义翻译接口（OpenAI 兼容，如 Ollama），空 = OpenRouter
  translateApiKey: '', // 自定义翻译接口的 Key（可选）；OpenRouter 的 Key 不会发给自定义接口
  obs: {
    enabled: false, // 通过 obs-websocket 连接 OBS
    url: 'ws://127.0.0.1:4455',
    password: '',
    micInput: '', // OBS 里麦克风来源的名字
    pauseOnMute: true, // 这个来源在 OBS 里静音时暂停字幕
    streamCaption: 'off', // off | a | b | both：把定稿字幕作为直播流自带字幕（CEA-608）发出去
  },
  saveTranscript: true, // 每句定稿后把原文和译文追加到 transcripts/ 里的记录文件
  uiLang: 'en', // 面板界面和服务端提示用的语言：en | zh
  style: {
    layout: 'a-top', // a-top | b-top：哪种语言在上
    showA: true,
    showB: true,
    fontFamily: '',
    fontWeight: 700,
    sizeA: 36,
    sizeB: 46,
    colorA: '#ffffff',
    colorB: '#ffe27a',
    strokeColor: '#000000',
    strokeWidth: 3,
    bgColor: '#000000',
    bgOpacity: 0.45,
    align: 'center', // left | center | right
    maxLines: 2,
    maxWidthPct: 90,
    vPos: 'bottom', // bottom | top：字幕贴着画面底边还是顶边
    bottomOffset: 60, // 离贴靠的那条边的距离（vPos 为 top 时是距顶部）
    historyLines: 0, // 额外保留几句旧字幕
    hideAfterSec: 8, // 静默多少秒后隐藏，0 = 不隐藏
  },
};

// ---------- 配置 ----------

function mergeKnown(target, defaults, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const k of Object.keys(defaults)) {
    const v = patch[k];
    if (v == null) continue;
    const d = defaults[k];
    if (d && typeof d === 'object') mergeKnown(target[k], d, v);
    else if (typeof d === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) target[k] = n;
    } else if (typeof d === 'boolean') target[k] = Boolean(v);
    else target[k] = String(v).slice(0, 20000);
  }
}

// v1 的配置按「原文/译文」命名；v2 改为固定的两种显示语言 A/B，默认翻译模型换成 DeepSeek
function migrate(raw) {
  if ((raw.configVersion || 1) >= CONFIG_VERSION) return raw;
  const s = raw.style || {};
  return {
    ...raw,
    model: raw.model === 'anthropic/claude-haiku-5.5' ? DEFAULTS.model : raw.model,
    langA: raw.sourceLang,
    langB: raw.targetLang,
    style: {
      ...s,
      layout: s.layout === 'target-top' ? 'b-top' : 'a-top',
      showA: s.showSource,
      showB: s.showTarget,
      sizeA: s.sourceSize,
      sizeB: s.targetSize,
      colorA: s.sourceColor,
      colorB: s.targetColor,
    },
  };
}

// ---------- 界面语言 ----------
// 会显示给用户的提示（面板上的报错、终端里的启动信息、记录文件的标题）按 config.uiLang 出

const MSG = {
  en: {
    timeout: '{svc} timed out',
    netFail: "Can't reach {svc} (network problem{code}). Check your network, proxy or the API address.",
    noKey: 'No OpenRouter API key yet (enter it in the control panel)',
    orError: '{svc}: {msg}',
    unknownError: 'unknown error',
    modelMissing: 'Model file not found: models/sense-voice/model.int8.onnx',
    sherpaMissing: 'sherpa-onnx-node is not installed (run npm install in the project folder)',
    localLangs: 'The on-device model only supports Chinese, Cantonese, English, Japanese and Korean',
    localSame: 'Both languages are the same language for the on-device model',
    badWav: 'Not a valid WAV file',
    saveFailed: 'Failed to save transcript: {msg}',
    bodyTooLarge: 'Request body too large',
    needWav: 'audio/wav required',
    missingAudio: 'Missing id or audio',
    needJson: 'application/json required',
    pageFailed: 'Failed to read page',
    mdTitle: 'CaptionDuo transcript',
    mdLangs: 'Languages',
    noTranslation: '(no translation)',
    started: 'CaptionDuo is running',
    panelUrl: '  Control panel (open in Chrome): {url}',
    overlayUrl: '  OBS browser source URL        : {url}',
    localReady: '  On-device speech-to-text: ready (SenseVoice)',
    localDown: '  On-device speech-to-text: unavailable, using cloud ({reason})',
    keyTip: '  Tip: no OpenRouter API key yet. Enter it in the control panel.',
    writing: '[transcript] writing {file}.md / .srt',
    portInUse: 'Port {port} is already in use. CaptionDuo may already be running, or pick another port: PORT=8790 node server.js',
    configRead: '[config] Failed to read {path}, using defaults: {msg}',
    configSave: '[config] Failed to save: {msg}',
    vadOrtMissing: 'onnxruntime-web is not installed (run npm install in the project folder)',
    vadModelMissing: 'Model file not found: models/silero-vad/silero_vad.onnx',
    obsNoWs: 'Connecting to OBS needs Node.js 22 or newer',
    obsUnreachable: "Can't reach OBS at {url}. Is OBS open, with Tools → WebSocket Server Settings → Enable WebSocket server turned on?",
    obsNeedPassword: 'OBS asks for a password: enter the one shown in OBS (Tools → WebSocket Server Settings → Show Connect Info)',
    obsAuthFailed: 'OBS rejected the password',
    obsClosed: 'OBS closed the connection ({code})',
    obsNoInput: 'No source named “{name}” in OBS',
    obsNotConnected: 'Not connected to OBS',
    obsLog: '[obs] {msg}',
  },
  zh: {
    timeout: '{svc} 响应超时',
    netFail: '连不上 {svc}（网络问题{code}），请检查网络、代理或接口地址',
    noKey: '还没有设置 OpenRouter API Key（在控制面板里填写）',
    orError: '{svc}：{msg}',
    unknownError: '未知错误',
    modelMissing: '没有找到模型文件 models/sense-voice/model.int8.onnx',
    sherpaMissing: '没有安装 sherpa-onnx-node（在项目目录运行 npm install）',
    localLangs: '本地模型只支持中文、粤语、英语、日语、韩语',
    localSame: '两种语言在本地模型里是同一种，分不开',
    badWav: '不是有效的 WAV 音频',
    saveFailed: '记录保存失败：{msg}',
    bodyTooLarge: '请求体过大',
    needWav: '需要 audio/wav',
    missingAudio: '缺少 id 或音频',
    needJson: '需要 application/json',
    pageFailed: '读取页面失败',
    mdTitle: 'CaptionDuo 记录',
    mdLangs: '语言',
    noTranslation: '（没有译文）',
    started: 'CaptionDuo 已启动',
    panelUrl: '  控制面板（用 Chrome 打开）: {url}',
    overlayUrl: '  OBS 浏览器源地址          : {url}',
    localReady: '  本地听写：已就绪（SenseVoice）',
    localDown: '  本地听写：不可用，改用云端听写（{reason}）',
    keyTip: '  提示：还没有设置 OpenRouter API Key，请在控制面板里填写。',
    writing: '[记录] 写入 {file}.md / .srt',
    portInUse: '端口 {port} 已被占用。可能 CaptionDuo 已在运行，或用 PORT=8790 node server.js 换个端口。',
    configRead: '[config] 读取 {path} 失败，使用默认配置：{msg}',
    configSave: '[config] 保存失败：{msg}',
    vadOrtMissing: '没有安装 onnxruntime-web（在项目目录运行 npm install）',
    vadModelMissing: '没有找到模型文件 models/silero-vad/silero_vad.onnx',
    obsNoWs: '连接 OBS 需要 Node.js 22 或更新版本',
    obsUnreachable: '连不上 {url} 上的 OBS：OBS 开着吗？「工具 → WebSocket 服务器设置」里的「开启 WebSocket 服务器」勾上了吗？',
    obsNeedPassword: 'OBS 要求密码：填 OBS 里显示的密码（工具 → WebSocket 服务器设置 → 显示连接信息）',
    obsAuthFailed: 'OBS 拒绝了这个密码',
    obsClosed: 'OBS 断开了连接（{code}）',
    obsNoInput: 'OBS 里没有叫「{name}」的来源',
    obsNotConnected: '还没有连上 OBS',
    obsLog: '[obs] {msg}',
  },
};

function msg(key, vars = {}) {
  const text = (MSG[config.uiLang] || MSG.en)[key] ?? MSG.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

let config = structuredClone(DEFAULTS);
try {
  mergeKnown(config, DEFAULTS, migrate(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))));
  config.configVersion = CONFIG_VERSION;
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(msg('configRead', { path: CONFIG_PATH, msg: e.message }));
}
if (!MSG[config.uiLang]) config.uiLang = 'en';

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(msg('configSave', { msg: e.message }));
  }
}

const apiKey = () => config.apiKey || process.env.OPENROUTER_API_KEY || '';

// 发给面板的配置：去掉所有密钥，只告诉它有没有
function publicConfig() {
  const { apiKey: _omit, translateApiKey: _omit2, ...rest } = config;
  const { password: _omit3, ...obsRest } = config.obs;
  const key = apiKey();
  return {
    ...rest,
    obs: { ...obsRest, hasPassword: Boolean(config.obs.password) },
    hasTranslateKey: Boolean(config.translateApiKey),
    hasKey: Boolean(key),
    keyHint: key ? `…${key.slice(-4)}` : '',
    keyFromEnv: !config.apiKey && Boolean(process.env.OPENROUTER_API_KEY),
  };
}

const langName = (code) => (LANGS.find((l) => l.code === code) || {}).name || code;
const langLabel = (code) => (LANGS.find((l) => l.code === code) || {}).label || code;
const langOf = (side) => (side === 'b' ? config.langB : config.langA);
const otherSide = (side) => (side === 'b' ? 'a' : 'b');

// 只有文字、不知道是哪种语言时（手动输入、Chrome 识别里夹了另一种语言），按文字的书写系统猜
const HAN = '\\p{Script=Han}';
const SCRIPTS = {
  zh: HAN,
  yue: HAN,
  ja: `${HAN}\\p{Script=Hiragana}\\p{Script=Katakana}`,
  ko: '\\p{Script=Hangul}',
  ru: '\\p{Script=Cyrillic}',
  th: '\\p{Script=Thai}',
  ar: '\\p{Script=Arabic}',
};
const scriptOf = (code) => SCRIPTS[code.split('-')[0]] || '\\p{Script=Latin}';
const CJK = `${SCRIPTS.ja}，。？！、；：`;

function guessSide(text) {
  const sa = scriptOf(config.langA);
  const sb = scriptOf(config.langB);
  if (sa === sb) return 'a';
  // 一个汉字/假名的信息量大约抵得上几个拉丁字母
  const weigh = (s) => (text.match(new RegExp(`[${s}]`, 'gu')) || []).length * (s.includes('Latin') ? 1 : 3);
  return weigh(sb) > weigh(sa) ? 'b' : 'a';
}

// ---------- SSE 广播 ----------

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000).unref();

function errorText(e) {
  const svc = e.service || 'OpenRouter';
  if (e.name === 'TimeoutError') return msg('timeout', { svc });
  // Node 的 fetch 在断网、DNS 失败、连接被重置时只报 "fetch failed"，原因在 cause 里
  if (e.message === 'fetch failed') return msg('netFail', { svc, code: e.cause?.code ? `: ${e.cause.code}` : '' });
  return e.message;
}

let lastError = { message: '', at: 0 };
function reportError(e) {
  const message = errorText(e);
  const now = Date.now();
  if (message === lastError.message && now - lastError.at < 5000) return message;
  lastError = { message, at: now };
  console.warn(`[openrouter] ${message}`);
  broadcast('error', { message });
  return message;
}

// ---------- OpenRouter ----------

const reasoningRequired = new Set(); // 不允许关闭推理的模型，试过一次后记住

async function errorDetail(res) {
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body).error?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200) || res.statusText;
  }
}

// 流式调用，返回完整文本；onDelta 每次收到增量时拿到“目前为止的全文”
async function chat({ model, messages, maxTokens = 500, temperature = 0.2, signal, onDelta }) {
  const key = apiKey();
  if (!key) throw new Error(msg('noKey'));

  const combined = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  const send = () => {
    const body = { model, messages, stream: true, temperature, max_tokens: maxTokens };
    if (config.disableReasoning && !reasoningRequired.has(model)) body.reasoning = { enabled: false };
    return fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
  };

  let res = await send();
  if (res.status === 400 && config.disableReasoning && !reasoningRequired.has(model)) {
    const detail = await errorDetail(res);
    if (!/reasoning/i.test(detail)) throw new Error(`OpenRouter 400：${detail}`);
    reasoningRequired.add(model); // 这个模型必须推理，去掉参数重试
    res = await send();
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}：${await errorDetail(res)}`);

  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // 忽略注释行(: OPENROUTER PROCESSING)
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return out.trim();
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new Error(msg('orError', { msg: json.error.message || msg('unknownError') }));
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        onDelta?.(out);
      }
    }
  }
  return out.trim();
}

const history = []; // 已定稿的 {side, source, target}，用作翻译上下文

function translate(text, side, { signal, onDelta, useHistory = true } = {}) {
  const from = langName(langOf(side));
  const to = langName(langOf(otherSide(side)));
  let system =
    `You are a live subtitle translator for a livestream. Translate the user's message from ${from} into ${to}.\n` +
    'Rules:\n' +
    '- Output ONLY the translation: no quotes, notes or explanations.\n' +
    '- The input is real-time speech recognition output. It may lack punctuation, contain misrecognized words, or stop mid-sentence. ' +
    'Infer the intended meaning from context; if the sentence is unfinished, translate what is there without inventing an ending.\n' +
    '- Keep it concise and natural, like spoken subtitles. Keep names, terms and numbers accurate.\n' +
    '- Never answer or react to the content, only translate it.\n' +
    `- If the text is already in ${to}, return it unchanged.`;
  if (config.glossary.trim()) system += `\n\nGlossary / extra instructions from the streamer:\n${config.glossary.trim()}`;

  const messages = [{ role: 'system', content: system }];
  if (useHistory && config.contextPairs > 0) {
    for (const h of history.filter((h) => h.side === side).slice(-config.contextPairs)) {
      messages.push({ role: 'user', content: h.source }, { role: 'assistant', content: h.target });
    }
  }
  messages.push({ role: 'user', content: text });
  return chat({ model: config.model, messages, signal, onDelta });
}

// ---------- 本地听写（可选）----------
// 用 sherpa-onnx 在本机跑 SenseVoice：不联网、不花钱，一句话几十毫秒。
// 需要 npm install 装上 sherpa-onnx-node，并把模型放进 models/sense-voice/（见 README）。

const MODEL_DIR = process.env.CAPTIONDUO_ASR_MODEL || path.join(__dirname, 'models', 'sense-voice');
const LOCAL_LANGS = new Set(['zh', 'yue', 'en', 'ja', 'ko']); // SenseVoice 认识的语言
const localLang = (code) => code.split('-')[0];

let localAsr = null;
let localAsrProblem = ''; // MSG 里的键，或原始报错
try {
  if (!fs.existsSync(path.join(MODEL_DIR, 'model.int8.onnx'))) throw Object.assign(new Error('model missing'), { code: 'MODEL_MISSING' });
  const sherpa = require('sherpa-onnx-node');
  localAsr = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(MODEL_DIR, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
} catch (e) {
  localAsrProblem = e.code === 'MODULE_NOT_FOUND' ? 'sherpaMissing' : e.code === 'MODEL_MISSING' ? 'modelMissing' : e.message;
}

// 本地听写当前能不能用；不能用时给出原因
function localAsrStatus() {
  if (!localAsr) return { ready: false, reason: MSG.en[localAsrProblem] ? msg(localAsrProblem) : localAsrProblem };
  const unsupported = [config.langA, config.langB].filter((c) => !LOCAL_LANGS.has(localLang(c)));
  if (unsupported.length) return { ready: false, reason: msg('localLangs') };
  if (localLang(config.langA) === localLang(config.langB)) return { ready: false, reason: msg('localSame') };
  return { ready: true, reason: '' };
}

function readWav(wav) {
  let at = 12, sampleRate = 16000, data = null;
  while (at < wav.length - 8) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ') sampleRate = wav.readUInt32LE(at + 12);
    if (id === 'data') {
      data = wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!data) throw new Error(msg('badWav'));
  const samples = new Float32Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate };
}

// 返回 { side, text }；没听到人话返回 null；判成了 A、B 以外的语言返回 undefined（交给云端再听一次）
function transcribeLocal(wav, final) {
  const stream = localAsr.createStream();
  stream.acceptWaveform(readWav(wav));
  localAsr.decode(stream);
  const result = localAsr.getResult(stream);
  let text = (result.text || '').trim();
  // 模型总会给结果补上句号；话还没说完时去掉，免得字幕里出现“今天我们。”
  if (!final) text = text.replace(/[。．.！!？?，,、；;：:\s]+$/u, '');
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const lang = (result.lang || '').replace(/[<|>]/g, '');
  if (lang === localLang(config.langA)) return { side: 'a', text };
  if (lang === localLang(config.langB)) return { side: 'b', text };
  return undefined;
}

// 听写：把一段语音转成文字，返回 { side, text }；没听到人话时返回 null
async function transcribe(wav, signal, final) {
  if (config.asrEngine === 'local' && localAsrStatus().ready) {
    const heard = transcribeLocal(wav, final);
    if (heard !== undefined) return heard;
    if (!final || !apiKey()) return null; // 说到一半时判错语种就先跳过，等定稿
  }
  return transcribeCloud(wav, signal);
}

// 云端听写：交给 OpenRouter 上能听音频的模型
async function transcribeCloud(wav, signal) {
  let system =
    `You are a speech recognizer for livestream captions. The speaker uses either ${langName(config.langA)} (tag A) or ${langName(config.langB)} (tag B).\n` +
    'Transcribe the audio verbatim in the language actually spoken, with natural punctuation. Do NOT translate and do not add anything.\n' +
    'Output exactly one line: "[A] " or "[B] " followed by the transcript.\n' +
    'If there is no intelligible speech (silence, noise, music), output only: [NONE]';
  if (config.glossary.trim()) system += `\n\nNames and terms that may be spoken:\n${config.glossary.trim()}`;
  // 带上前几句字幕：同音字、专有名词靠上下文更容易听对
  const recent = history.slice(-3).map((h) => `- ${h.source}`);
  if (recent.length) {
    system += `\n\nWhat was said just before (context only, to help with similar-sounding words; transcribe only the new audio):\n${recent.join('\n')}`;
  }

  const out = await chat({
    model: config.audioModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] },
    ],
    maxTokens: 400,
    temperature: 0,
    signal,
  });
  const firstLine = out.split('\n')[0].trim();
  if (!firstLine || /\[NONE\]/i.test(firstLine)) return null;
  const m = /^\[(A|B)\]\s*(.*)$/i.exec(firstLine);
  // 有的模型会在汉字之间插空格（“听 懂 了 吗”），去掉
  const tidy = (s) => s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'gu'), '$1');
  if (!m) return { side: guessSide(firstLine), text: tidy(firstLine) };
  return m[2] ? { side: m[1].toLowerCase(), text: tidy(m[2]) } : null;
}

// ---------- 自动保存记录 ----------
// 每次在面板点「开始识别」算一场，第一句定稿时才建文件（没说话就不留空文件）。
// 同时写两个文件：.md 给人看（时钟时间 + 原文 + 译文），.srt 给视频配字幕（时间从这一场开始算起）。

let transcript = null; // { base, origin, count }
let sessionStart = 0; // 面板点开始的时间，作为 .srt 的 0 秒

const pad = (n, w = 2) => String(n).padStart(w, '0');
const fileStamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const clockTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const srtTime = (ms) => {
  ms = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();

function newTranscript() {
  transcript = null;
  sessionStart = Date.now();
}

function openTranscript(firstAt) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const d = new Date(sessionStart || firstAt);
  let name = fileStamp(d);
  for (let i = 2; fs.existsSync(path.join(TRANSCRIPT_DIR, `${name}.md`)); i++) name = `${fileStamp(d)}-${i}`;
  const base = path.join(TRANSCRIPT_DIR, name);
  const langs = `${langLabel(config.langA)} ↔ ${langLabel(config.langB)}`;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(d)}`;
  fs.writeFileSync(`${base}.md`, `# ${msg('mdTitle')} ${date}\n\n${msg('mdLangs')}: ${langs}\n\n`);
  fs.writeFileSync(`${base}.srt`, '');
  transcript = { base, origin: sessionStart || firstAt, count: 0 };
  console.log(msg('writing', { file: base }));
  broadcast('transcript', { file: name });
}

function saveRecord(seg, result) {
  if (!config.saveTranscript || seg.saved || !seg.text) return;
  seg.saved = true;
  try {
    if (!transcript) openTranscript(seg.startedAt);
    const source = oneLine(seg.text);
    const target = oneLine(result);
    fs.appendFileSync(`${transcript.base}.md`, `**${clockTime(new Date(seg.startedAt))}**  \n${source}  \n${target || msg('noTranslation')}\n\n`);

    // 和字幕层一样，按「哪种语言在上」排两行
    const a = seg.side === 'a' ? source : target;
    const b = seg.side === 'a' ? target : source;
    const lines = (config.style.layout === 'b-top' ? [b, a] : [a, b]).filter(Boolean);
    const start = seg.startedAt - transcript.origin;
    const end = Math.max((seg.endedAt || Date.now()) - transcript.origin, start + 1000);
    fs.appendFileSync(`${transcript.base}.srt`, `${++transcript.count}\n${srtTime(start)} --> ${srtTime(end)}\n${lines.join('\n')}\n\n`);
  } catch (e) {
    console.warn(msg('saveFailed', { msg: e.message }));
    broadcast('error', { message: msg('saveFailed', { msg: e.message }) });
  }
}

function openTranscriptDir() {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [TRANSCRIPT_DIR], () => {});
}

// ---------- 分句调度 ----------
// 每个 segment 是一句话。说话过程中(interim)按间隔翻译最新文本，
// 句子结束(final)时取消进行中的请求，立刻翻译定稿。

const segments = new Map();

function getSegment(id) {
  let seg = segments.get(id);
  if (!seg) {
    seg = { id, text: '', side: 'a', final: false, seq: -1, rev: 0, inflight: null, timer: null, lastStart: 0, lastSent: '', done: null, startedAt: Date.now(), endedAt: 0, saved: false };
    segments.set(id, seg);
    if (segments.size > 200) segments.delete(segments.keys().next().value);
  }
  return seg;
}

function onSpeech({ id, text, final, seq, side }) {
  const seg = getSegment(id);
  if (seg.final || seq <= seg.seq) return; // 乱序到达的旧更新
  seg.seq = seq;
  seg.text = text;
  seg.side = side || guessSide(text);
  seg.final = final;
  if (final) seg.endedAt = Date.now();
  broadcast('source', { id, text, final, side: seg.side });

  if (!final) {
    if (config.translateInterim) scheduleInterim(seg);
    return;
  }
  clearTimeout(seg.timer);
  seg.timer = null;
  seg.inflight?.abort();
  if (seg.done && seg.done.key === `${seg.side}:${text}`) {
    // 定稿和刚翻完的那版一样，直接沿用
    broadcast('translation', { id, rev: ++seg.rev, text: seg.done.result, done: true, final: true });
    settle(seg, seg.done.result);
  } else runTranslation(seg);
}

function settle(seg, result) {
  saveRecord(seg, result);
  if (result) {
    history.push({ side: seg.side, source: seg.text, target: result });
    if (history.length > 40) history.shift();
  }
  setTimeout(() => segments.delete(seg.id), 30000).unref();
}

function scheduleInterim(seg) {
  if (seg.inflight || seg.timer || seg.final) return;
  const wait = Math.max(0, seg.lastStart + config.interimIntervalMs - Date.now());
  seg.timer = setTimeout(() => {
    seg.timer = null;
    if (!seg.final && `${seg.side}:${seg.text}` !== seg.lastSent) runTranslation(seg);
  }, wait);
}

async function runTranslation(seg) {
  const final = seg.final;
  const key = `${seg.side}:${seg.text}`;
  const rev = ++seg.rev;
  const ac = new AbortController();
  seg.inflight = ac;
  seg.lastStart = Date.now();
  seg.lastSent = key;
  try {
    const result = await translate(seg.text, seg.side, {
      signal: ac.signal,
      onDelta: (partial) => broadcast('translation', { id: seg.id, rev, text: partial, done: false, final }),
    });
    broadcast('translation', { id: seg.id, rev, text: result, done: true, final });
    seg.done = { key, result };
    if (final) settle(seg, result);
  } catch (e) {
    if (!ac.signal.aborted) reportError(e);
    if (final) settle(seg, '');
  } finally {
    if (seg.inflight === ac) seg.inflight = null;
    if (!final && !seg.final && `${seg.side}:${seg.text}` !== key && config.translateInterim) scheduleInterim(seg);
  }
}

// ---------- 音频听写（自动识别语种） ----------

const audioJobs = new Map(); // id -> 进行中的“未说完”听写请求
const audioFinal = new Set(); // 已收到定稿音频的 id

async function onAudio({ id, seq, final, wav }) {
  if (audioFinal.has(id)) return { ok: false };
  audioJobs.get(id)?.abort(); // 同一句有更新的音频来了，旧的不用等
  const ac = new AbortController();
  if (final) {
    audioJobs.delete(id);
    audioFinal.add(id);
    if (audioFinal.size > 500) audioFinal.delete(audioFinal.values().next().value);
  } else audioJobs.set(id, ac);

  try {
    const heard = await transcribe(wav, ac.signal, final);
    if (heard) onSpeech({ id, seq, final, ...heard });
    else if (final) {
      // 定稿没听出内容，但之前显示过中间结果：按中间结果收尾
      const seg = segments.get(id);
      if (seg && !seg.final && seg.text) onSpeech({ id, seq, final: true, text: seg.text, side: seg.side });
    }
    return { ok: true, ...heard };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false };
    return { ok: false, error: reportError(e) };
  } finally {
    if (audioJobs.get(id) === ac) audioJobs.delete(id);
  }
}

function clearAll() {
  for (const seg of segments.values()) {
    clearTimeout(seg.timer);
    seg.inflight?.abort();
  }
  for (const ac of audioJobs.values()) ac.abort();
  audioJobs.clear();
  segments.clear();
  history.length = 0;
  broadcast('clear', {});
}

// ---------- HTTP ----------

const PAGES = { '/panel': 'panel.html', '/overlay': 'overlay.html' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(msg('bodyTooLarge')));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 示例字幕（不调用模型）
const DEMO = [
  { src: 'zh', zh: '大家好，欢迎来到今天的分享。', en: "Hi everyone, welcome to today's talk." },
  { src: 'en', en: 'Let me show you how live bilingual captions work.', zh: '我来给大家演示一下实时双语字幕是怎么工作的。' },
  { src: 'zh', zh: '你可以说中文，也可以说英文，字幕会自动翻译。', en: 'You can speak Chinese or English, and the captions translate automatically.' },
  { src: 'en', en: 'The captions appear in OBS as a transparent overlay.', zh: '字幕会以透明图层的形式出现在 OBS 里。' },
];
let demoIndex = 0;

const api = {
  'GET /api/config': async () => ({
    config: publicConfig(),
    langs: LANGS,
    overlayUrl: `http://${HOST}:${PORT}/overlay`,
    localAsr: localAsrStatus(),
    transcriptFile: transcript ? path.basename(transcript.base) : '',
  }),

  'POST /api/config': async (body) => {
    mergeKnown(config, DEFAULTS, body);
    if (!MSG[config.uiLang]) config.uiLang = 'en';
    if (typeof body.apiKey === 'string') config.apiKey = body.apiKey.trim();
    config.configVersion = CONFIG_VERSION;
    saveConfig();
    broadcast('config', { style: config.style });
    return { config: publicConfig(), localAsr: localAsrStatus() };
  },

  // Chrome 识别或手动输入的文字；side 不给时按文字猜是 A 还是 B
  'POST /api/speech': async (body) => {
    const id = String(body.id || '').slice(0, 80);
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!id || !text) return { ok: false };
    onSpeech({ id, text, final: Boolean(body.final), seq: Number(body.seq) || 0 });
    return { ok: true };
  },

  // 面板点了「开始识别」：下一句定稿时开一个新的记录文件
  'POST /api/transcript/new': async () => {
    newTranscript();
    return { ok: true };
  },

  'POST /api/transcript/open': async () => {
    openTranscriptDir();
    return { ok: true };
  },

  'POST /api/clear': async () => {
    clearAll();
    return { ok: true };
  },

  // 不调用模型，直接推一条示例字幕，方便在 OBS 里摆位置、调样式
  // 每点一次换一句，中英轮流当原文；译文分几步推出，和真实的流式翻译看起来一样
  'POST /api/demo': async () => {
    const id = `demo-${Date.now()}`;
    const d = DEMO[demoIndex++ % DEMO.length];
    const other = d.src === 'zh' ? 'en' : 'zh';
    const sideOf = (lang) => (config.langA.startsWith(lang) ? 'a' : config.langB.startsWith(lang) ? 'b' : '');
    const side = sideOf(d.src) || (sideOf(other) === 'a' ? 'b' : 'a');
    broadcast('source', { id, text: d[d.src], final: true, side });
    const target = d[other];
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const cut = i === steps ? target.length : Math.round((target.length * i) / steps);
      setTimeout(() => broadcast('translation', { id, rev: i, text: target.slice(0, cut), done: i === steps, final: true }), i * 90);
    }
    return { ok: true };
  },

  'POST /api/test': async () => {
    const sample = config.langA.startsWith('en') ? 'Hello everyone, welcome to the stream.' : '大家好，欢迎来到直播间。';
    const t0 = Date.now();
    try {
      const text = await translate(sample, guessSide(sample), { useHistory: false });
      return { ok: true, sample, text, ms: Date.now() - t0, model: config.model };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  },
};

const server = http.createServer(async (req, res) => {
  // 只接受来自本机页面的请求（防 DNS 重绑定 / 其他网站跨站调用）
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const contentType = req.headers['content-type'] || '';

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(302, { Location: '/panel' }).end();
    return;
  }

  if (req.method === 'GET' && PAGES[pathname]) {
    fs.readFile(path.join(PUBLIC_DIR, PAGES[pathname]), (err, data) => {
      if (err) return res.writeHead(500).end(msg('pageFailed'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    // hello 带上本次启动时间：页面发现服务重启过（可能更新了代码）就自动重新加载
    res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ startedAt: STARTED_AT })}\n\n`);
    res.write(`event: config\ndata: ${JSON.stringify({ style: config.style })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  try {
    // 一段语音（WAV）：?id=句子编号&seq=序号&final=0|1
    if (req.method === 'POST' && pathname === '/api/audio') {
      if (!/^audio\/wav/i.test(contentType)) return sendJson(res, 415, { error: msg('needWav') });
      const id = (url.searchParams.get('id') || '').slice(0, 80);
      const wav = await readBody(req, 4 * 1024 * 1024);
      if (!id || wav.length < 1000) return sendJson(res, 400, { error: msg('missingAudio') });
      return sendJson(res, 200, await onAudio({ id, wav, seq: Number(url.searchParams.get('seq')) || 0, final: url.searchParams.get('final') === '1' }));
    }

    const handler = api[`${req.method} ${pathname}`];
    if (!handler) {
      res.writeHead(404).end('Not found');
      return;
    }
    let body = {};
    if (req.method === 'POST') {
      if (!/^application\/json/i.test(contentType)) return sendJson(res, 415, { error: msg('needJson') });
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    }
    sendJson(res, 200, await handler(body));
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(msg('portInUse', { port: PORT }));
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(msg('started'));
  console.log(msg('panelUrl', { url: `http://${HOST}:${PORT}/panel` }));
  console.log(msg('overlayUrl', { url: `http://${HOST}:${PORT}/overlay` }));
  console.log(localAsr ? msg('localReady') : msg('localDown', { reason: localAsrStatus().reason }));
  if (!apiKey()) console.log(msg('keyTip'));
});
