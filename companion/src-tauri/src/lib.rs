use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const WS_BIND: &str = "127.0.0.1:47621";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ws_sink: WsSink = Arc::new(Mutex::new(None));
    let app_state = AppState {
        ws_sink: ws_sink.clone(),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![send_to_plugin, bridge_status, close_companion])
        .setup(move |app| {
            let handle = app.handle().clone();
            let sink_for_server = ws_sink.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = run_ws_server(handle, sink_for_server).await {
                    eprintln!("[bridge] ws server fatal: {}", err);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn run_ws_server(app: AppHandle, sink_state: WsSink) -> std::io::Result<()> {
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
                tokio::spawn(async move {
                    handle_client(stream, app_clone, sink_clone).await;
                });
            }
            Err(err) => {
                eprintln!("[bridge] accept failed: {}", err);
            }
        }
    }
}

async fn handle_client(stream: TcpStream, app: AppHandle, sink_state: WsSink) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[bridge] handshake failed: {}", err);
            return;
        }
    };
    let (write, mut read) = ws_stream.split();

    {
        let mut guard = sink_state.lock().await;
        *guard = Some(write);
    }
    let _ = app.emit("bridge://connected", true);
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
