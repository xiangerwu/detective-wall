use crate::{
    chat::ChatManager,
    db::{normalize_tabs_meta, safe_source_href, Database},
    AppError, Result,
};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json, Router,
};
use futures_util::{stream, StreamExt};
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tokio_stream::wrappers::BroadcastStream;

static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web");
const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_PROJECT_BODY: usize = 128 * 1024 * 1024;

pub struct RunningServer {
    pub port: u16,
    pub chat: ChatManager,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}
impl RunningServer {
    pub async fn stop(mut self) {
        self.chat.stop_all().await;
        if let Some(send) = self.shutdown.take() {
            let _ = send.send(());
        }
        if tokio::time::timeout(Duration::from_secs(2), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = self.task.await;
        }
    }
}

struct ServiceState {
    database: Mutex<Database>,
    db_path: PathBuf,
    port: u16,
    started: String,
    chat: ChatManager,
    picking: AtomicBool,
}

pub async fn start(
    db_path: PathBuf,
    port: u16,
    workdir: Option<PathBuf>,
    mcp_path: PathBuf,
) -> Result<RunningServer> {
    let db_path = std::path::absolute(db_path)?;
    let workdir = workdir.unwrap_or_else(|| db_path.parent().unwrap().join("chat-workdir"));
    if workdir.exists() && !workdir.is_dir() {
        return Err(AppError::new(
            500,
            format!("chat workdir is not a directory: {}", workdir.display()),
        ));
    }
    std::fs::create_dir_all(&workdir).map_err(|error| {
        AppError::new(
            500,
            format!("cannot create chat workdir {}: {error}", workdir.display()),
        )
    })?;
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        AppError::new(
            if e.kind() == std::io::ErrorKind::AddrInUse {
                409
            } else {
                500
            },
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("WALL_PORT {port} 已被占用；請改用其他 WALL_PORT 後再啟動")
            } else {
                e.to_string()
            },
        )
    })?;
    let port = listener.local_addr()?.port();
    let database = Database::open(&db_path, false)?;
    let chat = ChatManager::new(db_path.clone(), workdir, mcp_path, port)?;
    let state = Arc::new(ServiceState {
        database: Mutex::new(database),
        db_path,
        port,
        started: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        chat: chat.clone(),
        picking: AtomicBool::new(false),
    });
    let router = Router::new().fallback(handle).with_state(state);
    let (send, recv) = oneshot::channel();
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = recv.await;
            })
            .await
        {
            eprintln!("CaseGraph HTTP service: {error}");
        }
    });
    Ok(RunningServer {
        port,
        chat,
        shutdown: Some(send),
        task,
    })
}

fn object(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(AppError::new(400, "JSON object required"));
    }
    Ok(())
}
fn id<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new(400, format!("{label} required")))
}
fn positive_id(value: &str, label: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| AppError::new(400, format!("invalid {label} id")))
}
fn found(value: Value, label: &str) -> Result<Value> {
    if value.is_null() {
        Err(AppError::new(404, format!("{label} not found")))
    } else {
        Ok(value)
    }
}

async fn handle(State(state): State<Arc<ServiceState>>, request: Request) -> Result<Response> {
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let hosts = [
        format!("127.0.0.1:{}", state.port),
        format!("localhost:{}", state.port),
    ];
    let valid_origin = request
        .headers()
        .get("origin")
        .map(|v| {
            v.to_str()
                .ok()
                .map(|s| {
                    hosts
                        .iter()
                        .any(|h| format!("http://{h}") == s.to_ascii_lowercase())
                })
                .unwrap_or(false)
        })
        .unwrap_or(true);
    if !hosts.contains(&host) || !valid_origin {
        return Err(AppError::new(403, "forbidden origin"));
    }
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if !path.starts_with("/api") {
        if method != Method::GET {
            return Err(AppError::new(405, "method not allowed"));
        }
        let filename = if path == "/" {
            "index.html"
        } else {
            path.trim_start_matches('/')
        };
        let file = WEB
            .get_file(filename)
            .ok_or_else(|| AppError::new(404, "not found"))?;
        let content = file.contents();
        let etag = format!("\"{:x}\"", Sha256::digest(content));
        let content_type = match Path::new(filename).extension().and_then(|e| e.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") => "application/javascript; charset=utf-8",
            Some("png") => "image/png",
            Some("jpg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("ico") => "image/x-icon",
            Some("css") => "text/css; charset=utf-8",
            _ => "application/octet-stream",
        };
        if request
            .headers()
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            == Some(etag.as_str())
        {
            return Ok((StatusCode::NOT_MODIFIED, [("etag", etag)]).into_response());
        }
        return Ok((
            [
                ("content-type", content_type.to_string()),
                ("etag", etag),
                (
                    "cache-control",
                    if filename.starts_with("assets/") {
                        "public, max-age=31536000, immutable"
                    } else {
                        "no-cache"
                    }
                    .to_string(),
                ),
            ],
            content,
        )
            .into_response());
    }
    let parts: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode_segment)
        .collect::<Result<_>>()?;
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let p: Vec<&str> = parts.iter().map(String::as_str).collect();
    if p.first() != Some(&"api") {
        return Err(AppError::new(404, "not found"));
    }
    let body_policy = match (method.as_str(), p.as_slice()) {
        (
            "PUT",
            ["api", "project"] | ["api", "walls", _] | ["api", "images", _] | ["api", "meta", _],
        )
        | (
            "POST",
            ["api", "chat", _]
            | ["api", "chat", _, "reset"]
            | ["api", "sources", "check"]
            | ["api", "walls", _, "backups"]
            | ["api", "proposals", _, "preview"]
            | ["api", "proposals", _, "apply"],
        ) => 1,
        ("POST", ["api", "proposals", _, "reject"]) => 2,
        _ => 0,
    };
    let input: Value = if body_policy == 0 {
        Value::Null
    } else {
        let bytes = to_bytes(
            request.into_body(),
            if path == "/api/project" {
                MAX_PROJECT_BODY
            } else {
                MAX_BODY
            },
        )
        .await
        .map_err(|_| AppError::new(413, "request body too large"))?;
        if bytes.is_empty() {
            if body_policy == 1 {
                return Err(AppError::new(400, "request body required"));
            }
            json!({})
        } else {
            serde_json::from_slice(&bytes).map_err(|_| AppError::new(400, "invalid JSON"))?
        }
    };
    if p.as_slice() == ["api", "pick-folder"] {
        if method != Method::POST {
            return Err(AppError::new(405, "method not allowed"));
        }
        if state.picking.swap(true, Ordering::SeqCst) {
            return Err(AppError::new(409, "已有資料夾選擇視窗正在開啟"));
        }
        let value = crate::chat::pick_folder().await;
        state.picking.store(false, Ordering::SeqCst);
        return value.map(|v| Json(v).into_response());
    }
    if p.as_slice() == ["api", "chat", "clients"] && method == Method::GET {
        return Ok(Json(crate::chat::clients()).into_response());
    }
    if p.len() >= 3 && p[1] == "chat" {
        let wall_id = p[2];
        let client = query
            .get("client")
            .map(String::as_str)
            .or_else(|| input["client"].as_str());
        if p.len() == 4 && p[3] == "stop" && method == Method::POST {
            return Ok(Json(state.chat.stop(wall_id, client).await?).into_response());
        }
        let client = client
            .filter(|c| ["claude", "codex"].contains(c))
            .ok_or_else(|| AppError::new(400, "client must be claude or codex"))?;
        let history = state.chat.history(wall_id, client)?;
        if p.len() == 4 && p[3] == "events" && method == Method::GET {
            let (history, receiver) = state.chat.subscribe(wall_id);
            let ready = stream::iter(
                std::iter::once(crate::chat::ChatEvent {
                    event: "ready".into(),
                    value: json!({"wallId":wall_id,"client":client}),
                })
                .chain(history),
            );
            let live = BroadcastStream::new(receiver).filter_map(|e| async { e.ok() });
            let events = ready
                .chain(live)
                .take_while(|event| std::future::ready(event.event != "end"))
                .map(|event| {
                    Ok::<_, Infallible>(
                        Event::default()
                            .event(event.event)
                            .data(event.value.to_string()),
                    )
                });
            return Ok(Sse::new(events)
                .keep_alive(
                    KeepAlive::new()
                        .interval(Duration::from_secs(15))
                        .text("keep-alive"),
                )
                .into_response());
        }
        if p.len() == 3 && method == Method::GET {
            return Ok(Json(history).into_response());
        }
        if p.len() == 4 && p[3] == "reset" && method == Method::POST {
            object(&input)?;
            return Ok(Json(state.chat.reset(wall_id, client)?).into_response());
        }
        if p.len() == 3 && method == Method::POST {
            object(&input)?;
            if input.get("client").is_some() && input["client"] != client {
                return Err(AppError::new(400, "client mismatch"));
            }
            let message = input["message"]
                .as_str()
                .ok_or_else(|| AppError::new(400, "message must be 1-12000 characters"))?;
            // A disconnected HTTP client must not cancel process cleanup or leave the wall busy.
            let manager = state.chat.clone();
            let (wall_id, client, message) =
                (wall_id.to_owned(), client.to_owned(), message.to_owned());
            let result =
                tokio::spawn(async move { manager.send(&wall_id, &client, &message).await })
                    .await
                    .map_err(|e| AppError::new(500, e.to_string()))??;
            return Ok(Json(result).into_response());
        }
        return Err(AppError::new(405, "method not allowed"));
    }
    if p.as_slice() == ["api", "sources", "check"] && method == Method::POST {
        object(&input)?;
        let hrefs = input["hrefs"]
            .as_array()
            .filter(|v| v.len() <= 200)
            .ok_or_else(|| AppError::new(400, "invalid source hrefs"))?;
        let mut results = Vec::new();
        for href in hrefs {
            let href = href
                .as_str()
                .filter(|h| h.encode_utf16().count() <= 4096)
                .ok_or_else(|| AppError::new(400, "invalid source hrefs"))?;
            results.push(json!({"href":href,"status": source_status(href, state.db_path.parent().unwrap()).await}));
        }
        return Ok(Json(json!({"results":results})).into_response());
    }
    let db = state
        .database
        .lock()
        .map_err(|_| AppError::new(500, "database lock poisoned"))?;
    let output = match p.as_slice() {
        ["api", "health"] if method == Method::GET => {
            json!({"app":"casegraph","version":env!("CARGO_PKG_VERSION"),"pid":std::process::id(),"port":state.port,"db":state.db_path,"startedAt":state.started})
        }
        ["api"] if method == Method::GET => {
            let walls = db.list_walls(true)?;
            let current_id = db.get_meta("currentWall")?;
            let current = walls
                .as_array()
                .and_then(|a| a.iter().find(|w| w["id"] == current_id).or(a.first()))
                .cloned()
                .unwrap_or(Value::Null);
            let mut result = if current.is_null() {
                json!({"id":null,"name":null,"updated":null,"version":null,"data":null})
            } else {
                current.clone()
            };
            result["wall"] = current;
            result["walls"] = walls;
            result
        }
        ["api", "project"] => match method {
            Method::GET => db.get_project()?,
            Method::PUT => db.replace_project(&validate_project(input)?)?,
            _ => return Err(AppError::new(405, "method not allowed")),
        },
        ["api", "search"] if method == Method::GET => {
            let q = query.get("q").map(String::as_str).unwrap_or("");
            if q.encode_utf16().count() > 1000 {
                return Err(AppError::new(400, "search query too long"));
            }
            let limit = match query.get("limit") {
                Some(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
                    s.parse::<usize>().ok().filter(|n| (1..=200).contains(n))
                }
                Some(_) => None,
                None => Some(50),
            }
            .ok_or_else(|| AppError::new(400, "invalid search limit"))?;
            db.search(q, limit, None, 0)?
        }
        ["api", "walls"] if method == Method::GET => db.list_walls(false)?,
        ["api", "walls", wall] => match method {
            Method::GET => found(db.get_wall(wall)?, "wall")?,
            Method::PUT => {
                object(&input)?;
                if input.get("id").is_some() && input["id"] != *wall {
                    return Err(AppError::new(400, "wall id mismatch"));
                }
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| AppError::new(400, "invalid wall"))?;
                if !input["data"].is_object() {
                    return Err(AppError::new(400, "invalid wall"));
                }
                let version = if input["version"].is_null() {
                    None
                } else {
                    Some(
                        input["version"]
                            .as_i64()
                            .filter(|v| *v >= 0)
                            .ok_or_else(|| AppError::new(400, "invalid wall version"))?,
                    )
                };
                db.put_wall(wall, name, &input["data"], version)?
            }
            Method::DELETE => {
                db.delete_wall(wall)?;
                return Ok(StatusCode::NO_CONTENT.into_response());
            }
            _ => return Err(AppError::new(405, "method not allowed")),
        },
        ["api", "walls", wall, "backups"] => match method {
            Method::GET => db.list_backups(wall)?,
            Method::DELETE => {
                db.delete_backups(wall)?;
                return Ok(StatusCode::NO_CONTENT.into_response());
            }
            Method::POST => {
                object(&input)?;
                let reason = input["reason"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| AppError::new(400, "invalid backup"))?;
                if !input["data"]["cards"].is_array() || !input["data"]["edges"].is_array() {
                    return Err(AppError::new(400, "invalid backup"));
                }
                json!({"id":db.add_backup(wall, reason, &input["data"]) ?})
            }
            _ => return Err(AppError::new(405, "method not allowed")),
        },
        ["api", "backups", number] if method == Method::GET => {
            found(db.get_backup(positive_id(number, "backup")?)?, "backup")?
        }
        ["api", "images", image] => match method {
            Method::GET => found(db.get_image(image)?, "image")?,
            Method::PUT => {
                object(&input)?;
                if input["id"] != *image
                    || !input["record"].is_object()
                    || input["record"]["id"] != *image
                {
                    return Err(AppError::new(400, "invalid image"));
                }
                json!({"id": db.put_image(&input["record"])?})
            }
            _ => return Err(AppError::new(405, "method not allowed")),
        },
        ["api", "meta", key] => match method {
            Method::GET => {
                if !db.has_meta(key)? {
                    return Err(AppError::new(404, "meta not found"));
                }
                json!({"value":db.get_meta(key)?})
            }
            Method::PUT => {
                object(&input)?;
                json!({"key":db.set_meta(key,&input["value"])?})
            }
            _ => return Err(AppError::new(405, "method not allowed")),
        },
        ["api", "proposals"] if method == Method::GET => {
            let status = query
                .get("status")
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("pending");
            if !["pending", "all"].contains(&status) {
                return Err(AppError::new(400, "invalid proposal status"));
            }
            db.list_proposals(
                status,
                query
                    .get("wallId")
                    .map(String::as_str)
                    .filter(|s| !s.is_empty()),
            )?
        }
        ["api", "proposals", proposal] if method == Method::GET => {
            found(db.get_proposal(proposal)?, "proposal")?
        }
        ["api", "proposals", proposal, action] if method == Method::POST => {
            if *action == "reject" {
                object(&input)?;
                db.reject_proposal(proposal, input.get("opIndexes"))?
            } else {
                object(&input)?;
                match *action {
                    "preview" => db.preview_proposal(proposal, &input["opIndexes"])?,
                    "apply" => db.apply_proposal(proposal, &input["opIndexes"])?,
                    _ => return Err(AppError::new(404, "not found")),
                }
            }
        }
        ["api", "audit"] if method == Method::GET => db.list_audit(
            query
                .get("wallId")
                .map(String::as_str)
                .filter(|s| !s.is_empty()),
        )?,
        ["api", "audit", number, "revert"] if method == Method::POST => {
            db.revert_audit(positive_id(number, "audit")?)?
        }
        _ => return Err(AppError::new(404, "not found")),
    };
    Ok(Json(output).into_response())
}

fn validate_project(mut input: Value) -> Result<Value> {
    object(&input)?;
    if input["format"] != "detective-wall-project" || input["formatVersion"] != 1 {
        return Err(AppError::new(400, "invalid project format"));
    }
    if input["exportedAt"].as_str().unwrap_or("").is_empty() {
        return Err(AppError::new(400, "invalid project export time"));
    }
    object(&input["meta"])?;
    if input["meta"].get("tabs").is_some() {
        input["meta"]["tabs"] = normalize_tabs_meta(&input["meta"]["tabs"])?;
    }
    let mut ids = HashSet::new();
    for wall in input["walls"]
        .as_array_mut()
        .ok_or_else(|| AppError::new(400, "invalid project collections"))?
    {
        object(wall)?;
        if !ids.insert(id(&wall["id"], "wall id")?.to_owned()) {
            return Err(AppError::new(400, "duplicate wall id"));
        }
        if !wall["name"].is_string()
            || wall["updated"]
                .as_i64()
                .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
                .is_none()
            || wall["version"]
                .as_i64()
                .filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991)
                .is_none()
            || !wall["data"].is_object()
        {
            return Err(AppError::new(400, "invalid project wall"));
        }
        if let Some(cards) = wall["data"]["cards"].as_array_mut() {
            for card in cards {
                if let Some(links) = card.get_mut("links").and_then(Value::as_array_mut) {
                    links.retain(|link| link["href"].as_str().is_some_and(safe_source_href));
                }
            }
        }
    }
    ids.clear();
    for image in input["images"]
        .as_array()
        .ok_or_else(|| AppError::new(400, "invalid project collections"))?
    {
        object(image)?;
        if !ids.insert(id(&image["id"], "image id")?.to_owned()) {
            return Err(AppError::new(400, "duplicate image id"));
        }
    }
    if input["meta"]
        .as_object()
        .unwrap()
        .keys()
        .any(|k| k.is_empty())
    {
        return Err(AppError::new(400, "invalid project meta key"));
    }
    Ok(input)
}

async fn source_status(href: &str, root: &Path) -> &'static str {
    if href.is_empty() {
        return "unchecked";
    }
    let path = if Path::new(href).is_absolute() {
        PathBuf::from(href)
    } else if let Ok(url) = url::Url::parse(href) {
        if url.scheme() != "file" {
            return "unchecked";
        }
        if url
            .host_str()
            .is_some_and(|s| !s.is_empty() && s != "localhost")
        {
            return "unchecked";
        }
        match url.to_file_path() {
            Ok(p) => p,
            Err(_) => return "missing",
        }
    } else {
        root.join(href)
    };
    let s = path.to_string_lossy();
    if s.starts_with("\\\\") || s.starts_with("//") {
        return "unchecked";
    }
    if tokio::fs::metadata(path).await.is_ok() {
        "ok"
    } else {
        "missing"
    }
}

fn decode_segment(segment: &str) -> Result<String> {
    let bytes = segment.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(AppError::new(400, "malformed URL"));
        }
    }
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| AppError::new(400, "malformed URL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_import_preserves_unknown_fields_and_filters_unsafe_links() {
        let input = json!({"format":"detective-wall-project","formatVersion":1,"exportedAt":"2026-11-06", "images":[],"meta":{},
            "walls":[{"id":"w","name":"牆","updated":1,"version":1,"data":{"custom":{"keep":true},"cards":[{"id":"c","links":[{"href":"javascript:alert(1)"},{"href":"https://example.org"}]}],"edges":[]}}]});
        let project = validate_project(input).unwrap();
        assert_eq!(project["walls"][0]["data"]["custom"]["keep"], true);
        assert_eq!(
            project["walls"][0]["data"]["cards"][0]["links"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut invalid = project;
        invalid["walls"][0]["version"] = json!(0);
        assert_eq!(validate_project(invalid).unwrap_err().status, 400);
    }
}
