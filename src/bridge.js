(function initLyricLensBridge(root) {
  "use strict";

  /*
   * LyricLens WebSocket Bridge — protocol v1
   *
   * Topology: plugin (NCM renderer) is the WS *client*; companion (Tauri
   * desktop window) runs the WS *server* on ws://127.0.0.1:47621/lyriclens.
   * Either side may send messages once connected.
   *
   * Envelope: { v: 1, type: <string>, payload?: <any>, ts?: <number> }
   *
   * Plugin -> Companion
   *   { v:1, type:"hello", payload:{ client:"lyriclens-plugin", version } }
   *   { v:1, type:"state", payload: BridgeStateSnapshot, ts }
   *   { v:1, type:"pong" }
   *
   * Companion -> Plugin
   *   { v:1, type:"hello", payload:{ client:"lyriclens-companion", version, token } }
   *   { v:1, type:"command", payload:{ name: CommandName, payload?: any } }
   *   { v:1, type:"ping" }
   *
   * CommandName:
   *   "next" | "prev"
   *   "toggleAutoFollow"
   *   "closeCurrentSong"
   *   "retry"
   *   "popIn"            // companion asks plugin to take the UI back into NCM
   *
   * Settings cannot be mutated over the bridge — the companion is a viewer.
   * The earlier "updateSettings" command was an API-key exfiltration vector
   * (any local process could redirect apiEndpoint to a server it controls
   * and read the key off the next Authorization header), so it is gone.
   *
   * BridgeStateSnapshot:
   *   {
   *     mode: "hidden"|"loading"|"error"|"config"|"card"|"no-cards"|"debug",
   *     loadingMessage: string|null,
   *     errorMessage: string|null,
   *     song: { id: string|null, title?: string, artist?: string } | null,
   *     language: "en"|"ja"|"other"|null,
   *     autoFollow: boolean,
   *     playbackMs: number|null,
   *     cards: Card[],
   *     currentCardIndex: number,
   *     currentCard: Card|null,
   *     settings: { theme, fontSize, opacity }
   *   }
   */

  const DEFAULT_PORT = 47621;
  const DEFAULT_PATH = "/lyriclens";
  const PROTOCOL_VERSION = 1;
  const RECONNECT_INITIAL_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const RECONNECT_GROWTH = 1.6;
  const PUBLISH_DEBOUNCE_MS = 60;
  const COMMAND_NAMES = new Set([
    "next",
    "prev",
    "toggleAutoFollow",
    "closeCurrentSong",
    "retry",
    "popIn"
  ]);

  function createBridge(options = {}) {
    const port = Number(options.port) || DEFAULT_PORT;
    const path = typeof options.path === "string" ? options.path : DEFAULT_PATH;
    const onCommand = typeof options.onCommand === "function" ? options.onCommand : null;
    const onStatusChange = typeof options.onStatusChange === "function" ? options.onStatusChange : null;
    const getSnapshot = typeof options.getSnapshot === "function" ? options.getSnapshot : null;
    const clientVersion = String(options.clientVersion || "0.1.0");
    const logger = options.logger || createDefaultLogger();
    // Shared secret presented in the hello frame so the Rust-side bridge
    // can refuse rogue local processes (any other process on this machine,
    // or any browser tab that does `new WebSocket("ws://127.0.0.1:47621/...")`)
    // before they get to send commands.
    const token = String(options.token || "");

    let ws = null;
    let status = "idle";
    let active = false;
    let companionHelloAt = 0;
    let reconnectDelay = RECONNECT_INITIAL_MS;
    let reconnectTimer = null;
    let publishTimer = null;
    let lastSnapshotJson = null;

    function setStatus(next) {
      if (status === next) return;
      status = next;
      try { onStatusChange?.(status); } catch (_) {}
    }

    function url() {
      return `ws://127.0.0.1:${port}${path}`;
    }

    function connect() {
      if (ws || !active) return;
      setStatus("connecting");
      let socket;
      try {
        socket = new root.WebSocket(url());
      } catch (err) {
        logger("ws-construct-failed", err?.message || String(err));
        scheduleReconnect();
        return;
      }
      ws = socket;
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("message", handleMessage);
      ws.addEventListener("close", handleClose);
      ws.addEventListener("error", handleError);
    }

    function handleOpen() {
      reconnectDelay = RECONNECT_INITIAL_MS;
      setStatus("connected");
      logger("connected", url());
      sendRaw({
        v: PROTOCOL_VERSION,
        type: "hello",
        payload: {
          client: "lyriclens-plugin",
          version: clientVersion,
          // Empty string is a valid signal "no token configured" — Rust side
          // refuses if its expected token is non-empty. We always send the
          // field so the wire shape is stable.
          token
        }
      });
      // Re-publish the current snapshot so a freshly-opened companion
      // doesn't sit on an empty UI waiting for the next state change.
      publishImmediate("post-open");
    }

    function handleMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        logger("malformed-message", err?.message || String(err));
        return;
      }
      if (!message || message.v !== PROTOCOL_VERSION) return;
      switch (message.type) {
        case "hello":
          companionHelloAt = Date.now();
          logger("companion-hello", message.payload?.version || "?");
          break;
        case "ping":
          sendRaw({ v: PROTOCOL_VERSION, type: "pong" });
          break;
        case "command":
          dispatchCommand(message.payload);
          break;
        default:
          logger("ignored-type", message.type);
      }
    }

    function dispatchCommand(payload) {
      if (!payload || typeof payload.name !== "string") return;
      if (!COMMAND_NAMES.has(payload.name)) {
        logger("unknown-command", payload.name);
        return;
      }
      if (!onCommand) return;
      try {
        onCommand(payload.name, payload.payload);
      } catch (err) {
        logger("command-handler-error", payload.name, err?.message || String(err));
      }
    }

    function handleClose() {
      logger("ws-close", { active });
      cleanupSocket();
      // A fresh connection needs a fresh state push, so don't let the dedup
      // suppress it just because the same snapshot was already sent to the
      // previous (now-gone) companion instance.
      lastSnapshotJson = null;
      if (active) {
        setStatus("disconnected");
        scheduleReconnect();
      } else {
        setStatus("closed");
      }
    }

    function handleError() {
      // Close event always fires after error in browser WebSocket;
      // reconnect logic lives there.
    }

    function cleanupSocket() {
      if (!ws) return;
      try {
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("message", handleMessage);
        ws.removeEventListener("close", handleClose);
        ws.removeEventListener("error", handleError);
      } catch (_) {}
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    function scheduleReconnect() {
      if (!active || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.floor(reconnectDelay * RECONNECT_GROWTH));
    }

    function sendRaw(message) {
      if (!ws || ws.readyState !== 1) return false;
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        logger("send-failed", err?.message || String(err));
        return false;
      }
    }

    function publishImmediate(reason) {
      if (!getSnapshot || status !== "connected") return;
      let snapshot;
      try {
        snapshot = getSnapshot();
      } catch (err) {
        logger("snapshot-error", err?.message || String(err));
        return;
      }
      if (!snapshot) return;
      const json = safeStringify(snapshot);
      if (json && json === lastSnapshotJson) return;
      lastSnapshotJson = json;
      sendRaw({
        v: PROTOCOL_VERSION,
        type: "state",
        ts: Date.now(),
        payload: snapshot
      });
      logger("state-published", reason || "change");
    }

    function publish(reason) {
      if (!active) return;
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        publishImmediate(reason);
      }, PUBLISH_DEBOUNCE_MS);
    }

    function popOut() {
      if (active) {
        if (status !== "connected") connect();
        return;
      }
      active = true;
      reconnectDelay = RECONNECT_INITIAL_MS;
      lastSnapshotJson = null;
      connect();
    }

    function popIn() {
      if (!active) return;
      active = false;
      if (status === "connected") {
        sendRaw({
          v: PROTOCOL_VERSION,
          type: "command",
          payload: { name: "popIn" }
        });
      }
      cleanupSocket();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (publishTimer) {
        clearTimeout(publishTimer);
        publishTimer = null;
      }
      lastSnapshotJson = null;
      setStatus("closed");
    }

    return {
      popOut,
      popIn,
      publish,
      isActive: () => active,
      isConnected: () => status === "connected",
      getStatus: () => status,
      getDiagnostics: () => ({
        status,
        active,
        port,
        path,
        reconnectDelay,
        companionHelloAt,
        lastSnapshotBytes: lastSnapshotJson ? lastSnapshotJson.length : 0
      })
    };
  }

  function buildSnapshot(parts = {}) {
    const panelState = parts.panelState || {};
    const settings = parts.settings || {};
    const mode = parts.mode || "hidden";
    const opacity = Number(settings.panelOpacity);
    return {
      mode,
      loadingMessage: typeof parts.loadingMessage === "string" ? parts.loadingMessage : null,
      errorMessage: typeof parts.errorMessage === "string" ? parts.errorMessage : null,
      song: parts.song || null,
      language: parts.language || null,
      playbackMs: Number.isFinite(parts.playbackMs) ? parts.playbackMs : null,
      autoFollow: panelState.autoFollow !== false,
      cards: Array.isArray(panelState.cards) ? panelState.cards : [],
      currentCardIndex: Number.isFinite(panelState.currentCardIndex) ? panelState.currentCardIndex : 0,
      currentCard: panelState.currentCard || null,
      settings: {
        theme: settings.panelTheme === "light" ? "light" : "dark",
        fontSize: ["compact", "standard", "large"].includes(settings.panelFontSize) ? settings.panelFontSize : "standard",
        opacity: Number.isFinite(opacity) ? opacity : 0.96
      }
    };
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return null;
    }
  }

  function createDefaultLogger() {
    return (...args) => {
      try { console.log("[LyricLens:bridge]", ...args); } catch (_) {}
    };
  }

  const api = {
    createBridge,
    buildSnapshot,
    DEFAULT_PORT,
    DEFAULT_PATH,
    PROTOCOL_VERSION,
    COMMAND_NAMES: Array.from(COMMAND_NAMES)
  };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Bridge = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
