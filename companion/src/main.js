// LyricLens Companion frontend
// Connects to the Rust WS bridge via Tauri's event/invoke API. The Rust side
// owns the ws://127.0.0.1:47621 server; this module just renders state
// snapshots and emits commands.

// Tauri 2 exposes `window.__TAURI__` only when app.withGlobalTauri is true;
// also keep a fallback to __TAURI_INTERNALS__ for raw invoke if the
// global was not configured.
const tauri = window.__TAURI__ || {};
const internals = window.__TAURI_INTERNALS__ || null;
const invoke = tauri.core?.invoke || tauri.invoke || internals?.invoke;
const listen = tauri.event?.listen;

const PROTOCOL_VERSION = 1;

const els = {
  root: document.getElementById("root"),
  status: document.getElementById("status"),
  content: document.getElementById("content"),
  footer: document.getElementById("footer"),
  counter: document.getElementById("counter"),
  progressFill: document.getElementById("progress-fill"),
  prev: document.getElementById("prev-btn"),
  next: document.getElementById("next-btn"),
  popin: document.getElementById("popin-btn")
};

let currentState = null;
let connected = false;

if (typeof listen === "function") {
  listen("bridge://connected", (event) => {
    connected = event.payload === true;
    if (!connected) {
      currentState = null;
      els.content.innerHTML = '<div class="empty">等待插件连接...</div>';
      els.footer.style.display = "none";
      els.status.textContent = "等待插件连接...";
    } else {
      els.status.textContent = "已连接，等待数据...";
    }
  });

  listen("bridge://message", (event) => {
    let msg;
    try { msg = JSON.parse(event.payload); } catch (_) { return; }
    if (!msg || msg.v !== PROTOCOL_VERSION) return;
    if (msg.type === "state") renderState(msg.payload);
    else if (msg.type === "hello") console.log("[companion] plugin hello", msg.payload);
    else if (msg.type === "command") handleIncomingCommand(msg.payload);
  });
} else {
  els.status.textContent = "Tauri 环境不可用";
}

function handleIncomingCommand(payload) {
  if (!payload || typeof payload.name !== "string") return;
  if (payload.name === "popIn") {
    // Plugin took the UI back into NCM — close ourselves so we don't leave
    // an orphan window. Fired both from user clicking 收回 inside companion
    // (which round-trips through the plugin) and from the NCM-side chip.
    closeSelf();
  }
}

function closeSelf() {
  if (typeof invoke !== "function") return;
  invoke("close_companion").catch(() => {});
}

els.prev.addEventListener("click", () => sendCommand("prev"));
els.next.addEventListener("click", () => sendCommand("next"));
els.popin.addEventListener("click", async () => {
  try { await sendCommand("popIn"); } catch (_) {}
  // Fallback close in case the plugin's reciprocal popIn doesn't make it
  // back through the WS before close.
  setTimeout(closeSelf, 400);
});

async function sendCommand(name, payload) {
  if (typeof invoke !== "function") return;
  const message = {
    v: PROTOCOL_VERSION,
    type: "command",
    payload: payload === undefined ? { name } : { name, payload }
  };
  try {
    await invoke("send_to_plugin", { message: JSON.stringify(message) });
  } catch (err) {
    console.warn("[companion] send_to_plugin failed", err);
  }
}

function renderState(state) {
  currentState = state;
  applyVisuals(state);

  const cards = Array.isArray(state.cards) ? state.cards : [];
  const idx = Number.isFinite(state.currentCardIndex) ? state.currentCardIndex : 0;

  if (state.mode === "hidden") {
    els.content.innerHTML = '<div class="empty">面板隐藏中</div>';
    els.footer.style.display = "none";
    els.status.textContent = "已隐藏";
    return;
  }

  if (state.mode === "loading") {
    els.content.innerHTML = `<div class="empty">${escapeText(state.loadingMessage || "正在分析当前歌词...")}</div>`;
    els.footer.style.display = "none";
    els.status.textContent = "拆解中...";
    return;
  }

  if (state.mode === "error") {
    els.content.innerHTML = `<div class="empty error">${escapeText(state.errorMessage || "拆解失败")}</div>`;
    els.footer.style.display = "none";
    els.status.textContent = "失败";
    return;
  }

  if (state.mode === "config") {
    els.content.innerHTML = '<div class="empty">请回到网易云内完成 AI 服务配置</div>';
    els.footer.style.display = "none";
    els.status.textContent = "需要配置";
    return;
  }

  const card = state.currentCard;
  if (!card) {
    els.content.innerHTML = '<div class="empty">当前歌词行没有学习卡片</div>';
    els.footer.hidden = cards.length === 0;
  } else {
    els.content.innerHTML = "";
    els.content.appendChild(renderCard(card, state.language));
    els.footer.style.display = "";
  }

  els.counter.textContent = cards.length ? `${idx + 1} / ${cards.length}` : "0 / 0";
  els.progressFill.style.width = cards.length ? `${((idx + 1) / cards.length) * 100}%` : "0%";
  els.prev.disabled = idx <= 0;
  els.next.disabled = idx >= cards.length - 1;
  els.status.textContent = state.autoFollow ? "跟随播放" : "手动浏览";
}

function applyVisuals(state) {
  const s = state.settings || {};
  document.body.dataset.theme = s.theme === "light" ? "light" : "dark";
  document.body.dataset.fontSize = ["compact", "standard", "large"].includes(s.fontSize) ? s.fontSize : "standard";
  const opacity = Number(s.opacity);
  document.documentElement.style.setProperty(
    "--panel-opacity",
    String(Number.isFinite(opacity) ? opacity : 0.96)
  );
}

function renderCard(card, language) {
  const wrapper = el("div", "card");

  const meta = el("div", "card-meta");
  const lineIndex = card.lineIndex ?? card.index ?? 0;
  const startMs = Number(card.startMs ?? card.startTime);
  const time = Number.isFinite(startMs)
    ? `  ${String(Math.floor(startMs / 60000)).padStart(2, "0")}:${String(Math.floor((startMs % 60000) / 1000)).padStart(2, "0")}`
    : "";
  meta.textContent = `LINE ${String(lineIndex).padStart(2, "0")}${time}`;
  wrapper.appendChild(meta);

  wrapper.appendChild(el("h2", "card-line", card.line || card.original || ""));
  wrapper.appendChild(el("div", "card-translation", card.translation || ""));
  wrapper.appendChild(el("div", "card-section-label", "学习点"));

  const list = el("div", "highlights");
  if (Array.isArray(card.highlights) && card.highlights.length) {
    card.highlights.forEach((h) => list.appendChild(renderHighlight(h, language)));
  } else {
    list.appendChild(el("div", "empty-point", "这一句以语气和情绪表达为主。"));
  }
  wrapper.appendChild(list);

  if (typeof card.note === "string" && card.note.trim()) {
    const note = el("div", "card-note");
    note.appendChild(el("b", "", "注释"));
    note.appendChild(el("span", "", card.note));
    wrapper.appendChild(note);
  }
  return wrapper;
}

function renderHighlight(highlight, language) {
  const node = el("section", "highlight");

  if (typeof highlight === "string") {
    const head = el("div", "highlight-head");
    const sep = Math.max(highlight.indexOf("："), highlight.indexOf(":"));
    if (sep > 0) {
      head.appendChild(el("span", "phrase", highlight.slice(0, sep)));
      head.appendChild(el("span", "meaning", `：${highlight.slice(sep + 1)}`));
    } else {
      head.appendChild(el("span", "meaning", highlight));
    }
    node.appendChild(head);
    return node;
  }

  const head = el("div", "highlight-head");
  head.appendChild(el("span", "phrase", highlight.phrase || ""));
  if (language === "ja" && highlight.reading) {
    head.appendChild(el("span", "reading", highlight.reading));
  }
  head.appendChild(el("span", "arrow", "→"));
  head.appendChild(el("span", "meaning", highlight.meaning || ""));
  node.appendChild(head);

  if (language === "ja") appendNote(node, "文法", highlight.grammar);
  else appendNote(node, "发音", highlight.pronunciation);
  appendNote(node, "语境", highlight.context);

  return node;
}

function appendNote(parent, label, text) {
  if (!text) return;
  const note = el("div", "note");
  note.appendChild(el("b", "", label));
  note.appendChild(el("span", "", text));
  parent.appendChild(note);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function escapeText(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}
