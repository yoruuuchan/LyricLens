(function initLyricLensPanel(root) {
  "use strict";

  const STORAGE_KEYS = {
    x: "ll_panel_x",
    y: "ll_panel_y",
    width: "ll_panel_width",
    height: "ll_panel_height",
    collapsed: "ll_panel_collapsed",
    autoFollow: "ll_panel_auto_follow"
  };
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 220;
  const FEEDBACK_URL = "https://lyriclens.yoru-and-akari.dev/feedback";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const KNOWLEDGE_POINT_LABELS = {
    vocabulary: "词汇",
    grammar: "语法",
    culture: "文化背景",
    pronunciation: "发音",
    tone: "语感"
  };
  let activePanel = null;

  const ICON_SHAPES = {
    settings: [
      ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
      ["circle", { cx: "12", cy: "12", r: "3" }]
    ],
    "arrow-left": [
      ["line", { x1: "19", y1: "12", x2: "5", y2: "12" }],
      ["polyline", { points: "12 19 5 12 12 5" }]
    ],
    minus: [["line", { x1: "5", y1: "12", x2: "19", y2: "12" }]],
    x: [
      ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
      ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }]
    ],
    "chevron-left": [["polyline", { points: "15 18 9 12 15 6" }]],
    "chevron-right": [["polyline", { points: "9 18 15 12 9 6" }]],
    "chevron-down": [["polyline", { points: "6 9 12 15 18 9" }]],
    "external-link": [
      ["path", { d: "M15 3h6v6" }],
      ["path", { d: "M10 14L21 3" }],
      ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]
    ]
  };

  function createIcon(name) {
    const svg = root.document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    (ICON_SHAPES[name] || []).forEach(([tag, attributes]) => {
      const shape = root.document.createElementNS(SVG_NAMESPACE, tag);
      Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, value));
      svg.appendChild(shape);
    });
    return svg;
  }

  function toNumber(value, fallback) {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toBool(value, fallback) {
    if (value === true || value === false) return value;
    if (value == null || value === "") return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
  }

  function clampPanelBounds(bounds, viewport = {}, effective = null) {
    const viewportWidth = Math.max(1, Number(viewport.width) || 1280);
    const viewportHeight = Math.max(1, Number(viewport.height) || 720);
    const width = Math.min(Math.max(MIN_WIDTH, toNumber(bounds?.width, 420)), viewportWidth);
    const height = Math.min(Math.max(MIN_HEIGHT, toNumber(bounds?.height, 360)), viewportHeight);
    // effective lets the caller clamp x/y against the actually-displayed size
    // (e.g. 52x52 badge or 268x72 popped-out chip) without changing the
    // persisted panel width/height — so unminimize still gets a full panel.
    const effectiveWidth = Number.isFinite(Number(effective?.width)) ? Number(effective.width) : width;
    const effectiveHeight = Number.isFinite(Number(effective?.height)) ? Number(effective.height) : height;
    const maxX = Math.max(0, viewportWidth - effectiveWidth);
    const maxY = Math.max(0, viewportHeight - effectiveHeight);
    return {
      x: Math.min(Math.max(0, toNumber(bounds?.x, maxX - 28)), maxX),
      y: Math.min(Math.max(0, toNumber(bounds?.y, maxY - 28)), maxY),
      width,
      height
    };
  }

  function shouldStartPanelDrag(event) {
    if (!event || event.button !== 0) return false;
    const target = event.target;
    if (!target?.closest) return true;
    return !target.closest("button,input,textarea,select,a,summary,[data-ll-no-drag],.ll-actions,.ll-debug-entry,.ll-settings-form,.ll-highlight-list");
  }

  function defaultViewport(root) {
    return {
      width: root.innerWidth || 1280,
      height: root.innerHeight || 720
    };
  }

  function readStoredBounds(storage, fallbackBounds, viewport) {
    const fromStorage = {
      x: toNumber(storage?.getItem?.(STORAGE_KEYS.x), fallbackBounds.x),
      y: toNumber(storage?.getItem?.(STORAGE_KEYS.y), fallbackBounds.y),
      width: toNumber(storage?.getItem?.(STORAGE_KEYS.width), fallbackBounds.width),
      height: toNumber(storage?.getItem?.(STORAGE_KEYS.height), fallbackBounds.height)
    };
    return clampPanelBounds(fromStorage, viewport);
  }

  function persistBounds(storage, bounds) {
    try {
      storage?.setItem?.(STORAGE_KEYS.x, String(Math.round(bounds.x)));
      storage?.setItem?.(STORAGE_KEYS.y, String(Math.round(bounds.y)));
      storage?.setItem?.(STORAGE_KEYS.width, String(Math.round(bounds.width)));
      storage?.setItem?.(STORAGE_KEYS.height, String(Math.round(bounds.height)));
    } catch (_) {}
  }

  function createPanelState(options = {}) {
    const storage = options.storage;
    const diagnostics = options.diagnostics;
    const viewport = () => {
      if (typeof options.viewport === "function") return options.viewport();
      return options.viewport || { width: 1280, height: 720 };
    };
    const defaultBounds = options.defaultBounds || { x: 832, y: 332, width: 420, height: 360 };
    const selectByTime = options.selectCardByPlaybackTime || root.LyricLens?.Sync?.selectCardByPlaybackTime;
    let cards = [];
    let currentAnalyzeKey = null;
    let displayedAnalyzeKey = null;
    let currentCardIndex = 0;
    let mode = "hidden";
    let panelBounds = readStoredBounds(storage, defaultBounds, viewport());
    let panelCollapsed = toBool(storage?.getItem?.(STORAGE_KEYS.collapsed), false);
    let autoFollow = toBool(storage?.getItem?.(STORAGE_KEYS.autoFollow), true);

    function currentCard() {
      return cards[currentCardIndex] || null;
    }

    function cardText(card) {
      return String(card?.original || card?.line || "").slice(0, 200) || null;
    }

    function cardTimingDiagnostics() {
      const card = currentCard();
      const previous = cards[currentCardIndex - 1] || null;
      const next = cards[currentCardIndex + 1] || null;
      return {
        currentCardOriginal: cardText(card),
        previousCardLineIndex: previous?.lineIndex ?? previous?.index ?? null,
        previousCardOriginal: cardText(previous),
        previousCardStartMs: previous?.startMs ?? previous?.startTime ?? null,
        nextCardLineIndex: next?.lineIndex ?? next?.index ?? null,
        nextCardOriginal: cardText(next),
        nextCardStartMs: next?.startMs ?? next?.startTime ?? null
      };
    }

    function diagnosticPayload(extra = {}) {
      const card = currentCard();
      return {
        displayedAnalyzeKey,
        displayedCardCount: cards.length,
        currentCardIndex,
        currentCardLineIndex: card?.lineIndex ?? card?.index ?? null,
        currentCardStartMs: card?.startMs ?? card?.startTime ?? null,
        currentCardEndMs: card?.endMs ?? card?.endTime ?? null,
        ...cardTimingDiagnostics(),
        panelDraggable: true,
        panelResizable: true,
        panelBounds: { ...panelBounds },
        panelCollapsed,
        autoFollow,
        ...extra
      };
    }

    function updateDiagnostics(extra = {}) {
      diagnostics?.updateState?.(diagnosticPayload(extra));
    }

    function sampleForCard(card) {
      if (!card) return "";
      return [card.line || card.original, card.translation].filter(Boolean).join(" / ").slice(0, 200);
    }

    function clampIndex(index) {
      if (!cards.length) return 0;
      return Math.max(0, Math.min(cards.length - 1, Number.isFinite(Number(index)) ? Number(index) : 0));
    }

    function resetForAnalyze(analyzeKey, reason = "analyze-key-changed") {
      currentAnalyzeKey = analyzeKey || null;
      displayedAnalyzeKey = null;
      cards = [];
      currentCardIndex = 0;
      mode = "loading";
      updateDiagnostics({
        currentAnalyzeKey,
        lastPanelResetReason: reason,
        staleCardsCleared: true,
        panelLastRenderReason: "analyzing",
        panelLastRenderedAt: Date.now(),
        panelTextSample: "正在分析当前歌词..."
      });
      return getState();
    }

    function setCards(payload = {}) {
      cards = Array.isArray(payload.cards) ? payload.cards.slice() : [];
      currentAnalyzeKey = payload.analyzeKey || currentAnalyzeKey || null;
      displayedAnalyzeKey = currentAnalyzeKey;
      mode = cards.length ? "card" : "error";
      const selectedByTime = Number.isFinite(Number(payload.currentMs)) && typeof selectByTime === "function"
        ? selectByTime(Number(payload.currentMs), cards)
        : null;
      currentCardIndex = clampIndex(selectedByTime ?? payload.initialIndex ?? 0);
      return renderCurrentCard(payload.reason || "analyze-success");
    }

    function renderCurrentCard(reason = "render") {
      const card = currentCard();
      updateDiagnostics({
        panelLastRenderReason: reason,
        panelLastRenderedAt: Date.now(),
        panelTextSample: sampleForCard(card)
      });
      return card;
    }

    function setCurrentIndex(index, reason = "manual") {
      currentCardIndex = clampIndex(index);
      return renderCurrentCard(reason);
    }

    function nextCard(reason = "manual-next") {
      setCurrentIndex(currentCardIndex + 1, reason);
      return currentCardIndex;
    }

    function prevCard(reason = "manual-prev") {
      setCurrentIndex(currentCardIndex - 1, reason);
      return currentCardIndex;
    }

    function syncToPlayback(currentMs, reason = "playback-sync") {
      if (!autoFollow) {
        updateDiagnostics({ playbackSyncStatus: "disabled" });
        return currentCardIndex;
      }
      if (typeof selectByTime !== "function") {
        updateDiagnostics({ playbackSyncStatus: "no-time-source" });
        return currentCardIndex;
      }
      const nextIndex = selectByTime(currentMs, cards);
      if (nextIndex === null || nextIndex === currentCardIndex) return currentCardIndex;
      setCurrentIndex(nextIndex, reason);
      return currentCardIndex;
    }

    function setAutoFollow(value) {
      autoFollow = Boolean(value);
      try {
        storage?.setItem?.(STORAGE_KEYS.autoFollow, String(autoFollow));
      } catch (_) {}
      updateDiagnostics({ autoFollow });
      return autoFollow;
    }

    function setCollapsed(value) {
      panelCollapsed = Boolean(value);
      try {
        storage?.setItem?.(STORAGE_KEYS.collapsed, String(panelCollapsed));
      } catch (_) {}
      updateDiagnostics({ panelCollapsed });
      return panelCollapsed;
    }

    function setBounds(bounds, persist = true, effective = null) {
      panelBounds = clampPanelBounds(bounds, viewport(), effective);
      if (persist) persistBounds(storage, panelBounds);
      updateDiagnostics({ panelBounds: { ...panelBounds } });
      return { ...panelBounds };
    }

    function moveTo(x, y) {
      return setBounds({ ...panelBounds, x, y }, true);
    }

    function resizeTo(width, height) {
      return setBounds({ ...panelBounds, width, height }, true);
    }

    function showStatus(nextMode, text, reason) {
      mode = nextMode;
      if (nextMode !== "card") {
        cards = [];
        displayedAnalyzeKey = null;
        currentCardIndex = 0;
      }
      updateDiagnostics({
        displayedCardCount: cards.length,
        panelLastRenderReason: reason || nextMode,
        panelLastRenderedAt: Date.now(),
        panelTextSample: String(text || "").slice(0, 200)
      });
    }

    function getState() {
      return {
        mode,
        currentAnalyzeKey,
        displayedAnalyzeKey,
        displayedCardCount: cards.length,
        currentCardIndex,
        currentCard: currentCard(),
        cards: cards.slice(),
        panelBounds: { ...panelBounds },
        panelCollapsed,
        autoFollow
      };
    }

    updateDiagnostics();
    return {
      getState,
      resetForAnalyze,
      setCards,
      renderCurrentCard,
      setCurrentIndex,
      nextCard,
      prevCard,
      syncToPlayback,
      setAutoFollow,
      setCollapsed,
      setBounds,
      moveTo,
      resizeTo,
      showStatus
    };
  }

  function createPanel(options = {}) {
    const Card = root.LyricLens?.Card;
    const Settings = root.LyricLens?.Settings;
    const Utils = root.LyricLens?.Utils;
    let settings = Settings?.normalizeSettings(options.settings) || options.settings || {};
    let panel = null;
    const stateController = createPanelState({
      storage: root.localStorage,
      diagnostics: root.LyricLens?.diagnostics,
      viewport: () => defaultViewport(root),
      defaultBounds: defaultRect(settings.defaultPosition),
      selectCardByPlaybackTime: root.LyricLens?.Sync?.selectCardByPlaybackTime
    });
    let mode = "hidden";
    let message = "";
    let currentSongId = null;
    let currentAnalysis = null;
    let currentLineIndex = null;
    let minimized = stateController.getState().panelCollapsed;
    let settingsOpen = false;
    let settingsTab = "general";
    let rect = stateController.getState().panelBounds;
    let poppedOut = false;
    let bridgeStatus = "idle";
    let notifyScheduled = false;
    let changelogOpen = null;
    let changelogKey = "";
    let aboutScrollTop = 0;
    let aboutLastWheelDeltaY = 0;
    let aboutScrollRestoreScheduled = false;
    let feedbackDraft = { email: "", message: "", status: "", statusKind: "" };
    let promptEditorOpen = false;
    // Update channel state — set by main.js after Updater.checkForUpdate
    // runs in the background. UI uses it to badge the gear icon and to
    // populate the "关于 / 更新" settings tab.
    let updateState = {
      status: "idle",        // idle | checking | current | update-available | ahead | error
      current: "",
      latest: "",
      payload: null,         // full /latest.json body when present
      error: null,
      lastCheckedAt: 0,
      installing: false,     // true while download+write in progress
      installStage: null,    // download-start | download-done | verify-done | write-done
      installError: null,
      installedNeedsRestart: false
    };

    function mount() {
      if (panel || !root.document?.body) return;
      panel = Card.el("section", "ll-panel");
      panel.setAttribute("aria-live", "polite");
      panel.style.left = `${rect.x}px`;
      panel.style.top = `${rect.y}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      applySettingsVisuals();
      root.document.body.appendChild(panel);
      recordPanelDiagnostics();
      render();
    }

    function recordPanelDiagnostics(extraTextSample) {
      const diagnostics = root.LyricLens?.diagnostics;
      if (!diagnostics?.updateState) return;
      const mounted = Boolean(panel && root.document?.body?.contains?.(panel));
      const visible = mounted && panel.style.display !== "none";
      let llDomCount = 0;
      try {
        llDomCount = root.document?.querySelectorAll?.('[class*="ll-"]')?.length || 0;
      } catch (_) {}
      const partial = {
        panelMounted: mounted,
        panelVisible: visible,
        llDomCount,
        panelDraggable: true,
        panelResizable: true,
        panelBounds: { ...rect },
        panelCollapsed: minimized,
        autoFollow: stateController.getState().autoFollow
      };
      if (typeof extraTextSample === "string") partial.panelTextSample = extraTextSample.slice(0, 200);
      diagnostics.updateState(partial);
    }

    function destroy() {
      panel?.remove();
      panel = null;
    }

    function setSongId(songId) {
      currentSongId = songId;
    }

    function setSettings(nextSettings) {
      settings = Settings?.normalizeSettings(nextSettings) || nextSettings || settings;
      applySettingsVisuals();
      render();
    }

    // Push a fresh updater snapshot in from main.js. Re-renders so any
    // open settings panel reflects new state immediately. Background
    // detection (mode != settings) only nudges via renderBackground so
    // we don't yank a card view off-screen.
    function setUpdateState(patch) {
      if (!patch || typeof patch !== "object") return;
      updateState = { ...updateState, ...patch };
      if (settingsOpen && settingsTab === "about") render();
      else renderBackground();
    }

    function getUpdateState() {
      return { ...updateState };
    }

    function hide() {
      if (options.isDebugEnabled?.()) {
        showDebug();
        return;
      }
      mode = "hidden";
      currentAnalysis = null;
      currentLineIndex = null;
      if (panel) panel.style.display = "none";
      recordPanelDiagnostics();
    }

    function showDebug() {
      mode = "debug";
      message = "";
      settingsOpen = false;
      ensureVisible();
      render();
    }

    function showConfig(nextSettings) {
      if (nextSettings) settings = Settings?.normalizeSettings(nextSettings) || nextSettings;
      mode = "config";
      message = "请在插件设置中配置 AI 服务";
      settingsOpen = true;
      settingsTab = "ai";
      ensureVisible();
      render();
    }

    // Background-driven render: keep the DOM as-is while the user is
    // editing settings. Otherwise streaming/sync events rebuild the panel
    // many times per second, which both wipes the form's in-flight values
    // and yanks the user out of the settings view.
    function renderBackground() {
      if (settingsOpen) return;
      render();
    }

    function showLoading(nextMessage) {
      mode = "loading";
      message = nextMessage || "正在拆解歌词...";
      stateController.showStatus("loading", message, "loading");
      ensureVisible();
      renderBackground();
    }

    function showError(nextMessage) {
      mode = "error";
      message = nextMessage || "拆解失败，点击重试";
      stateController.showStatus("error", message, "error");
      ensureVisible();
      renderBackground();
    }

    function showCard(analysis, lineIndex) {
      if (!analysis?.cardsByIndex) {
        hide();
        return;
      }
      const card = analysis.cardsByIndex.get(lineIndex);
      if (!card) {
        hide();
        return;
      }
      currentAnalysis = analysis;
      currentLineIndex = lineIndex;
      const ordinal = Array.isArray(analysis.cards)
        ? Math.max(0, analysis.cards.findIndex((item) => item.index === lineIndex || item.lineIndex === lineIndex))
        : 0;
      const stateSnapshot = stateController.getState();
      if (!stateSnapshot.cards.length || stateSnapshot.displayedAnalyzeKey !== (analysis.analyzeKey || analysis.lyricsHash || null)) {
        stateController.setCards({
          analyzeKey: analysis.analyzeKey || analysis.lyricsHash || null,
          cards: analysis.cards || [],
          initialIndex: ordinal,
          reason: "show-card"
        });
      } else {
        stateController.setCurrentIndex(ordinal, "show-card");
      }
      mode = "card";
      ensureVisible();
      renderBackground();
    }

    function resetForAnalyze(payload = {}) {
      currentAnalysis = null;
      currentLineIndex = null;
      mode = "loading";
      message = payload.message || "正在分析当前歌词...";
      stateController.resetForAnalyze(payload.analyzeKey, payload.reason || "analyze-key-changed");
      ensureVisible();
      renderBackground();
    }

    function setCardsState(payload = {}) {
      currentAnalysis = payload.analysis || currentAnalysis || {
        language: payload.language,
        cards: payload.cards || []
      };
      mode = "card";
      const card = stateController.setCards(payload);
      currentLineIndex = card?.lineIndex ?? card?.index ?? null;
      ensureVisible();
      renderBackground();
    }

    function renderCardAt(index, reason = "render-card-at") {
      const card = stateController.setCurrentIndex(index, reason);
      currentLineIndex = card?.lineIndex ?? card?.index ?? null;
      mode = "card";
      ensureVisible();
      renderBackground();
    }

    function ensureVisible() {
      mount();
      if (!panel) return;
      panel.style.display = "";
      applyRect();
    }

    function applySettingsVisuals() {
      if (!panel) return;
      panel.style.setProperty("--ll-panel-opacity", String(settings.panelOpacity ?? 0.96));
      panel.dataset.theme = settings.panelTheme || "dark";
      panel.dataset.fontSize = settings.panelFontSize || "standard";
    }

    function getPanelSnapshot() {
      const controllerState = stateController.getState();
      return {
        mode,
        message,
        songId: currentSongId,
        language: currentAnalysis?.language || null,
        settings: {
          panelTheme: settings.panelTheme,
          panelFontSize: settings.panelFontSize,
          panelOpacity: settings.panelOpacity
        },
        panelState: controllerState,
        poppedOut,
        bridgeStatus,
        minimized,
        settingsOpen
      };
    }

    function notify() {
      if (notifyScheduled || typeof options.onStateChange !== "function") return;
      notifyScheduled = true;
      Promise.resolve().then(() => {
        notifyScheduled = false;
        try {
          options.onStateChange(getPanelSnapshot());
        } catch (_) {}
      });
    }

    function render() {
      if (!panel) return;
      const restoreSettingsTab = settingsOpen ? settingsTab : null;
      const restoreSettingsScrollTop = restoreSettingsTab
        ? panel.querySelector(".ll-settings-body")?.scrollTop ?? null
        : null;
      panel.innerHTML = "";
      panel.classList.toggle("ll-is-minimized", minimized && !poppedOut);
      panel.classList.toggle("ll-is-popped-out", poppedOut);
      panel.classList.toggle("ll-is-settings", settingsOpen && !poppedOut);
      panel.classList.toggle("ll-has-footer", mode === "card" && !settingsOpen && !minimized && !poppedOut);
      applySettingsVisuals();

      if (mode === "hidden") {
        panel.style.display = "none";
        notify();
        return;
      }

      if (poppedOut) {
        panel.appendChild(renderPoppedOutChip());
        const chip = panel.querySelector(".ll-poppedout");
        chip?.addEventListener("mousedown", startDrag);
        notify();
        return;
      }

      if (minimized) {
        const mini = Card.el("button", "ll-minibolt", "L");
        mini.type = "button";
        mini.title = "拖动可移动；点击恢复";
        mini.addEventListener("mousedown", startBadgeDragOrRestore);
        panel.appendChild(mini);
        notify();
        return;
      }

      panel.appendChild(renderTitlebar());
      const content = Card.el("div", "ll-content");

      if (settingsOpen) {
        content.appendChild(renderSettingsForm());
      } else if (mode === "card") {
        renderCurrentCard(content);
      } else if (mode === "loading") {
        // Loading is also click-to-retry. Normal analyze settles in 1-10s; the
        // click is a manual unstuck for the rare case where a capture arrives
        // but doesn't reach analyzeSong (a known slider-duration-path boundary
        // — Yoru can recover gracefully instead of "切下一首再切回来" on stage).
        const loadingNode = Card.renderMessage(message, "ll-empty ll-status");
        loadingNode.title = "如果一直没出来，点这里重试";
        loadingNode.tabIndex = 0;
        loadingNode.style.cursor = "pointer";
        loadingNode.addEventListener("click", () => options.onRetry?.(currentSongId));
        loadingNode.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") options.onRetry?.(currentSongId);
        });
        content.appendChild(loadingNode);
      } else if (mode === "error") {
        const errorNode = Card.renderMessage(message, "ll-empty ll-error");
        errorNode.tabIndex = 0;
        errorNode.addEventListener("click", () => options.onRetry?.(currentSongId));
        errorNode.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") options.onRetry?.(currentSongId);
        });
        content.appendChild(errorNode);
      } else if (mode === "config") {
        content.appendChild(renderSettingsForm());
      } else if (mode === "debug") {
        renderDebugPanelContent(content);
      }

      panel.appendChild(content);
      if (restoreSettingsTab && restoreSettingsTab === settingsTab && restoreSettingsScrollTop > 0) {
        const body = panel.querySelector(".ll-settings-body");
        restoreSettingsBodyScroll(body, restoreSettingsScrollTop);
      }
      if (options.isDebugEnabled?.() && mode !== "debug") panel.appendChild(renderDebugEntry());
      if (mode === "card" && !settingsOpen) panel.appendChild(renderFooter());
      ["n", "ne", "e", "se", "s", "sw", "w", "nw"].forEach((direction) => {
        const handle = Card.el("div", `ll-resize-handle ll-resize-${direction}`);
        handle.dataset.direction = direction;
        panel.appendChild(handle);
      });
      attachPointerInteractions();
      notify();
    }

    function renderPoppedOutChip() {
      const chip = Card.el("div", "ll-poppedout");
      const head = Card.el("div", "ll-poppedout-head");
      const logo = Card.el("div", "ll-logo", "L");
      head.appendChild(logo);
      const text = Card.el("div", "ll-poppedout-text");
      text.appendChild(Card.el("div", "ll-poppedout-title", "已弹出到桌面"));
      text.appendChild(Card.el("div", "ll-poppedout-status", bridgeStatusLabel()));
      head.appendChild(text);
      chip.appendChild(head);

      const back = Card.el("button", "ll-poppedout-back", "收回");
      back.type = "button";
      back.title = "把面板收回到网易云内";
      back.addEventListener("click", () => {
        options.onPopOutToggle?.(false);
      });
      chip.appendChild(back);
      return chip;
    }

    function bridgeStatusLabel() {
      switch (bridgeStatus) {
        case "connected": return "已连接桌面窗口";
        case "connecting": return "正在连接桌面窗口...";
        case "disconnected": return "桌面窗口断开，重连中...";
        case "closed": return "桌面窗口已关闭";
        default: return "等待桌面窗口...";
      }
    }

    function renderTitlebar() {
      const titlebar = Card.el("div", "ll-titlebar");
      const brand = Card.el("div", "ll-brand");
      brand.appendChild(Card.el("div", "ll-logo", "L"));
      const text = Card.el("div", "ll-brand-text");
      text.appendChild(Card.el("div", "ll-name", "LyricLens"));
      const status = Card.el("div", "ll-subtitle");
      const autoFollow = stateController.getState().autoFollow;
      status.appendChild(Card.el("span", autoFollow ? "ll-status-dot" : "ll-status-dot ll-is-manual"));
      status.appendChild(Card.el("span", "", settingsOpen ? "面板设置" : (autoFollow ? "跟随播放" : "手动浏览")));
      text.appendChild(status);
      brand.appendChild(text);
      titlebar.appendChild(brand);

      const actions = Card.el("div", "ll-actions");
      // Gear button doubles as the "you have an update" affordance.
      // The ember dot is a `::after` pseudo-element driven by a data
      // attribute on the button, so it can sit on top of the icon
      // without joining the grid layout (an actual child would push
      // the icon off-center because `.ll-icon-button` is display:grid).
      const showUpdateBadge = (updateState.status === "update-available" &&
                               (updateState.latest && updateState.latest !== settings.lastSeenLatest))
                              || updateState.installedNeedsRestart;
      const settingsBtn = iconButton("ll-settings-button", settingsOpen ? "arrow-left" : "settings", settingsOpen ? "返回" : (showUpdateBadge ? "设置（有新版本）" : "设置"), () => {
        settingsOpen = !settingsOpen;
        if (settingsOpen && showUpdateBadge) settingsTab = "about";
        render();
      });
      if (showUpdateBadge && !settingsOpen) settingsBtn.dataset.hasUpdate = "true";
      actions.appendChild(settingsBtn);
      actions.appendChild(iconButton("ll-popout-button", "external-link", "弹出到桌面", () => {
        options.onPopOutToggle?.(true);
      }));
      actions.appendChild(iconButton("ll-minimize-button", "minus", "最小化", () => {
        minimized = true;
        stateController.setCollapsed(true);
        render();
      }));
      actions.appendChild(iconButton("ll-close-button", "x", "关闭此歌曲（点击 L 徽标恢复）", () => {
        options.onCloseCurrentSong?.(currentSongId);
        // Don't call hide() — keep the L badge so the user can restore.
        // hide() leaves no visible affordance to bring LyricLens back without
        // switching songs, which reads as "the plugin broke".
        minimized = true;
        stateController.setCollapsed(true);
        render();
      }));
      titlebar.appendChild(actions);
      return titlebar;
    }

    function iconButton(className, iconName, title, handler) {
      const button = Card.el("button", `ll-icon-button ${className}`);
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.appendChild(createIcon(iconName));
      button.addEventListener("click", handler);
      return button;
    }

    function renderCurrentCard(content) {
      const card = getDisplayCard();
      if (!card) {
        content.appendChild(Card.renderMessage("当前歌词行没有学习卡片", "ll-empty"));
        recordPanelDiagnostics("");
        return;
      }
      content.appendChild(Card.renderCard(card, currentAnalysis.language));
      const sample = [card.line, card.translation].filter(Boolean).join(" / ");
      recordPanelDiagnostics(sample);
    }

    function getCards() {
      return stateController.getState().cards;
    }

    function getDisplayCard() {
      return stateController.getState().currentCard;
    }

    function getDisplayOrdinal() {
      return stateController.getState().currentCardIndex;
    }

    function renderFooter() {
      const footer = Card.el("footer", "ll-bottom");
      const cards = getCards();
      const ordinal = getDisplayOrdinal();

      const nav = Card.el("div", "ll-nav");
      const prev = Card.el("button", "ll-nav-button");
      prev.type = "button";
      prev.setAttribute("aria-label", "上一句");
      prev.appendChild(createIcon("chevron-left"));
      prev.disabled = ordinal <= 0;
      prev.addEventListener("click", () => setManualOrdinal(ordinal - 1));
      const next = Card.el("button", "ll-nav-button");
      next.type = "button";
      next.setAttribute("aria-label", "下一句");
      next.appendChild(createIcon("chevron-right"));
      next.disabled = ordinal >= cards.length - 1;
      next.addEventListener("click", () => setManualOrdinal(ordinal + 1));
      nav.appendChild(prev);
      nav.appendChild(next);
      footer.appendChild(nav);

      const progress = Card.el("div", "ll-progress");
      const labels = Card.el("div", "ll-progress-labels");
      labels.appendChild(Card.el("span", "", "歌词进度"));
      labels.appendChild(Card.el("span", "ll-counter", cards.length ? `${ordinal + 1} / ${cards.length}` : "0 / 0"));
      progress.appendChild(labels);
      const track = Card.el("div", "ll-progress-track");
      const fill = Card.el("div", "ll-progress-fill");
      fill.style.width = cards.length ? `${((ordinal + 1) / cards.length) * 100}%` : "0%";
      track.appendChild(fill);
      progress.appendChild(track);
      footer.appendChild(progress);
      const autoFollow = stateController.getState().autoFollow;
      const follow = Card.el("button", autoFollow ? "ll-follow-toggle ll-is-on" : "ll-follow-toggle", autoFollow ? "跟随中" : "恢复跟随");
      follow.type = "button";
      follow.title = "自动跟随播放";
      follow.setAttribute("aria-pressed", autoFollow ? "true" : "false");
      follow.addEventListener("click", () => {
        const next = stateController.setAutoFollow(!stateController.getState().autoFollow);
        options.onAutoFollowChanged?.(next);
        render();
      });
      footer.appendChild(follow);
      return footer;
    }

    function setManualOrdinal(ordinal) {
      const cards = getCards();
      const card = cards[ordinal] || null;
      options.onManualNavigation?.({ index: card?.index ?? ordinal, ordinal });
      renderCardAt(ordinal, "manual");
    }

    function renderSettingsForm() {
      const form = Card.el("form", "ll-settings-form");
      const tabs = Card.el("div", "ll-settings-tabs");
      tabs.setAttribute("role", "tablist");
      [["general", "常规"], ["ai", "AI 服务"], ["advanced", "高级"], ["about", "关于"]].forEach(([value, label]) => {
        const button = Card.el("button", value === settingsTab ? "ll-settings-tab ll-is-active" : "ll-settings-tab", label);
        button.type = "button";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", value === settingsTab ? "true" : "false");
        button.addEventListener("click", () => {
          settingsTab = value;
          render();
        });
        tabs.appendChild(button);
      });
      form.appendChild(tabs);

      const body = Card.el("div", "ll-settings-body");
      if (settingsTab === "ai") renderAiSettings(body);
      else if (settingsTab === "advanced") renderAdvancedSettings(body);
      else if (settingsTab === "about") renderAboutSettings(body);
      else renderGeneralSettings(body);
      form.appendChild(body);

      const actions = Card.el("div", "ll-settings-actions");
      actions.appendChild(Card.el("span", "ll-save-status", "更改尚未保存"));
      const save = Card.el("button", "ll-primary-button", "保存设置");
      save.type = "submit";
      actions.appendChild(save);
      form.appendChild(actions);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        settings = await options.onSettingsSave?.({ ...settings }) || settings;
        applySettingsVisuals();
        settingsOpen = false;
        render();
      });
      return form;
    }

    function renderGeneralSettings(body) {
      const playback = settingsSection("播放与分析");
      playback.appendChild(settingRow("自动分析新歌曲", "捕获到可信歌词后自动生成卡片", switchControl("autoAnalyze", settings.autoAnalyze)));
      body.appendChild(playback);

      const appearance = settingsSection("面板显示");
      appearance.appendChild(settingRow("外观主题", "深色与浅色使用独立对比度", segmentedControl("panelTheme", [["dark", "深色"], ["light", "浅色"]], settings.panelTheme)));
      appearance.appendChild(settingRow("字体大小", "只调整文字，不改变面板尺寸", segmentedControl("panelFontSize", [["compact", "紧凑"], ["standard", "标准"], ["large", "较大"]], settings.panelFontSize, "ll-font-size-control")));
      appearance.appendChild(settingRow("面板透明度", "显示设置不会重新分析歌曲", opacityControl()));
      appearance.appendChild(selectSetting("默认位置", "defaultPosition", [["topLeft", "左上"], ["topRight", "右上"], ["bottomLeft", "左下"], ["bottomRight", "右下"]], "下次打开面板时使用"));
      body.appendChild(appearance);
    }

    function renderAiSettings(body) {
      const section = settingsSection("OpenAI 兼容服务");
      section.appendChild(inputSetting("API Endpoint", "apiEndpoint", "text"));
      section.appendChild(inputSetting("API Key", "apiKey", "password"));
      section.appendChild(inputSetting("模型", "modelName", "text"));
      const testStatus = Card.el("div", "ll-test-status", "配置完整，尚未测试");
      const testRow = Card.el("div", "ll-connection-row");
      testRow.appendChild(testStatus);
      const testButton = Card.el("button", "ll-secondary-button", "测试连接");
      testButton.type = "button";
      testButton.addEventListener("click", () => testConnection(testButton, testStatus));
      testRow.appendChild(testButton);
      section.appendChild(testRow);
      section.appendChild(Card.el("div", "ll-settings-note", "API Key 仅保存到本地配置，不上传到插件作者服务器。"));
      body.appendChild(section);

      renderLearningSettings(body);
    }

    function renderLearningSettings(body) {
      const learning = settingsSection("学习偏好");
      learning.appendChild(targetLanguageSetting());
      learning.appendChild(knowledgePointsControl());
      body.appendChild(learning);

      const prompt = settingsSection("自定义 Prompt");
      prompt.appendChild(customPromptControl());
      body.appendChild(prompt);
    }

    function renderAdvancedSettings(body) {
      const request = settingsSection("分析请求");
      request.appendChild(selectSetting("卡片生成模式", "cardGenerationMode", [["per-line", "逐句"], ["selected", "精选"]]));
      const grid = Card.el("div", "ll-settings-grid");
      grid.appendChild(numberSetting("超时（秒）", "analyzeTimeoutMs", 1000));
      grid.appendChild(numberSetting("最大歌词行数", "maxAnalysisLines"));
      grid.appendChild(numberSetting("最大 Tokens", "analyzeMaxTokens"));
      grid.appendChild(numberSetting("Temperature", "analyzeTemperature"));
      request.appendChild(grid);
      body.appendChild(request);

      const compatibility = settingsSection("模型兼容");
      compatibility.appendChild(selectSetting("Thinking", "modelThinkingMode", [["off", "关闭"], ["auto", "自动"], ["high", "High"], ["max", "Max"]]));
      compatibility.appendChild(selectSetting("Response Format", "responseFormatMode", [["auto", "自动"], ["json_object", "JSON Object"], ["off", "关闭"]]));
      compatibility.appendChild(settingRow("超时后自动重试", "使用较小批次继续生成", switchControl("fallbackOnTimeout", settings.fallbackOnTimeout)));
      const fallbackGrid = Card.el("div", "ll-settings-grid");
      fallbackGrid.appendChild(numberSetting("重试超时（秒）", "fallbackTimeoutMs", 1000));
      fallbackGrid.appendChild(numberSetting("重试行数", "fallbackMaxLines"));
      fallbackGrid.appendChild(numberSetting("重试 Tokens", "fallbackMaxTokens"));
      compatibility.appendChild(fallbackGrid);
      body.appendChild(compatibility);

      const companion = settingsSection("桌面悬浮窗");
      companion.appendChild(companionPathField());
      body.appendChild(companion);
    }

    function renderAboutSettings(body) {
      const meta = settingsSection("关于");
      const metaList = Card.el("div", "ll-about-meta");
      metaList.appendChild(aboutMetaRow("当前版本", `v${updateState.current || readPluginVersionLocal()}`));
      metaList.appendChild(aboutMetaRow("更新源", "lyriclens.yoru-and-akari.dev"));
      metaList.appendChild(aboutMetaRow("GitHub", "yoruuuchan/LyricLens"));
      meta.appendChild(metaList);
      body.appendChild(meta);

      const feedback = settingsSection("开发者意见反馈");
      feedback.appendChild(renderFeedbackCard());
      body.appendChild(feedback);

      const updates = settingsSection("更新");
      const card = Card.el("div", "ll-update-card");
      card.appendChild(renderUpdateStatusBlock());
      card.appendChild(renderUpdateActions());
      updates.appendChild(card);

      const cl = renderChangelogBlock();
      if (cl) updates.appendChild(cl);

      updates.appendChild(settingRow(
        "启动时自动检查更新",
        "仅获取版本号，不会下载或安装",
        switchControl("autoCheckUpdate", settings.autoCheckUpdate)
      ));
      body.appendChild(updates);
      attachAboutScrollGuard(body);
    }

    function renderFeedbackCard() {
      const card = Card.el("div", "ll-feedback-card");
      const copy = Card.el("div", "ll-feedback-copy");
      copy.appendChild(Card.el("div", "ll-feedback-title", "遇到问题或有建议，可以直接写给开发者"));
      copy.appendChild(Card.el("div", "ll-feedback-sub", "邮件由 LyricLens 服务端转发，不会在插件里暴露收件地址。"));

      const email = Card.el("input", "ll-input ll-feedback-input");
      email.type = "email";
      email.placeholder = "你的邮箱（用于回复）";
      email.autocomplete = "email";
      email.required = true;
      email.value = feedbackDraft.email;
      email.addEventListener("input", () => {
        feedbackDraft = { ...feedbackDraft, email: email.value, status: "", statusKind: "" };
      });
      copy.appendChild(email);

      const FEEDBACK_MAX = 10000;
      const message = Card.el("textarea", "ll-input ll-feedback-message");
      message.placeholder = "反馈内容";
      message.required = true;
      message.maxLength = FEEDBACK_MAX;
      message.rows = 4;
      message.value = feedbackDraft.message;
      const counter = Card.el("div", "ll-feedback-counter");
      const updateCounter = () => {
        const used = message.value.length;
        counter.textContent = `${used} / ${FEEDBACK_MAX}`;
        counter.classList.toggle("ll-is-warn", used >= FEEDBACK_MAX * 0.8);
      };
      message.addEventListener("input", () => {
        feedbackDraft = { ...feedbackDraft, message: message.value, status: "", statusKind: "" };
        updateCounter();
      });
      copy.appendChild(message);
      updateCounter();
      copy.appendChild(counter);

      const trap = Card.el("input", "ll-feedback-trap");
      trap.type = "text";
      trap.tabIndex = -1;
      trap.autocomplete = "off";
      copy.appendChild(trap);

      const statusClass = feedbackDraft.statusKind ? `ll-feedback-status ll-feedback-status-${feedbackDraft.statusKind}` : "ll-feedback-status";
      const status = Card.el("div", statusClass, feedbackDraft.status);
      copy.appendChild(status);
      card.appendChild(copy);

      const action = Card.el("button", "ll-secondary-button", "发送反馈");
      action.type = "button";
      action.addEventListener("click", () => submitFeedback({ email, message, trap, status, action }));
      card.appendChild(action);
      return card;
    }

    async function submitFeedback(nodes) {
      const text = String(nodes.message.value || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(nodes.email.value || "").trim())) {
        feedbackDraft = { ...feedbackDraft, email: nodes.email.value, message: nodes.message.value, status: "请填写有效邮箱，方便回复。", statusKind: "fail" };
        nodes.status.className = "ll-feedback-status ll-feedback-status-fail";
        nodes.status.textContent = feedbackDraft.status;
        return;
      }
      if (text.length < 5) {
        feedbackDraft = { ...feedbackDraft, email: nodes.email.value, message: nodes.message.value, status: "请至少写 5 个字。", statusKind: "fail" };
        nodes.status.className = "ll-feedback-status ll-feedback-status-fail";
        nodes.status.textContent = feedbackDraft.status;
        return;
      }
      feedbackDraft = { ...feedbackDraft, email: nodes.email.value, message: nodes.message.value, status: "", statusKind: "" };
      nodes.action.disabled = true;
      nodes.action.textContent = "发送中...";
      nodes.status.className = "ll-feedback-status";
      nodes.status.textContent = "";
      const version = updateState.current || readPluginVersionLocal();
      try {
        const resp = await root.fetch(FEEDBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(nodes.email.value || "").trim(),
            message: text,
            _trap: String(nodes.trap.value || ""),
            meta: {
              version,
              ncmVersion: readRuntimeVersion(root.betterncm?.ncm, "getNCMVersion"),
              betterNcmVersion: readRuntimeVersion(root.betterncm?.app, "getBetterNCMVersion"),
              theme: settings.panelTheme,
              fontSize: settings.panelFontSize
            }
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        feedbackDraft = { email: nodes.email.value, message: "", status: "已发送，谢谢。", statusKind: "ok" };
        nodes.message.value = "";
        nodes.trap.value = "";
        nodes.status.className = "ll-feedback-status ll-feedback-status-ok";
        nodes.status.textContent = feedbackDraft.status;
      } catch (err) {
        feedbackDraft = { ...feedbackDraft, email: nodes.email.value, message: nodes.message.value, status: "发送失败，请稍后再试。", statusKind: "fail" };
        nodes.status.className = "ll-feedback-status ll-feedback-status-fail";
        nodes.status.textContent = feedbackDraft.status;
        Utils?.warn?.("feedback submit failed", err);
      } finally {
        nodes.action.disabled = false;
        nodes.action.textContent = "发送反馈";
      }
    }

    function readRuntimeVersion(owner, methodName) {
      try {
        const reader = owner?.[methodName];
        if (typeof reader !== "function") return "unknown";
        const value = reader.call(owner);
        return value == null ? "unknown" : String(value);
      } catch (_) {
        return "unknown";
      }
    }

    function attachAboutScrollGuard(body) {
      aboutScrollTop = body.scrollTop || 0;
      body.addEventListener("wheel", (event) => {
        aboutLastWheelDeltaY = event.deltaY || 0;
      }, { passive: true, capture: true });
      body.addEventListener("mousedown", () => {
        aboutLastWheelDeltaY = 0;
      });
      body.addEventListener("scroll", () => {
        const current = body.scrollTop;
        const previous = aboutScrollTop;
        const jumpedToTopWhileScrollingDown = current === 0 && previous > 8 && aboutLastWheelDeltaY > 0;
        if (jumpedToTopWhileScrollingDown && !aboutScrollRestoreScheduled) {
          aboutScrollRestoreScheduled = true;
          requestAnimationFrame(() => {
            aboutScrollRestoreScheduled = false;
            if (body.isConnected && body.scrollTop === 0) body.scrollTop = previous;
            aboutScrollTop = body.scrollTop;
          });
          return;
        }
        aboutScrollTop = current;
      }, { passive: true });
    }

    function aboutMetaRow(label, value) {
      const row = Card.el("div", "ll-about-meta-row");
      row.appendChild(Card.el("span", "ll-about-meta-label", label));
      row.appendChild(Card.el("span", "ll-about-meta-value", value));
      return row;
    }

    function readPluginVersionLocal() {
      try {
        return root.LyricLens?.Updater?.readPluginVersion?.() || "0.0.0";
      } catch (_) { return "0.0.0"; }
    }

    function renderUpdateStatusBlock() {
      const block = Card.el("div", "ll-update-status");
      const cls = updateStatusClass(updateState.status);
      const dot = Card.el("span", `ll-update-dot ${cls}`);
      block.appendChild(dot);
      const text = Card.el("div", "ll-update-status-text");
      const title = Card.el("div", "ll-update-status-title", updateStatusTitle());
      text.appendChild(title);
      const sub = updateStatusSubtitle();
      if (sub) text.appendChild(Card.el("div", "ll-update-status-sub", sub));
      block.appendChild(text);
      return block;
    }

    function updateStatusClass(s) {
      if (s === "update-available") return "ll-update-dot-pending";
      if (s === "error") return "ll-update-dot-error";
      if (s === "checking") return "ll-update-dot-checking";
      if (s === "current" || s === "ahead") return "ll-update-dot-ok";
      return "";
    }

    function updateStatusTitle() {
      if (updateState.installedNeedsRestart) return "已安装，重启网易云生效";
      if (updateState.installing) return installStageLabel(updateState.installStage) || "正在更新...";
      if (updateState.installError) return "安装失败";
      switch (updateState.status) {
        case "checking": return "正在检查更新...";
        case "update-available": return `发现新版本 v${updateState.latest}`;
        case "current": return "已是最新版本";
        case "ahead": return `你的版本 v${updateState.current} 比线上更新`;
        case "error": return "无法检查更新";
        default: return "尚未检查更新";
      }
    }

    function updateStatusSubtitle() {
      if (updateState.installError) return String(updateState.installError);
      if (updateState.installing) return null;
      if (updateState.installedNeedsRestart) return "点击下方按钮立即重启 NCM，或稍后手动重启";
      switch (updateState.status) {
        case "update-available":
          return `当前 v${updateState.current} → 最新 v${updateState.latest}`;
        case "current":
          return `v${updateState.current} · 已是最新`;
        case "ahead":
          return `线上是 v${updateState.latest}（你可能在内测分支上）`;
        case "error":
          return String(updateState.error || "网络问题或更新服务暂不可用");
        case "idle":
          return "点击下方按钮立即检查";
        default: return null;
      }
    }

    function installStageLabel(stage) {
      if (!stage) return "正在更新...";
      const map = {
        "download-start": "正在下载...",
        "download-done": "下载完成，校验中...",
        "verify-done": "校验通过，写入中...",
        "write-done": "写入完成"
      };
      return map[stage] || "正在更新...";
    }

    function renderUpdateActions() {
      const row = Card.el("div", "ll-update-actions");
      const hasUpdate = updateState.status === "update-available";

      if (updateState.installedNeedsRestart) {
        const restart = Card.el("button", "ll-primary-button", "立即重启网易云");
        restart.type = "button";
        restart.addEventListener("click", () => {
          options.onRequestRestart?.();
        });
        row.appendChild(restart);
        const later = Card.el("button", "ll-secondary-button", "稍后手动重启");
        later.type = "button";
        later.addEventListener("click", () => {
          setUpdateState({ installedNeedsRestart: false });
        });
        row.appendChild(later);
        return row;
      }

      if (updateState.installing) {
        const busy = Card.el("button", "ll-primary-button", installStageLabel(updateState.installStage));
        busy.type = "button";
        busy.disabled = true;
        row.appendChild(busy);
        return row;
      }

      if (hasUpdate) {
        const installBtn = Card.el("button", "ll-primary-button", `更新到 v${updateState.latest}`);
        installBtn.type = "button";
        installBtn.addEventListener("click", () => {
          options.onInstallUpdate?.(updateState.payload);
        });
        row.appendChild(installBtn);
      }

      const checkBtn = Card.el("button", "ll-secondary-button",
        updateState.status === "checking" ? "检查中..." : "重新检查");
      checkBtn.type = "button";
      checkBtn.disabled = updateState.status === "checking";
      checkBtn.addEventListener("click", () => {
        options.onCheckUpdate?.();
      });
      row.appendChild(checkBtn);

      if (hasUpdate) {
        const skip = Card.el("button", "ll-ghost-button", "跳过此版本");
        skip.type = "button";
        skip.addEventListener("click", async () => {
          settings = await options.onSettingsSave?.({ lastSeenLatest: updateState.latest }) || settings;
          render();
        });
        row.appendChild(skip);
      }

      return row;
    }

    function renderChangelogBlock() {
      const changelog = updateState.payload?.changelog;
      if (!changelog) return null;
      const nextKey = `${updateState.payload?.tag || ""}:${updateState.latest || ""}`;
      if (nextKey !== changelogKey) {
        changelogKey = nextKey;
        changelogOpen = updateState.status === "update-available";
      }
      const isOpen = changelogOpen ?? (updateState.status === "update-available");
      const wrap = Card.el("div", isOpen ? "ll-changelog ll-is-open" : "ll-changelog");
      const summary = Card.el("button", "ll-changelog-summary",
        updateState.payload?.tag ? `更新日志 · ${updateState.payload.tag}` : "更新日志");
      summary.type = "button";
      summary.setAttribute("aria-expanded", String(isOpen));
      wrap.appendChild(summary);
      const body = Card.el("div", "ll-changelog-body");
      body.hidden = !isOpen;
      const md = String(changelog).slice(0, 8000);
      const renderer = root.LyricLens?.Updater?.renderMarkdown;
      if (typeof renderer === "function") {
        // renderMarkdown HTML-escapes every user-controlled token before
        // wrapping it in tags, so innerHTML is safe here.
        body.innerHTML = renderer(md);
      } else {
        body.textContent = md;
      }
      wrap.appendChild(body);
      summary.addEventListener("click", () => {
        const scroller = wrap.closest(".ll-settings-body");
        const beforeScrollTop = scroller ? scroller.scrollTop : 0;
        changelogOpen = !changelogOpen;
        wrap.classList.toggle("ll-is-open", changelogOpen);
        summary.setAttribute("aria-expanded", String(changelogOpen));
        body.hidden = !changelogOpen;
        summary.blur?.();
        if (scroller && beforeScrollTop > 0) {
          requestAnimationFrame(() => {
            if (scroller.scrollTop === 0) scroller.scrollTop = beforeScrollTop;
          });
        }
      });
      return wrap;
    }

    function companionPathField() {
      const field = Card.el("label", "ll-field");
      field.appendChild(Card.el("span", "ll-field-label", "Companion 程序路径"));

      const row = Card.el("div", "ll-companion-path-row");
      const input = Card.el("input", "ll-input");
      input.type = "text";
      input.name = "companionExePath";
      input.value = settings.companionExePath ?? "";
      input.placeholder = "留空则需手动启动 companion";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        settings = { ...settings, companionExePath: input.value };
      });
      row.appendChild(input);

      const browse = Card.el("button", "ll-secondary-button ll-companion-browse", "选择...");
      browse.type = "button";
      browse.addEventListener("click", async () => {
        const picked = await pickCompanionExe();
        if (!picked) return;
        settings = { ...settings, companionExePath: picked };
        input.value = picked;
      });
      row.appendChild(browse);
      field.appendChild(row);

      field.appendChild(Card.el(
        "span",
        "ll-field-help",
        "填写 lyriclens-companion.exe 的完整路径。点击「弹出到桌面」时会自动启动 companion；留空则需要自己运行 companion。"
      ));
      return field;
    }

    async function pickCompanionExe() {
      const dialog = root.betterncm?.app?.openFileDialog;
      if (typeof dialog !== "function") return null;
      try {
        const result = await dialog("可执行文件|*.exe", "");
        if (!result) return null;
        if (typeof result === "string") return result.trim() || null;
        if (typeof result === "object" && typeof result.path === "string") {
          return result.path.trim() || null;
        }
        return null;
      } catch (err) {
        console.warn("[LyricLens]", "openFileDialog 失败", err);
        return null;
      }
    }

    function renderDebugEntry(open = false) {
      const state = options.getDiagnosticState?.() || {};
      const details = Card.el("details", "ll-debug-entry");
      details.open = open;
      const summary = Card.el("summary", "ll-debug-summary", "诊断");
      details.appendChild(summary);
      const rows = [
        ["LyricLens loaded", state.loaded === false ? "no" : "yes"],
        ["songId", state.songId],
        ["PlayState 最近参数", formatDebugValue(state.lastPlayStateArgs)],
        ["playback status", state.playbackStatus],
        ["playState status", state.playStateStatus],
        ["language", state.language],
        ["lyrics source", state.lyricsSource || "none"],
        ["lyricLineCount", state.lyricLineCount],
        ["sampleText", state.lastLyricsSummary?.sampleText],
        ["getPlaying 状态", state.getPlayingStatus],
        ["getPlayingSong 状态", state.getPlayingSongStatus],
        ["cardCount", state.cardCount],
        ["cardGenerationMode", state.cardGenerationMode],
        ["expectedCardCount", state.expectedCardCount],
        ["actualCardCount", state.actualCardCount],
        ["missingCardLineIndexes", formatDebugValue(state.missingCardLineIndexes)],
        ["analyzeBatchCount", state.analyzeBatchCount],
        ["analyzeBatchIndex", state.analyzeBatchIndex],
        ["analyzeBatchSize", state.analyzeBatchSize],
        ["analyzeMergedCardCount", state.analyzeMergedCardCount],
        ["partialCardGeneration", state.partialCardGeneration],
        ["currentCardIndex", state.currentCardIndex],
        ["displayedAnalyzeKey", state.displayedAnalyzeKey],
        ["displayedCardCount", state.displayedCardCount],
        ["currentCardLineIndex", state.currentCardLineIndex],
        ["currentCardStartMs", state.currentCardStartMs],
        ["currentCardEndMs", state.currentCardEndMs],
        ["currentCardOriginal", state.currentCardOriginal],
        ["previousCardLineIndex", state.previousCardLineIndex],
        ["previousCardOriginal", state.previousCardOriginal],
        ["previousCardStartMs", state.previousCardStartMs],
        ["nextCardLineIndex", state.nextCardLineIndex],
        ["nextCardOriginal", state.nextCardOriginal],
        ["nextCardStartMs", state.nextCardStartMs],
        ["panelLastRenderReason", state.panelLastRenderReason],
        ["panelLastRenderedAt", state.panelLastRenderedAt],
        ["lastSongChangeAt", state.lastSongChangeAt],
        ["lastPanelResetReason", state.lastPanelResetReason],
        ["staleCardsCleared", state.staleCardsCleared],
        ["playbackSyncEnabled", state.playbackSyncEnabled],
        ["playbackSyncStatus", state.playbackSyncStatus],
        ["playbackCurrentMs", state.playbackCurrentMs],
        ["playbackEstimatedMs", state.playbackEstimatedMs],
        ["playProgressEventCount", state.playProgressEventCount],
        ["playProgressAcceptedMs", state.playProgressAcceptedMs],
        ["playProgressRejectedReason", state.playProgressRejectedReason],
        ["lastPlayProgressArgs", formatDebugValue(state.lastPlayProgressArgs)],
        ["timeSourceCandidates", formatDebugValue(state.timeSourceCandidates)],
        ["timeSourceFailureReason", state.timeSourceFailureReason],
        ["playbackTimerActive", state.playbackTimerActive],
        ["lastPlaybackSyncAt", state.lastPlaybackSyncAt],
        ["panelDraggable", state.panelDraggable],
        ["panelResizable", state.panelResizable],
        ["panelBounds", formatDebugValue(state.panelBounds)],
        ["panelCollapsed", state.panelCollapsed],
        ["autoFollow", state.autoFollow],
        ["api status", state.apiStatus],
        ["last error", state.lastError],
        ["cacheHit", state.cacheHit],
        ["cacheKey", state.cacheKey],
        ["cacheUseStatus", state.cacheUseStatus],
        ["lastAnalyzeTrigger", state.lastAnalyzeTrigger],
        ["lastAnalyzeKey", state.lastAnalyzeKey],
        ["analysisSkippedReason", state.analysisSkippedReason],
        ["inFlightAnalyzeKey", state.inFlightAnalyzeKey],
        ["lastCaptureSource", state.lastCaptureSource],
        ["lastCapturedAt", state.lastCapturedAt],
        ["lastRequestUrl", state.lastRequestUrl],
        ["analyzeTimeoutMs", state.analyzeTimeoutMs],
        ["lastRequestStartedAt", state.lastRequestStartedAt],
        ["lastRequestEndedAt", state.lastRequestEndedAt],
        ["lastRequestDurationMs", state.lastRequestDurationMs],
        ["timeoutStage", state.timeoutStage],
        ["rawLyricLineCount", state.rawLyricLineCount],
        ["sentLyricLineCount", state.sentLyricLineCount],
        ["droppedLyricLineCount", state.droppedLyricLineCount],
        ["requestBodySize", state.requestBodySize],
        ["promptCharCount", state.promptCharCount],
        ["lastRequestModel", state.lastRequestModel],
        ["lastRequestMaxTokens", state.lastRequestMaxTokens],
        ["lastRequestTemperature", state.lastRequestTemperature],
        ["fallbackReason", state.fallbackReason],
        ["fallbackOutcome", state.fallbackOutcome],
        ["panelStatus", state.panelStatus],
        ["lastSettledAnalyzeKey", state.lastSettledAnalyzeKey],
        ["lastSettledAnalyzeStatus", state.lastSettledAnalyzeStatus],
        ["lastSettledAt", state.lastSettledAt],
        ["lastDuplicateCaptureKey", state.lastDuplicateCaptureKey],
        ["lastDuplicateCaptureAt", state.lastDuplicateCaptureAt],
        ["abortedAnalyzeKey", state.abortedAnalyzeKey],
        ["abortReason", state.abortReason],
        ["rawAnalyzeKey", state.rawAnalyzeKey],
        ["canonicalAnalyzeKey", state.canonicalAnalyzeKey],
        ["analyzeKeyAliasFrom", state.analyzeKeyAliasFrom],
        ["analyzeKeyAliasTo", state.analyzeKeyAliasTo],
        ["keyAliasReason", state.keyAliasReason],
        ["promotionReason", state.promotionReason],
        ["lastKeyAliasAt", state.lastKeyAliasAt],
        ["modelThinkingMode", state.modelThinkingMode],
        ["reasoningEffort", state.reasoningEffort],
        ["responsePromptTokens", state.responsePromptTokens],
        ["responseCompletionTokens", state.responseCompletionTokens],
        ["responseReasoningTokens", state.responseReasoningTokens],
        ["responseTotalTokens", state.responseTotalTokens],
        ["finishReason", state.finishReason],
        ["speedTestStatus", state.speedTestStatus],
        ["speedTestDurationMs", state.speedTestDurationMs],
        ["responseFormatMode", state.responseFormatMode],
        ["responseFormatUnsupported", state.responseFormatUnsupported],
        ["extractedJsonStrategy", state.extractedJsonStrategy],
        ["finishReasonWasLength", state.finishReasonWasLength],
        ["forceRefreshReason", state.forceRefreshReason],
        ["loadingWatchdogTriggered", state.loadingWatchdogTriggered],
        ["panelLoadingStartedAt", state.panelLoadingStartedAt],
        ["lastResponseStatus", state.lastResponseStatus],
        ["lastParsedCardsCount", state.lastParsedCardsCount],
        ["lastNormalizedCardsCount", state.lastNormalizedCardsCount],
        ["cardDropReasons", formatDebugValue(state.cardDropReasons)],
        ["lastResponseTextSample", state.lastResponseTextSample],
        ["lastParsedContentSample", state.lastParsedContentSample],
        ["panelMounted", state.panelMounted],
        ["panelVisible", state.panelVisible],
        ["panelTextSample", state.panelTextSample],
        ["llDomCount", state.llDomCount],
        ["css status", formatCssStatus(state.cssStatus)]
      ];
      rows.forEach(([label, value]) => {
        const row = Card.el("div", "ll-debug-row");
        row.appendChild(Card.el("span", "ll-debug-label", label));
        row.appendChild(Card.el("code", "ll-debug-value", formatDebugCell(value)));
        details.appendChild(row);
      });
      return details;
    }

    function renderDebugPanelContent(content) {
      const state = options.getDiagnosticState?.() || {};
      if ((state.lyricsSource || "none") === "none") {
        content.appendChild(Card.renderMessage("未获取到歌词", "ll-empty ll-status"));
      }
      content.appendChild(renderDebugEntry(true));
    }

    function formatCssStatus(status) {
      if (!status) return "";
      if (typeof status === "string") return status;
      return [status.status, status.href].filter(Boolean).join(" ");
    }

    function formatDebugValue(value) {
      if (value == null) return "";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }
    }

    function formatDebugCell(value) {
      if (value === null || value === undefined || value === "") return "-";
      return String(value);
    }

    function getKnowledgePointIds() {
      return Settings?.VALID_KNOWLEDGE_POINTS || Object.keys(KNOWLEDGE_POINT_LABELS);
    }

    function selectedKnowledgePoints() {
      const current = Array.isArray(settings.knowledgePoints) ? settings.knowledgePoints : [];
      return current.filter((value) => getKnowledgePointIds().includes(value));
    }

    function buildPromptFocus() {
      const builder = root.LyricLens?.Api?.buildDefaultFocus;
      if (typeof builder !== "function") return "";
      return builder(
        settings.targetLanguage || "中文",
        selectedKnowledgePoints(),
        settings.cardGenerationMode === "selected"
      );
    }

    function promptTextareaValue() {
      const customPrompt = String(settings.customPrompt || "");
      return customPrompt.trim() ? customPrompt : buildPromptFocus();
    }

    function regenerateCustomPrompt(textarea) {
      const generated = buildPromptFocus();
      settings = { ...settings, customPrompt: generated };
      if (textarea) textarea.value = generated;
      return generated;
    }

    function withStableSettingsScroll(change) {
      const body = panel?.querySelector?.(".ll-settings-body");
      const scrollTop = body ? body.scrollTop : 0;
      change?.();
      restoreSettingsBodyScroll(body, scrollTop);
    }

    function restoreSettingsBodyScroll(body, scrollTop) {
      if (!body || !Number.isFinite(Number(scrollTop))) return;
      const restore = () => {
        if (body.isConnected === false) return;
        if (body.scrollTop !== scrollTop) body.scrollTop = scrollTop;
      };
      restore();
      Promise.resolve().then(restore);
      if (typeof root.requestAnimationFrame === "function") {
        root.requestAnimationFrame(() => {
          restore();
          root.requestAnimationFrame(restore);
        });
      }
      if (typeof root.setTimeout === "function") root.setTimeout(restore, 0);
    }

    function settingsSection(title) {
      const section = Card.el("section", "ll-settings-section");
      section.appendChild(Card.el("h2", "ll-settings-title", title));
      return section;
    }

    function settingRow(title, description, control) {
      const row = Card.el("div", "ll-setting-row");
      const copy = Card.el("div", "ll-setting-copy");
      copy.appendChild(Card.el("strong", "", title));
      if (description) copy.appendChild(Card.el("span", "", description));
      row.appendChild(copy);
      row.appendChild(control);
      return row;
    }

    function segmentedControl(name, values, currentValue, extraClass = "") {
      const control = Card.el("div", ["ll-segmented", extraClass].filter(Boolean).join(" "));
      values.forEach(([value, label]) => {
        const button = Card.el("button", value === currentValue ? "ll-segment ll-is-active" : "ll-segment", label);
        button.type = "button";
        button.setAttribute("aria-pressed", value === currentValue ? "true" : "false");
        button.addEventListener("click", () => {
          settings = { ...settings, [name]: value };
          applySettingsVisuals();
          render();
        });
        control.appendChild(button);
      });
      return control;
    }

    function switchControl(name, checked) {
      const button = Card.el("button", checked !== false ? "ll-switch ll-is-on" : "ll-switch");
      button.type = "button";
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", checked !== false ? "true" : "false");
      button.appendChild(Card.el("span", "ll-switch-knob"));
      button.addEventListener("click", () => {
        settings = { ...settings, [name]: !(settings[name] !== false) };
        render();
      });
      return button;
    }

    function opacityControl() {
      const wrapper = Card.el("div", "ll-range-wrap");
      const input = Card.el("input", "ll-range");
      input.type = "range";
      input.min = "0.5";
      input.max = "1";
      input.step = "0.01";
      input.value = String(settings.panelOpacity ?? 0.96);
      const value = Card.el("span", "ll-range-value", `${Math.round(Number(input.value) * 100)}%`);
      input.addEventListener("input", () => {
        settings = { ...settings, panelOpacity: Number(input.value) };
        value.textContent = `${Math.round(Number(input.value) * 100)}%`;
        applySettingsVisuals();
      });
      wrapper.appendChild(input);
      wrapper.appendChild(value);
      return wrapper;
    }

    function inputSetting(labelText, name, type) {
      const label = Card.el("label", "ll-field");
      label.appendChild(Card.el("span", "ll-field-label", labelText));
      const input = Card.el("input", "ll-input");
      input.name = name;
      input.type = type;
      input.value = settings[name] ?? "";
      input.autocomplete = type === "password" ? "off" : "on";
      input.addEventListener("input", () => {
        settings = { ...settings, [name]: input.value };
      });
      label.appendChild(input);
      return label;
    }

    function targetLanguageSetting() {
      const label = Card.el("label", "ll-field");
      label.appendChild(Card.el("span", "ll-field-label", "目标语言"));
      const input = Card.el("input", "ll-input ll-target-language-input");
      input.name = "targetLanguage";
      input.type = "text";
      input.value = settings.targetLanguage || "中文";
      input.autocomplete = "on";
      input.addEventListener("input", () => {
        settings = { ...settings, targetLanguage: input.value };
        const textarea = panel?.querySelector?.(".ll-prompt-textarea");
        regenerateCustomPrompt(textarea);
      });
      label.appendChild(input);
      label.appendChild(Card.el("span", "ll-field-help", "学习卡片里的翻译和讲解会优先使用这个语言。"));
      return label;
    }

    function knowledgePointsControl() {
      const wrapper = Card.el("div", "ll-knowledge-group");
      wrapper.appendChild(Card.el("div", "ll-field-label", "知识点"));
      const grid = Card.el("div", "ll-knowledge-grid");
      const selected = new Set(selectedKnowledgePoints());
      getKnowledgePointIds().forEach((id) => {
        const label = Card.el("label", "ll-knowledge-option");
        const checkbox = Card.el("input", "ll-knowledge-checkbox");
        checkbox.type = "checkbox";
        checkbox.value = id;
        checkbox.checked = selected.has(id);
        checkbox.addEventListener("change", () => {
          const next = new Set(selectedKnowledgePoints());
          if (checkbox.checked) next.add(id);
          else if (next.size > 1) next.delete(id);
          else checkbox.checked = true;
          settings = { ...settings, knowledgePoints: getKnowledgePointIds().filter((value) => next.has(value)) };
          const textarea = panel?.querySelector?.(".ll-prompt-textarea");
          regenerateCustomPrompt(textarea);
        });
        label.appendChild(checkbox);
        label.appendChild(Card.el("span", "ll-knowledge-label", KNOWLEDGE_POINT_LABELS[id] || id));
        grid.appendChild(label);
      });
      wrapper.appendChild(grid);
      wrapper.appendChild(Card.el("span", "ll-field-help", "勾选后会自动重写下方 Prompt 中间层。"));
      return wrapper;
    }

    function customPromptControl() {
      const wrapper = Card.el("div", promptEditorOpen ? "ll-prompt-details ll-is-open" : "ll-prompt-details");
      const toggle = Card.el("button", "ll-prompt-summary", "高级：编辑 Prompt 中间层");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(promptEditorOpen));
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        withStableSettingsScroll(() => {
          promptEditorOpen = !promptEditorOpen;
          wrapper.classList.toggle("ll-is-open", promptEditorOpen);
          toggle.setAttribute("aria-expanded", String(promptEditorOpen));
          content.hidden = !promptEditorOpen;
        });
        toggle.blur?.();
      });
      wrapper.appendChild(toggle);

      const content = Card.el("div", "ll-prompt-content");
      content.hidden = !promptEditorOpen;
      content.appendChild(Card.el("div", "ll-settings-note", "头部（JSON 格式要求）和尾部（输出限制）由系统自动添加，不可编辑。"));

      const textarea = Card.el("textarea", "ll-input ll-prompt-textarea");
      textarea.name = "customPrompt";
      textarea.value = promptTextareaValue();
      textarea.spellcheck = false;
      textarea.addEventListener("input", () => {
        settings = { ...settings, customPrompt: textarea.value };
      });
      content.appendChild(textarea);

      const row = Card.el("div", "ll-prompt-actions");
      const restore = Card.el("button", "ll-secondary-button ll-prompt-restore", "恢复默认");
      restore.type = "button";
      restore.addEventListener("click", () => regenerateCustomPrompt(textarea));
      row.appendChild(restore);
      content.appendChild(row);

      wrapper.appendChild(content);
      return wrapper;
    }

    function numberSetting(labelText, name, scale = 1) {
      const field = Card.el("label", "ll-field");
      field.appendChild(Card.el("span", "ll-field-label", labelText));
      const input = Card.el("input", "ll-input");
      input.type = "number";
      input.step = name === "analyzeTemperature" ? "0.1" : "1";
      input.value = String((Number(settings[name]) || 0) / scale);
      input.addEventListener("input", () => {
        const numeric = Number(input.value);
        if (Number.isFinite(numeric)) settings = { ...settings, [name]: numeric * scale };
      });
      field.appendChild(input);
      return field;
    }

    function selectSetting(labelText, name, values, description = "") {
      const field = Card.el("label", "ll-field");
      field.appendChild(Card.el("span", "ll-field-label", labelText));
      const wrapper = Card.el("div", "ll-select-wrap");
      const select = Card.el("select", "ll-input");
      values.forEach(([value, label]) => {
        const option = Card.el("option", "", label);
        option.value = value;
        option.selected = value === settings[name];
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        settings = { ...settings, [name]: select.value };
      });
      wrapper.appendChild(select);
      wrapper.appendChild(createIcon("chevron-down"));
      field.appendChild(wrapper);
      if (description) field.appendChild(Card.el("span", "ll-field-help", description));
      return field;
    }

    async function testConnection(button, status) {
      const Api = root.LyricLens?.Api;
      if (!Api?.testConnection) {
        status.textContent = "Api.testConnection 不可用";
        status.className = "ll-test-status ll-test-status-fail";
        return;
      }
      button.disabled = true;
      button.textContent = "测试中...";
      status.textContent = "正在连接...";
      status.className = "ll-test-status ll-test-status-pending";
      try {
        const result = await Api.testConnection({
          apiEndpoint: String(settings.apiEndpoint || "").trim(),
          apiKey: String(settings.apiKey || "").trim(),
          modelName: String(settings.modelName || "").trim()
        });
        status.textContent = result.ok ? `连接成功 · HTTP ${result.status}` : (result.message || "连接失败");
        status.className = result.ok ? "ll-test-status ll-test-status-ok" : "ll-test-status ll-test-status-fail";
      } catch (err) {
        status.textContent = `连接异常：${String(err?.message || err)}`;
        status.className = "ll-test-status ll-test-status-fail";
      } finally {
        button.disabled = false;
        button.textContent = "测试连接";
      }
    }

    function attachPointerInteractions() {
      const titlebar = panel.querySelector(".ll-titlebar");
      titlebar?.addEventListener("mousedown", startDrag);
      panel.querySelectorAll(".ll-resize-handle").forEach((handle) => {
        handle.addEventListener("mousedown", (event) => startResize(event, handle.dataset.direction));
      });
    }

    function startDrag(event) {
      if (!shouldStartPanelDrag(event)) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = { ...rect };
      panel.classList.add("ll-is-dragging");
      const move = (moveEvent) => {
        rect = clampPanelBounds({
          ...startRect,
          x: startRect.x + moveEvent.clientX - startX,
          y: startRect.y + moveEvent.clientY - startY
        }, defaultViewport(root), getEffectiveDims());
        applyRect();
      };
      const up = () => {
        panel.classList.remove("ll-is-dragging");
        rect = stateController.setBounds(rect, true, getEffectiveDims());
        root.removeEventListener("mousemove", move);
        root.removeEventListener("mouseup", up);
      };
      root.addEventListener("mousemove", move);
      root.addEventListener("mouseup", up);
    }

    function startBadgeDragOrRestore(event) {
      if (event.button !== 0) return;
      // The minimized "L" badge is a single <button>, so we can't reuse
      // startDrag (it short-circuits on buttons). Track movement: anything
      // past the threshold becomes a drag; otherwise mouseup restores.
      const DRAG_THRESHOLD = 4;
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = { ...rect };
      let dragging = false;
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          dragging = true;
          panel.classList.add("ll-is-dragging");
        }
        rect = clampPanelBounds({
          ...startRect,
          x: startRect.x + dx,
          y: startRect.y + dy
        }, defaultViewport(root), getEffectiveDims());
        applyRect();
      };
      const up = () => {
        root.removeEventListener("mousemove", move);
        root.removeEventListener("mouseup", up);
        if (dragging) {
          panel.classList.remove("ll-is-dragging");
          rect = stateController.setBounds(rect, true, getEffectiveDims());
        } else {
          minimized = false;
          stateController.setCollapsed(false);
          options.onRestoreCurrentSong?.(currentSongId);
          render();
        }
      };
      root.addEventListener("mousemove", move);
      root.addEventListener("mouseup", up);
    }

    function startResize(event, direction = "se") {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = { ...rect };
      const move = (moveEvent) => {
        const viewport = defaultViewport(root);
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        let left = startRect.x;
        let top = startRect.y;
        let right = startRect.x + startRect.width;
        let bottom = startRect.y + startRect.height;
        if (direction.includes("e")) right = Math.max(left + MIN_WIDTH, Math.min(viewport.width, right + dx));
        if (direction.includes("w")) left = Math.min(right - MIN_WIDTH, Math.max(0, left + dx));
        if (direction.includes("s")) bottom = Math.max(top + MIN_HEIGHT, Math.min(viewport.height, bottom + dy));
        if (direction.includes("n")) top = Math.min(bottom - MIN_HEIGHT, Math.max(0, top + dy));
        rect = { x: left, y: top, width: right - left, height: bottom - top };
        applyRect();
      };
      const up = () => {
        rect = stateController.setBounds(rect, true);
        root.removeEventListener("mousemove", move);
        root.removeEventListener("mouseup", up);
      };
      root.addEventListener("mousemove", move);
      root.addEventListener("mouseup", up);
    }

    function getEffectiveDims() {
      if (poppedOut) return { width: 268, height: 72 };
      if (minimized) return { width: 52, height: 52 };
      return null;
    }

    function applyRect() {
      if (!panel) return;
      rect = clampPanelBounds(rect, defaultViewport(root), getEffectiveDims());
      panel.style.left = `${rect.x}px`;
      panel.style.top = `${rect.y}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      recordPanelDiagnostics();
    }

    function defaultRect(position) {
      const width = 420;
      const height = 360;
      const margin = 28;
      const viewportWidth = root.innerWidth || 1280;
      const viewportHeight = root.innerHeight || 720;
      const right = viewportWidth - width - margin;
      const bottom = viewportHeight - height - margin;
      return {
        x: position === "topLeft" || position === "bottomLeft" ? margin : Math.max(margin, right),
        y: position === "topLeft" || position === "topRight" ? margin : Math.max(margin, bottom),
        width,
        height
      };
    }

    function setPoppedOut(value) {
      const next = Boolean(value);
      if (next === poppedOut) return next;
      poppedOut = next;
      mount();
      if (panel) panel.style.display = "";
      render();
      return poppedOut;
    }

    function setBridgeStatus(value) {
      const next = String(value || "idle");
      if (next === bridgeStatus) return bridgeStatus;
      bridgeStatus = next;
      if (poppedOut) render();
      else notify();
      return bridgeStatus;
    }

    const instance = {
      mount,
      destroy,
      unmount: destroy,
      setSongId,
      setSettings,
      hide,
      mountDebugPanel: showDebug,
      showConfig,
      showLoading,
      showError,
      showCard,
      resetForAnalyze,
      setCardsState,
      renderCardAt,
      syncToPlayback: (currentMs, reason = "playback-sync") => {
        const previousIndex = stateController.getState().currentCardIndex;
        const index = stateController.syncToPlayback(currentMs, reason);
        if (index !== previousIndex) render();
        return index;
      },
      nextCard: () => renderCardAt(stateController.nextCard("manual-next"), "manual-next"),
      prevCard: () => renderCardAt(stateController.prevCard("manual-prev"), "manual-prev"),
      setAutoFollow: (value) => {
        const next = stateController.setAutoFollow(value);
        options.onAutoFollowChanged?.(next);
        render();
        return next;
      },
      getAutoFollow: () => stateController.getState().autoFollow,
      setPoppedOut,
      setBridgeStatus,
      setUpdateState,
      getUpdateState,
      getPanelSnapshot,
      isPoppedOut: () => poppedOut,
      // Visual on/off — used by the master-enable toggle in the native
      // config page. We hide the root rather than unmounting because the
      // panel carries layout state (position, size, auto-follow) we want
      // to preserve across flips.
      setHidden: (hidden) => {
        if (!panel) return;
        panel.style.display = hidden ? "none" : "";
      }
    };
    activePanel = instance;
    return instance;
  }

  const api = {
    createPanel,
    createPanelState,
    clampPanelBounds,
    shouldStartPanelDrag,
    MIN_WIDTH,
    MIN_HEIGHT,
    mountDebugPanel: () => activePanel?.mountDebugPanel?.(),
    unmount: () => activePanel?.unmount?.()
  };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Panel = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
