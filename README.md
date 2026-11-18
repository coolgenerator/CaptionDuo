<div align="center">

# CaptionDuo

**Live bilingual captions for OBS.** Speak either of two languages and both appear on screen, the original and its translation.

English · [简体中文](README.zh-CN.md)

![Node.js ≥ 20.3](https://img.shields.io/badge/node-%E2%89%A5%2020.3-339933?logo=node.js&logoColor=white)
![OBS Studio](https://img.shields.io/badge/OBS-browser%20source-302E31?logo=obsstudio&logoColor=white)
![Zero runtime dependencies](https://img.shields.io/badge/dependencies-0%20required-informational)
![Runs locally](https://img.shields.io/badge/server-127.0.0.1%20only-blue)

<img src="docs/images/demo.gif" alt="CaptionDuo captions on a live stream: Chinese and English lines appear together as the speaker switches languages" width="860">

</div>

## Features

- **Two-way, auto-detected.** Pick two languages (say, Chinese and English) and speak either. CaptionDuo works out which one you used and shows the other as the translation. Each language always keeps its own line and style.
- **Low latency.** Captions appear while you're still talking and are finalized when you pause. Translations stream in token by token.
- **On-device speech-to-text.** The optional [SenseVoice](https://github.com/k2-fsa/sherpa-onnx) model runs on your machine: free, private, and only tens of milliseconds per sentence (zh / yue / en / ja / ko). A cloud speech-to-text model is used automatically for other languages.
- **Bring your own LLM.** Translation, and cloud speech-to-text when you need it, runs on the LLM of your choice: DeepSeek, Claude, Qwen, Gemini, and more. A glossary keeps names and jargon consistent.
- **Made for OBS.** A transparent 1920×1080 browser source. Font, colors, outline, background, position and line count are all adjustable, and changes reach OBS live without a refresh.
- **Multiple microphones.** Each mic gets its own captions. When one person is picked up by two mics (crosstalk), only the louder one is kept.
- **Transcripts saved for you.** Every session is saved as a readable `.md` file and a bilingual `.srt` you can drop into a video editor.
- **English or Chinese interface.** Switch at the top right of the control panel.

## How it works

```
Microphone ──> Control panel (Chrome: capture, voice activity detection)
                   │ audio / text
                   ▼
              server.js (127.0.0.1) ──> Speech-to-text: on-device SenseVoice (default) or a cloud audio LLM
                   │                └─> Translation: LLM (streaming)
                   ▼ Server-Sent Events
              OBS browser source /overlay (transparent captions)
```

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 20.3+, Chrome or Edge, [OBS Studio](https://obsproject.com), and an API key for your LLM provider.

```bash
git clone https://github.com/coolgenerator/CaptionDuo.git
cd CaptionDuo
npm install        # optional: only needed for on-device speech-to-text
npm start          # or double-click start.command on macOS
```

1. Open <http://127.0.0.1:8787/panel> in **Chrome**. On macOS, `start.command` opens it for you.
2. Enter your LLM API key, then click **Save** and **Test**.
3. Choose **Language A** and **Language B**, click **Start**, and allow microphone access.

Keep the control panel tab open while you stream. Audio is captured in that page.

<p align="center"><img src="docs/images/panel.png" alt="CaptionDuo control panel: recognition settings, caption preview, live transcript, model settings and caption style" width="860"></p>

## Use it in OBS

1. In OBS, go to **Sources → + → Browser** and name the source, for example `Captions`.
2. Fill in the source properties:
   - **URL:** `http://127.0.0.1:8787/overlay`
   - **Width / Height:** `1920` × `1080`, or your canvas size
   - Leave everything else at its default and click **OK**.
3. Keep the caption source at the **top of the Sources list** so it draws above your screen capture and camera.
4. For the same captions in every scene, choose **Add Existing** in the other scenes and pick `Captions`. Alternatively, put it in its own scene and nest that scene in the others.
5. In the control panel, click **Show sample caption** to position and style the captions. The sample costs nothing. Adjust size, colors and **Bottom offset** there; you don't need to move the source in OBS.

> [!TIP]
> If the overlay stays blank, check that the server is running and click **Show sample caption**. If it's still blank, right-click the source in OBS, open **Properties**, and click **Refresh cache of current page**.

## Recognition modes

| | Auto-detect language (default) | Chrome live recognition |
|---|---|---|
| What you can speak | Language A or B, detected automatically | Language A only |
| How text appears | Updates about every 0.35 s on-device, or every 1–2 s with cloud speech-to-text | Word by word |
| Where audio goes | Nowhere with on-device speech-to-text; to your cloud speech-to-text model with cloud | Google's speech service |
| Browser | Chrome / Edge | Chrome / Edge |

## On-device speech-to-text (optional, recommended)

CaptionDuo runs SenseVoice locally through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). It supports Chinese, Cantonese, English, Japanese and Korean.

1. Run `npm install` in the project folder. This installs `sherpa-onnx-node`.
2. From sherpa-onnx's [asr-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models), download `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2` (155 MB). Extract it and put `model.int8.onnx` and `tokens.txt` in `models/sense-voice/`. Don't use the 2025-09-09 package; it is a Cantonese-only fine-tune.
3. Restart the server. The startup log should say `On-device speech-to-text: ready`.

CaptionDuo falls back to cloud speech-to-text in two cases: when one of your languages isn't supported locally (for example Spanish), or when the local model hears a third language.

## Transcripts

Auto-save is on by default. You can turn it off under **Live transcript** in the control panel.

Each click on **Start** begins a new session. When the first sentence is finalized, two files are created in `transcripts/`:

- `YYYY-MM-DD_HH-MM-SS.md`: wall-clock time, original text and translation for every sentence.
- `YYYY-MM-DD_HH-MM-SS.srt`: bilingual subtitles, timed from the moment you clicked **Start**. Drop the file into your editor; if the recording started at a different time, shift the subtitles as a whole.

Transcripts stay on your computer. To change the folder, run `CAPTIONDUO_TRANSCRIPTS=/path node server.js`.

## Tips

- **Models.** Translation defaults to `deepseek/deepseek-v4.1-flash`. Cloud speech-to-text defaults to `qwen/qwen3.8-omni-flash`, which was the most accurate for Chinese in our tests; `google/gemini-3.1-flash-lite` is faster. You can switch to any model your provider offers. Speech-to-text models must accept audio input.
- **Glossary.** Add names, product terms and preferred translations under **Glossary / extra instructions**. They are added to both the translation and the speech-to-text prompts.
- **Disable reasoning** (on by default) tells models to answer without thinking first, which cuts latency a lot. If a model requires reasoning, the setting is dropped automatically.
- **Caption while speaking** shows captions before a sentence ends. Turn it off to make fewer API calls.
- **Sensitivity.** The yellow line on the level meter is the speech threshold. Lower the sensitivity if captions appear when nobody is talking; raise it if quiet speech is missed.
- **Translating computer audio.** Choose **Tab / system audio** and enable audio sharing, or route system audio through a virtual device such as BlackHole.
- **Port.** To use a different port, run `PORT=8790 node server.js`. The server only listens on `127.0.0.1`.

## Privacy & API key safety

- Your API key is stored only in `config.json` (file mode `600`). You can also provide it through an environment variable instead.
- `config.json` and `transcripts/` are listed in `.gitignore`, so they are never committed.
- The key never leaves the server. The control panel only shows its last four characters, and the overlay page never receives it.
- The server binds to `127.0.0.1`. It rejects requests whose `Host` or `Origin` isn't local, which protects against other websites and DNS rebinding.
- With on-device speech-to-text, audio never leaves your machine. Only the recognized text is sent to your LLM provider for translation.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Port 8787 is already in use` | CaptionDuo is probably already running. Close it, or start it with `PORT=8790`. |
| The control panel says the server is an older version | Stop the server with `Ctrl+C` and start it again. The page reloads by itself. |
| Microphone permission denied | Click the icon at the left of Chrome's address bar and allow the microphone. |
| No microphones listed | Click **Start** once and grant access. Browsers hide device names until then. |
| Captions are cut off or too wide | Lower **Max width (%)** or **Max lines per language** in **Caption style**. |

## Project structure

```
server.js            Local server: speech-to-text, translation, SSE broadcast, transcripts
public/panel.html    Control panel: capture, voice activity detection, settings, preview
public/overlay.html  Transparent caption layer for the OBS browser source
start.command        macOS launcher (starts the server, opens the panel)
models/sense-voice/  Optional on-device speech-to-text model (not committed)
transcripts/         Saved transcripts (not committed)
```

## License

[MIT](LICENSE)
