// Manual dev tool. Launches a minimal WebSocket server on
// 127.0.0.1:47621/lyriclens to validate the plugin-side bridge before the
// real Tauri companion exists. Zero deps (raw RFC 6455 framing).
//
// Usage: node tests/companion_stub.js
//
// Then in NCM click "弹出到桌面". Every state push is logged; commands typed
// at the prompt are sent back to the plugin:
//   next | prev | autofollow | retry | close | popin | ping
//
// Settings can no longer be mutated over the bridge (was an API-key
// exfil vector); use the in-NCM settings panel instead.
//
// Not picked up by `npm test` (no .test.js suffix).

"use strict";

const http = require("http");
const crypto = require("crypto");
const readline = require("readline");

const PORT = Number(process.env.PORT) || 47621;
const PATH = "/lyriclens";
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL_VERSION = 1;

let socket = null;

const server = http.createServer((req, res) => {
  res.writeHead(404).end();
});

server.on("upgrade", (req, sock) => {
  if (req.url !== PATH) {
    sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    sock.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    sock.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n"
  );
  setupSocket(sock);
});

function setupSocket(sock) {
  if (socket) {
    console.log("[stub] replacing previous connection");
    try { socket.destroy(); } catch (_) {}
  }
  socket = sock;
  console.log("[stub] plugin connected");
  sendJSON({
    v: PROTOCOL_VERSION,
    type: "hello",
    payload: { client: "lyriclens-companion-stub", version: "0.0.1" }
  });

  let buffer = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.consumed);
      if (frame.opcode === 0x8) {
        console.log("[stub] close frame");
        sock.destroy();
        if (socket === sock) socket = null;
        return;
      }
      if (frame.opcode === 0x9) {
        sock.write(encodeFrame(0xA, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1) {
        handleText(frame.payload.toString("utf8"));
      }
    }
  });
  sock.on("close", () => {
    console.log("[stub] plugin disconnected");
    if (socket === sock) socket = null;
  });
  sock.on("error", (err) => console.error("[stub] socket error", err.message));
}

function handleText(text) {
  let msg;
  try { msg = JSON.parse(text); } catch (_) { console.log("[stub] non-JSON:", text); return; }
  if (!msg || msg.v !== PROTOCOL_VERSION) return;
  if (msg.type === "state") {
    const p = msg.payload || {};
    const card = p.currentCard;
    const cardLine = card
      ? `"${(card.line || card.original || "").slice(0, 40)}" → ${(card.translation || "").slice(0, 40)}`
      : "(no card)";
    console.log(
      `[stub] state mode=${p.mode} song=${p.song?.id || "-"} ` +
      `idx=${p.currentCardIndex}/${(p.cards || []).length} ` +
      `theme=${p.settings?.theme} font=${p.settings?.fontSize} ` +
      `card=${cardLine}`
    );
  } else if (msg.type === "hello") {
    console.log("[stub] plugin hello v=" + (msg.payload?.version || "?"));
  } else if (msg.type === "pong") {
    // noop
  } else {
    console.log("[stub] other type:", msg.type);
  }
}

function sendJSON(obj) {
  if (!socket) return;
  socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7F;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (mask) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, consumed: offset + len };
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub] listening on ws://127.0.0.1:${PORT}${PATH}`);
  console.log("[stub] commands: next | prev | autofollow | retry | close | popin | ping");
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === "quit" || text === "exit") process.exit(0);
  const message = parseCommand(text);
  if (!message) {
    console.log(`[stub] unknown command: ${text}`);
    return;
  }
  if (!socket) {
    console.log("[stub] no plugin connected");
    return;
  }
  sendJSON(message);
  console.log(`[stub] -> ${message.payload?.name || message.type}`);
});

function parseCommand(text) {
  switch (text) {
    case "next":
    case "prev":
    case "retry":
      return { v: PROTOCOL_VERSION, type: "command", payload: { name: text } };
    case "autofollow":
      return { v: PROTOCOL_VERSION, type: "command", payload: { name: "toggleAutoFollow" } };
    case "close":
      return { v: PROTOCOL_VERSION, type: "command", payload: { name: "closeCurrentSong" } };
    case "popin":
      return { v: PROTOCOL_VERSION, type: "command", payload: { name: "popIn" } };
    case "ping":
      return { v: PROTOCOL_VERSION, type: "ping" };
  }
  return null;
}
