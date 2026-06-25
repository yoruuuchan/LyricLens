use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const WS_BIND: &str = "127.0.0.1:47621";
// Hard ceiling for the hello frame. A real plugin sends hello instantly
// after WS open; anything slower than this is either misbehaving or a
// scanner that opened a connection and never spoke.
const HELLO_TIMEOUT_MS: u64 = 5_000;

type WsSink = Arc<
    Mutex<
        Option<
            futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
        >,
    >,
>;

struct AppState {
    ws_sink: WsSink,
}

#[tauri::command]
async fn send_to_plugin(
    state: State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    let mut guard = state.ws_sink.lock().await;
    match guard.as_mut() {
        Some(sink) => sink
            .send(Message::Text(message))
            .await
            .map_err(|e| e.to_string()),
        None => Err("no plugin connected".into()),
    }
}

#[tauri::command]
fn bridge_status(state: State<'_, AppState>) -> bool {
    state.ws_sink.try_lock().map(|g| g.is_some()).unwrap_or(false)
}

#[tauri::command]
fn close_companion(app: AppHandle) {
    app.exit(0);
}

fn parse_bridge_token(args: impl IntoIterator<Item = String>) -> String {
    // Accept `--bridge-token=<hex>` only. Hex-only enforcement matches the
    // plugin side, so a non-hex token (e.g. injected garbage) is just
    // dropped silently — never echoed, never used.
    for arg in args {
        if let Some(value) = arg.strip_prefix("--bridge-token=") {
            if !value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit()) {
                return value.to_string();
            }
        }
    }
    String::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ws_sink: WsSink = Arc::new(Mutex::new(None));
    // Expected hello token, parsed from --bridge-token=<hex> on launch.
    // Empty means the companion was started without a token (e.g. user
    // ran the .exe directly) — in that mode the bridge refuses every
    // connection so a manually-launched companion cannot be hijacked
    // by a local attacker either.
    let expected_token = parse_bridge_token(std::env::args());
    let app_state = AppState {
        ws_sink: ws_sink.clone(),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![send_to_plugin, bridge_status, close_companion])
        .setup(move |app| {
            let handle = app.handle().clone();
            let sink_for_server = ws_sink.clone();
            let token = expected_token.clone();
            if token.is_empty() {
                eprintln!(
                    "[bridge] no --bridge-token provided; the companion will refuse all \
                     connections. Launch it from the LyricLens panel inside NetEase Cloud Music."
                );
            }
            tauri::async_runtime::spawn(async move {
                if let Err(err) = run_ws_server(handle, sink_for_server, token).await {
                    eprintln!("[bridge] ws server fatal: {}", err);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn run_ws_server(app: AppHandle, sink_state: WsSink, expected_token: String) -> std::io::Result<()> {
    let listener = match TcpListener::bind(WS_BIND).await {
        Ok(l) => l,
        Err(err) => {
            // Most common cause: another companion instance already owns the
            // port. Exit cleanly so the orphan Tauri window doesn't linger.
            eprintln!("[bridge] bind {} failed ({}). exiting.", WS_BIND, err);
            app.exit(2);
            return Err(err);
        }
    };
    eprintln!("[bridge] listening on ws://{}", WS_BIND);
    let _ = app.emit("bridge://server-up", WS_BIND);

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                eprintln!("[bridge] incoming from {}", peer);
                let app_clone = app.clone();
                let sink_clone = sink_state.clone();
                let token_clone = expected_token.clone();
                tokio::spawn(async move {
                    handle_client(stream, app_clone, sink_clone, token_clone).await;
                });
            }
            Err(err) => {
                eprintln!("[bridge] accept failed: {}", err);
            }
        }
    }
}

// Constant-time string compare. The two strings the caller compares are
// the same length in the happy path (both 32-char hex), but length is
// also a side channel, so we account for it explicitly.
fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_client(
    stream: TcpStream,
    app: AppHandle,
    sink_state: WsSink,
    expected_token: String,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[bridge] handshake failed: {}", err);
            return;
        }
    };
    let (mut write, mut read) = ws_stream.split();

    // Refuse before doing anything if we were launched without a token —
    // safest mode for a manually-started companion.
    if expected_token.is_empty() {
        eprintln!("[bridge] rejecting connection: no expected token");
        let _ = write.close().await;
        return;
    }

    // Wait for the plugin's hello frame. Anything else (no frame, wrong
    // type, bad token, missing v) terminates the connection before it
    // becomes the active sink — so a rogue connector cannot replace the
    // real plugin's sink with its own.
    let hello = match timeout(Duration::from_millis(HELLO_TIMEOUT_MS), read.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
        Ok(Some(Ok(_))) => {
            eprintln!("[bridge] reject: non-text first frame");
            let _ = write.close().await;
            return;
        }
        Ok(Some(Err(err))) => {
            eprintln!("[bridge] reject: read error before hello: {}", err);
            return;
        }
        Ok(None) => {
            eprintln!("[bridge] reject: stream closed before hello");
            return;
        }
        Err(_) => {
            eprintln!("[bridge] reject: hello timeout");
            let _ = write.close().await;
            return;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&hello) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[bridge] reject: hello not JSON");
            let _ = write.close().await;
            return;
        }
    };
    let v_ok = parsed.get("v").and_then(|v| v.as_i64()) == Some(1);
    let type_ok = parsed.get("type").and_then(|v| v.as_str()) == Some("hello");
    let token_ok = parsed
        .get("payload")
        .and_then(|p| p.get("token"))
        .and_then(|t| t.as_str())
        .map(|t| ct_eq(t, &expected_token))
        .unwrap_or(false);
    if !(v_ok && type_ok && token_ok) {
        eprintln!("[bridge] reject: bad hello (v_ok={} type_ok={} token_ok={})", v_ok, type_ok, token_ok);
        let _ = write.close().await;
        return;
    }

    // Authenticated. Install as the active sink. If another sink was already
    // there (shouldn't happen — plugin reconnects close the prior socket
    // first), the old one is dropped here and its writer task will see EOF.
    {
        let mut guard = sink_state.lock().await;
        *guard = Some(write);
    }
    let _ = app.emit("bridge://connected", true);
    let _ = app.emit("bridge://message", hello);
    eprintln!("[bridge] plugin connected");

    while let Some(item) = read.next().await {
        match item {
            Ok(Message::Text(text)) => {
                let _ = app.emit("bridge://message", text.to_string());
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(payload)) => {
                if let Some(sink) = sink_state.lock().await.as_mut() {
                    let _ = sink.send(Message::Pong(payload)).await;
                }
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("[bridge] read error: {}", err);
                break;
            }
        }
    }

    {
        let mut guard = sink_state.lock().await;
        *guard = None;
    }
    let _ = app.emit("bridge://connected", false);
    eprintln!("[bridge] plugin disconnected");
}
