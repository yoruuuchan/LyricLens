# LyricLens

[中文](README.md) · [English](README.en.md)

LyricLens is a BetterNCM plugin (v0.1 MVP) that turns NetEase Cloud Music into an AI-powered language-learning overlay. While an English or Japanese song is playing, it reads the current lyrics, asks a user-configured OpenAI-compatible Chat Completions endpoint to produce a learning card, and renders a fixed floating panel inside the NCM client.

## Screenshots

<p align="center">
  <img src="screenshots/lyric-ncm.png" alt="Learning card following the lyrics inside the NetEase Cloud Music client (Aimer — After Rain)" width="85%" />
</p>

<p align="center">
  <img src="screenshots/lyric-amll.png" alt="Learning card alongside AMLL's immersive lyric view (dark theme)" width="85%" />
</p>

<p align="center">
  <img src="screenshots/settings.png" alt="Settings panel: AI Service (OpenAI-compatible endpoint, API key, model)" width="55%" />
</p>

## Install

### Recommended: from a GitHub Release

1. Quit NetEase Cloud Music.
2. Grab the latest `LyricLens-x.y.z.plugin` from the [Releases](https://github.com/yoruuuchan/LyricLens/releases) page.
3. Drag the `.plugin` file into BetterNCM's plugin manager, or unzip it into `plugins/lyriclens/` under your BetterNCM plugins directory.
4. Restart NCM and enable LyricLens from BetterNCM's plugin list.

### From source (for developers)

1. Quit NetEase Cloud Music.
2. Copy the whole repo into your BetterNCM plugins directory, e.g. `plugins/lyriclens/`.
3. Make sure `manifest.json`, `main.js`, `src/`, and `styles/` are all present.
4. Restart NCM and enable LyricLens from BetterNCM's plugin list.

No build step is required — the source files are loaded as-is. To repackage the `.plugin`, run `npm run build`.

## Configuration

The first time an English or Japanese song plays without an API configured, the overlay shows a setup form. You can also click the gear icon in the top-right corner of the overlay at any time.

You'll need to fill in:

- **API Endpoint** — full OpenAI-compatible Chat Completions URL, e.g. `https://api.openai.com/v1/chat/completions`
- **API Key** — your provider's key
- **Model Name** — model identifier
- **Auto-decompose** — on by default
- **Default overlay position**
- **Overlay opacity**

The API key is written to BetterNCM's local config and mirrored to `localStorage` as an MVP fallback. It is never sent to the plugin author or any third-party server.

## Debug logging

The plugin logs:

- Plugin load success
- Current `songId`
- Lyric source and field probes
- Language-detection results
- API request start/success/failure/timeout
- `PlayProgress` argument probes

To view the logs:

- When BetterNCM/NCM exposes DevTools, open the Console.
- To open the main-process console, run `betterncm.app.showConsole(true)` from the BetterNCM environment.

### Diagnostics mode

Diagnostics mode is off by default. To enable it for real-client verification, run in the Console:

```js
localStorage.setItem("ll_debug", "true");
location.reload();
```

To turn it off:

```js
localStorage.removeItem("ll_debug");
location.reload();
```

When enabled, the Console emits messages with the prefix `[LyricLens:diagnostics]`, covering:

- Presence, type, safely-truncated sample, and errors for BetterNCM / NCM key objects
- Top-level structure of the lyric payload captured by `window.onProcessLyrics`
- `PlayProgress` argument structure for the first 5 calls and then every 10 seconds
- Parse / load / failure state for `styles/panel.css`

A collapsible "Diagnostics" entry also appears inside the overlay, showing current `songId`, language detection, lyric source, card count, current card index, API state, last error, and CSS state.

## Known limitations

- The exact lyric-object fields BetterNCM/NCM expose still need confirmation on a real client; the plugin falls back through `window.currentLyrics`, `window.CPPLYRICS_INTERNALS?.currentLyrics`, `window.AMLL?.currentLyrics`, the `window.onProcessLyrics` wrapper, and finally `betterncm.ncm.getPlayingSong()`.
- No manifest hijack — the plugin does not rewrite NCM/AMLL/CppLyrics's internal rendering.
- The in-memory cache only lasts for the current client session.
- The MVP does not provide a native BetterNCM settings page; the gear-icon form is the only entry point.
- Whether API requests work depends on the user-configured endpoint, the network, and CORS/`fetch` behavior in the client.

## Real-client verification template

```md
### LyricLens v0.1 client-verification log

- Verification date:
- NetEase Cloud Music version:
- BetterNCM / chromatic version:
- Operating system:

#### Runtime probe

- `window.betterncm`:
- `betterncm.ncm`:
- `betterncm.ncm.getPlaying`:
- `betterncm.ncm.getPlayingSong`:
- `legacyNativeCmder`:
- `window.currentLyrics`:
- `window.CPPLYRICS_INTERNALS?.currentLyrics`:
- `window.AMLL?.currentLyrics`:
- `betterncm.app.readConfig`:
- `betterncm.app.writeConfig`:

#### Sample returns

- `getPlaying` safely-truncated sample:
- `getPlayingSong` safely-truncated sample:
- Lyric payload top-level keys:
- `lrc/yrc/tlyric/romalrc` availability:
- Lyric string length:
- First 2 lines (redacted / truncated):
- `PlayProgress` argument shape:
- `readConfig/writeConfig` availability:
- CSS loading method availability:

#### Per-song verification

- English song — songId / result:
- Japanese song — songId / result:
- Chinese song — songId / result:
- API failure result:
- Track-switch cancellation result:

#### Issues found

-

#### Conclusion

-
```

## Local tests

```powershell
npm test
```

The test suite covers pure-logic modules: language detection, lyric preprocessing, cache keys, tolerant LLM JSON parsing, and playback-time sync.
