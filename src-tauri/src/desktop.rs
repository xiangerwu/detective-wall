use crate::{
    chat,
    server::{self, RunningServer},
    AppError, Result,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

struct Desktop {
    settings: Value,
    root: PathBuf,
    mcp: PathBuf,
    server: Option<RunningServer>,
    allowed_port: Arc<AtomicU16>,
    env_port: Option<u16>,
    override_port: Option<u16>,
    repair: bool,
    status: String,
    message: String,
    error: Option<String>,
    apply_error: Value,
    cli_opened: bool,
    stale_clients: bool,
}
struct DesktopState(Mutex<Desktop>);

fn path_key(path: &Path) -> String {
    std::path::absolute(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}
fn folder(value: &Value, label: &str) -> Result<PathBuf> {
    let path = value
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| AppError::new(400, format!("{label} 必須是絕對路徑")))?;
    Ok(std::path::absolute(path)?)
}
fn validate_settings(value: &Value) -> Result<()> {
    if value["schemaVersion"] != 1
        || value.get("legacyMigration").is_some()
        || value["port"]
            .as_u64()
            .filter(|p| (1024..=65535).contains(p))
            .is_none()
    {
        return Err(AppError::new(400, "settings schema is invalid"));
    }
    let active = folder(&value["activeProjectFolder"], "目前專案")?;
    if !active.is_dir() {
        return Err(AppError::new(400, "active project folder does not exist"));
    }
    let recent = value["recentProjects"]
        .as_array()
        .filter(|a| a.len() <= 10)
        .ok_or_else(|| AppError::new(400, "recentProjects is invalid"))?;
    let mut seen = std::collections::HashSet::new();
    for row in recent {
        let project = folder(&row["folder"], "專案")?;
        if !seen.insert(path_key(&project))
            || row["lastUsedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_none()
        {
            return Err(AppError::new(400, "recentProjects is invalid"));
        }
        if !row["aiWorkdir"].is_null() {
            let cwd = folder(&row["aiWorkdir"], "AI 工作資料夾")?;
            if path_key(&cwd) == path_key(&project.join("wall.db"))
                || (cwd.exists() && !cwd.is_dir())
            {
                return Err(AppError::new(400, "aiWorkdir is not a directory"));
            }
        }
    }
    if !seen.contains(&path_key(&active)) {
        return Err(AppError::new(
            400,
            "active project is not in recentProjects",
        ));
    }
    Ok(())
}

impl Desktop {
    fn new(root: PathBuf, mcp: PathBuf, allowed_port: Arc<AtomicU16>) -> Result<Self> {
        fs::create_dir_all(root.join("projects/default"))?;
        fs::create_dir_all(root.join("logs"))?;
        let default = root.join("projects/default");
        let mut settings = json!({"schemaVersion":1,"port":3000,"activeProjectFolder":default,
            "recentProjects":[{"folder":default,"aiWorkdir":null,"lastUsedAt":chrono::Utc::now().to_rfc3339()}]});
        let mut repair = false;
        if root.join("settings.json").exists() {
            match fs::read(root.join("settings.json"))
                .map_err(AppError::from)
                .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
                .and_then(|v| {
                    validate_settings(&v)?;
                    Ok(v)
                }) {
                Ok(v) => settings = v,
                Err(_) => repair = true,
            }
        }
        let env_port = std::env::var("WALL_PORT")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<u16>())
            .transpose()
            .map_err(|_| AppError::new(400, "WALL_PORT must be an integer from 0 to 65535"))?;
        for (client, key) in [("claude", "WALL_CLAUDE_BIN"), ("codex", "WALL_CODEX_BIN")] {
            if std::env::var_os(key).is_none() {
                if let Some(path) = settings["cliPaths"][client].as_str().filter(|p| !p.is_empty()) {
                    std::env::set_var(key, path);
                }
            }
        }
        Ok(Self {
            settings,
            root,
            mcp,
            allowed_port,
            server: None,
            env_port,
            override_port: None,
            repair,
            status: "starting".into(),
            message: "正在啟動本機服務…".into(),
            error: None,
            apply_error: Value::Null,
            cli_opened: false,
            stale_clients: false,
        })
    }
    fn project(&self) -> PathBuf {
        PathBuf::from(self.settings["activeProjectFolder"].as_str().unwrap())
    }
    fn ai_workdir(&self) -> Option<PathBuf> {
        self.settings["recentProjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| {
                path_key(Path::new(r["folder"].as_str().unwrap())) == path_key(&self.project())
            })
            .and_then(|r| r["aiWorkdir"].as_str())
            .map(PathBuf::from)
    }
    fn workdir(&self) -> PathBuf {
        self.ai_workdir()
            .unwrap_or_else(|| self.project().join("chat-workdir"))
    }
    fn log(&self, message: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("logs/main.log"))
        {
            let _ = writeln!(file, "[{}] {message}", chrono::Utc::now().to_rfc3339());
        }
    }
    fn state(&self) -> Value {
        let logs = (|| -> std::io::Result<Vec<String>> {
            let mut file = fs::File::open(self.root.join("logs/main.log"))?;
            let size = file.metadata()?.len();
            file.seek(SeekFrom::Start(size.saturating_sub(65536)))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<_> = text
                .lines()
                .skip(if size > 65536 { 1 } else { 0 })
                .map(str::to_owned)
                .collect();
            Ok(lines[lines.len().saturating_sub(200)..].to_vec())
        })()
        .unwrap_or_default();
        let mut clients = json!({});
        for name in ["claude", "codex"] {
            let path = chat::cli_path(name);
            clients[name] = json!({"available":path.is_some(),"path":path});
        }
        let port = self.server.as_ref().map(|s| s.port);
        json!({"status":self.status,"message":self.message,"error":self.error,"configuredPort":self.settings["port"],"effectivePort":port,
            "port":port.map(|p| json!(p)).unwrap_or(self.settings["port"].clone()),"activeProjectFolder":self.project(),"dbPath":self.project().join("wall.db"),
            "settingsPath":self.root.join("settings.json"),"settingsNeedsRepair":self.repair,"settings":self.settings,"recentProjects":self.settings["recentProjects"],
            "aiWorkdir":self.ai_workdir(),"effectiveAiWorkdir":self.workdir(),"defaultProjectFolder":self.root.join("projects/default"),
            "chatActive":self.server.as_ref().map(|s| s.chat.has_active()).unwrap_or(false),"clients":clients,"staleClients":self.stale_clients,
            "lastApplyError":self.apply_error,"logPath":self.root.join("logs/main.log"),"logs":logs,"nodeVersion":null,"electronVersion":null})
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let _ = app.emit_to("main", "casegraph:state-changed", self.state());
        if let Some(tray) = app.tray_by_id("casegraph") {
            if let Ok(menu) = tray_menu(app, self.server.is_some()) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
    fn persist(&self) -> Result<()> {
        let temporary = self
            .root
            .join(format!("settings.json.tmp-{}", std::process::id()));
        let mut file = fs::File::create(&temporary)?;
        file.write_all(serde_json::to_string_pretty(&self.settings)?.as_bytes())?;
        file.sync_all()?;
        fs::rename(temporary, self.root.join("settings.json"))?;
        Ok(())
    }
    fn navigate(&self, app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let url = match self.server.as_ref() {
                Some(s) => format!("http://127.0.0.1:{}/", s.port),
                None => {
                    if cfg!(windows) {
                        "http://tauri.localhost/status.html".into()
                    } else {
                        "tauri://localhost/status.html".into()
                    }
                }
            };
            if let Ok(url) = url.parse() {
                app.state::<RendererReady>()
                    .0
                    .store(false, Ordering::SeqCst);
                let _ = window.navigate(url);
            }
        }
    }
    async fn start(&mut self, app: &tauri::AppHandle, persist: bool) -> Result<()> {
        if self.server.is_some() {
            return Ok(());
        }
        let port = self
            .override_port
            .or(self.env_port)
            .unwrap_or(self.settings["port"].as_u64().unwrap() as u16);
        self.status = "starting".into();
        self.message = "正在啟動本機服務…".into();
        self.publish(app);
        match server::start(
            self.project().join("wall.db"),
            port,
            Some(self.workdir()),
            self.mcp.clone(),
        )
        .await
        {
            Ok(server) => {
                self.allowed_port.store(server.port, Ordering::SeqCst);
                self.message = format!("服務已就緒，埠 {}", server.port);
                self.status = "running".into();
                self.error = None;
                self.server = Some(server);
                self.cli_opened = false;
                if persist && !self.repair {
                    let current = path_key(&self.project());
                    if let Some(recent) = self.settings["recentProjects"].as_array_mut() {
                        if let Some(index) = recent.iter().position(|row| {
                            path_key(Path::new(row["folder"].as_str().unwrap())) == current
                        }) {
                            let mut row = recent.remove(index);
                            row["lastUsedAt"] = json!(chrono::Utc::now().to_rfc3339());
                            recent.insert(0, row);
                        }
                    }
                    if let Err(error) = self.persist() {
                        self.log(&format!("設定保存失敗：{error}"));
                    }
                }
            }
            Err(error) => {
                self.status = if error.status == 409 {
                    "port-occupied"
                } else {
                    "error"
                }
                .into();
                self.message = format!("服務啟動失敗：{error}");
                self.error = Some(error.to_string());
                self.log(&self.message);
                self.publish(app);
                self.navigate(app);
                return Err(error);
            }
        }
        self.log(&self.message);
        self.publish(app);
        self.navigate(app);
        Ok(())
    }
    async fn stop(&mut self, app: &tauri::AppHandle, navigate: bool) {
        self.status = "stopping".into();
        self.message = "正在停止本機服務…".into();
        self.publish(app);
        if let Some(server) = self.server.take() {
            server.stop().await;
        }
        self.allowed_port.store(0, Ordering::SeqCst);
        self.status = "stopped".into();
        self.message = "服務已停止".into();
        self.log(&self.message);
        self.publish(app);
        if navigate {
            self.navigate(app);
        }
    }
    async fn action(&mut self, app: &tauri::AppHandle, action: &str) -> Result<Value> {
        match action {
            "start" => self.start(app, true).await?,
            "stop" => {
                self.override_port = None;
                self.stop(app, true).await;
            }
            "restart" | "useFreePort" => {
                self.override_port = if action == "useFreePort" {
                    Some(0)
                } else {
                    None
                };
                self.stop(app, false).await;
                self.start(app, true).await?;
            }
            _ => return Err(AppError::new(400, "invalid service action")),
        }
        Ok(self.state())
    }
    async fn apply(&mut self, app: &tauri::AppHandle, input: Value) -> Result<Value> {
        let port = input["port"]
            .as_u64()
            .filter(|p| (1024..=65535).contains(p))
            .ok_or_else(|| AppError::new(400, "請輸入 1024–65535 的整數"))?;
        let project = folder(&input["activeProjectFolder"], "目前專案")?;
        let cwd = if input["aiWorkdir"].is_null() {
            None
        } else {
            Some(folder(&input["aiWorkdir"], "AI 工作資料夾")?)
        };
        if cwd
            .as_ref()
            .is_some_and(|p| path_key(p) == path_key(&project.join("wall.db")))
        {
            return Err(AppError::new(400, "AI 工作資料夾不能是 wall.db"));
        }
        let changed = port != self.settings["port"].as_u64().unwrap()
            || path_key(&project) != path_key(&self.project())
            || cwd.as_ref().map(|p| path_key(p)) != self.ai_workdir().as_ref().map(|p| path_key(p));
        if !changed && !self.repair {
            self.apply_error = Value::Null;
            return Ok(self.state());
        }
        // Validate/create the requested directories before stopping the active database.
        fs::create_dir_all(&project)?;
        if let Some(path) = &cwd {
            fs::create_dir_all(path)?;
        }
        let previous = (
            self.settings.clone(),
            self.repair,
            self.env_port,
            self.override_port,
            self.cli_opened,
            self.stale_clients,
            self.server.is_some(),
        );
        let mut recent: Vec<Value> = self.settings["recentProjects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| path_key(Path::new(r["folder"].as_str().unwrap())) != path_key(&project))
            .cloned()
            .collect();
        recent.insert(
            0,
            json!({"folder":project,"aiWorkdir":cwd,"lastUsedAt":chrono::Utc::now().to_rfc3339()}),
        );
        recent.truncate(10);
        if changed {
            self.stop(app, false).await;
        }
        if self.settings["port"] != port {
            self.env_port = None;
        }
        self.settings["port"] = json!(port);
        self.settings["activeProjectFolder"] = json!(project);
        self.settings["recentProjects"] = json!(recent);
        self.repair = false;
        self.override_port = None;
        let result = self.start(app, false).await.and_then(|_| self.persist());
        if let Err(error) = result {
            if changed || !previous.6 {
                self.stop(app, false).await;
            }
            self.settings = previous.0;
            self.repair = previous.1;
            self.env_port = previous.2;
            self.override_port = previous.3;
            if previous.6 {
                let _ = self.start(app, false).await;
            }
            self.cli_opened = previous.4;
            self.stale_clients = previous.5;
            self.apply_error =
                json!({"message":error.to_string(),"at":chrono::Utc::now().to_rfc3339()});
            self.log(&format!("設定套用失敗：{error}"));
            self.publish(app);
            return Err(error);
        }
        self.stale_clients = changed && previous.4;
        self.apply_error = Value::Null;
        self.publish(app);
        Ok(self.state())
    }
    async fn open_client(&mut self, app: &tauri::AppHandle, client: &str) -> Result<Value> {
        if !["claude", "codex"].contains(&client) {
            return Err(AppError::new(400, "client must be claude or codex"));
        }
        if self.status == "port-occupied" {
            self.override_port = Some(0);
        }
        self.start(app, false).await?;
        chat::open_client(
            client,
            &self.project().join("wall.db"),
            self.server.as_ref().unwrap().port,
            &self.workdir(),
            &self.root.join("runtime"),
            &self.mcp,
        )
        .await?;
        self.cli_opened = true;
        self.stale_clients = false;
        self.log(&format!("已開啟 {client} CLI"));
        self.publish(app);
        Ok(self.state())
    }
    async fn request_settings(&mut self, app: &tauri::AppHandle) -> Result<Value> {
        app.state::<OpenSettings>().0.store(true, Ordering::SeqCst);
        if self.status == "port-occupied" {
            self.override_port = Some(0);
        }
        self.start(app, false).await?;
        if let Some(window) = app.get_webview_window("main") {
            let wall = window.url().ok().is_some_and(|u| {
                u.host_str() == Some("127.0.0.1")
                    && u.port() == self.server.as_ref().map(|s| s.port)
            });
            if !wall {
                self.navigate(app);
            } else if app.state::<RendererReady>().0.load(Ordering::SeqCst) {
                app.state::<OpenSettings>().0.store(false, Ordering::SeqCst);
                let _ = app.emit_to("main", "casegraph:open-settings", ());
            }
        }
        show(app);
        Ok(self.state())
    }
}

fn valid_sender(window: &WebviewWindow, desktop: &Desktop) -> std::result::Result<(), String> {
    if window.label() != "main" {
        return Err("invalid IPC sender".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    let local_status = (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        && url.path() == "/status.html";
    let wall = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && desktop
            .server
            .as_ref()
            .is_some_and(|s| url.port() == Some(s.port))
        && ["/", "/index.html"].contains(&url.path());
    if local_status || wall {
        Ok(())
    } else {
        Err("invalid IPC origin".into())
    }
}

#[tauri::command]
async fn get_state(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> std::result::Result<Value, String> {
    let desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    Ok(desktop.state())
}
#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    input: Value,
) -> std::result::Result<Value, String> {
    let mut desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    desktop.apply(&app, input).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn service(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    action: String,
) -> std::result::Result<Value, String> {
    let mut desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    desktop
        .action(&app, &action)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_client(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    client: String,
) -> std::result::Result<Value, String> {
    let mut desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    desktop
        .open_client(&app, &client)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn clear_apply_error(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> std::result::Result<Value, String> {
    let mut desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    desktop.apply_error = Value::Null;
    desktop.publish(&app);
    Ok(desktop.state())
}
#[tauri::command]
async fn pick_directory(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    kind: String,
) -> std::result::Result<Value, String> {
    let directory = {
        let desktop = state.0.lock().await;
        valid_sender(&window, &desktop)?;
        match kind.as_str() {
            "project" => desktop.project(),
            "aiWorkdir" => desktop.workdir(),
            _ => return Err("invalid directory kind".into()),
        }
    };
    let result = rfd::AsyncFileDialog::new()
        .set_directory(directory)
        .pick_folder()
        .await;
    Ok(json!({"canceled":result.is_none(),"path":result.map(|p| p.path().to_path_buf())}))
}
#[tauri::command]
async fn open_log_folder(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> std::result::Result<(), String> {
    let desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    app.opener()
        .open_path(
            desktop.root.join("logs").to_string_lossy().to_string(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> std::result::Result<Value, String> {
    let mut desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    desktop
        .request_settings(&app)
        .await
        .map_err(|e| e.to_string())
}
struct OpenSettings(AtomicBool);
struct RendererReady(AtomicBool);
#[tauri::command]
async fn renderer_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> std::result::Result<(), String> {
    let desktop = state.0.lock().await;
    valid_sender(&window, &desktop)?;
    if window.url().map_err(|e| e.to_string())?.host_str() == Some("127.0.0.1") {
        app.state::<RendererReady>().0.store(true, Ordering::SeqCst);
        if app.state::<OpenSettings>().0.swap(false, Ordering::SeqCst) {
            let _ = app.emit_to("main", "casegraph:open-settings", ());
        }
    }
    Ok(())
}
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
fn tray_menu(app: &tauri::AppHandle, running: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let entries = [
        ("show", "顯示 CaseGraph"),
        ("settings", "設定…"),
        ("restart", "重新啟動服務"),
        ("start", "啟動服務"),
        ("stop", "停止服務"),
        ("claude", "開啟 Claude CLI"),
        ("codex", "開啟 codex CLI"),
        ("logs", "開啟紀錄資料夾"),
        ("quit", "結束"),
    ];
    let items: Vec<_> = entries
        .iter()
        .map(|(id, text)| {
            let available = match *id {
                "claude" | "codex" => chat::cli_path(id).is_some(),
                "start" => !running,
                "stop" => running,
                _ => true,
            };
            let label = if !available && ["claude", "codex"].contains(id) {
                format!("{text}（找不到）")
            } else {
                text.to_string()
            };
            MenuItem::with_id(app, *id, label, available, None::<&str>)
        })
        .collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
        .collect();
    Menu::with_items(app, &refs)
}

pub fn run() {
    let quitting = Arc::new(AtomicBool::new(false));
    let close_flag = quitting.clone();
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(OpenSettings(AtomicBool::new(false)))
        .manage(RendererReady(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_settings,
            service,
            open_client,
            clear_apply_error,
            pick_directory,
            open_log_folder,
            open_settings,
            renderer_ready
        ])
        .setup(move |app| {
            let root = crate::setup::data_root(std::env::current_exe()?.parent().unwrap())?;
            let beside = std::env::current_exe()?.with_file_name("casegraph-mcp.exe");
            let mcp = if beside.is_file() {
                beside
            } else {
                app.path().resource_dir()?.join("casegraph-mcp.exe")
            };
            let allowed = Arc::new(AtomicU16::new(0));
            let desktop = Desktop::new(
                root,
                mcp,
                allowed.clone(),
            )?;
            let appearance = desktop.settings["appearance"].clone();
            app.manage(DesktopState(Mutex::new(desktop)));
            let navigation_app = app.handle().clone();
            let external_app = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("status.html".into()))
                    .title("CaseGraph 案件圖譜")
                    .inner_size(1280.0, 800.0)
                    .initialization_script(format!(r#"
                        (() => {{
                            if (location.hostname !== '127.0.0.1') return;
                            const a = {appearance};
                            if (!a || !a.id || localStorage.getItem('casegraph-install-appearance') === a.id) return;
                            const values = {{'thesis-detective-wall-theme':a.theme,
                                'thesis-detective-wall-card-style':a.cardStyle,
                                'thesis-detective-wall-mascot-visible':a.mascotVisible ? '1' : '0',
                                'casegraph-reduce-motion':a.reduceMotion ? '1' : '0'}};
                            for (const [key, value] of Object.entries(values)) {{
                                if (a.replace || localStorage.getItem(key) === null) localStorage.setItem(key, value);
                            }}
                            localStorage.setItem('casegraph-install-appearance', a.id);
                        }})();
                    "#))
                    .on_navigation(move |url| {
                        let status = (url.host_str() == Some("tauri.localhost")
                            || url.scheme() == "tauri")
                            && url.path() == "/status.html";
                        let wall = url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(allowed.load(Ordering::SeqCst))
                            && ["/", "/index.html"].contains(&url.path());
                        if status || wall {
                            true
                        } else {
                            if ["http", "https"].contains(&url.scheme()) {
                                let _ =
                                    navigation_app.opener().open_url(url.as_str(), None::<&str>);
                            }
                            false
                        }
                    })
                    .on_new_window(move |url, _| {
                        if ["http", "https"].contains(&url.scheme()) {
                            let _ = external_app.opener().open_url(url.as_str(), None::<&str>);
                        }
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                            window
                                .state::<RendererReady>()
                                .0
                                .store(false, Ordering::SeqCst);
                        }
                    })
                    .build()?;
            let hide = window.clone();
            let hidden_notice = AtomicBool::new(false);
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !close_flag.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = hide.hide();
                        if !hidden_notice.swap(true, Ordering::SeqCst) {
                            let _ = hide
                                .app_handle()
                                .notification()
                                .builder()
                                .title("CaseGraph 案件圖譜")
                                .body("CaseGraph 已隱藏到系統匣。")
                                .show();
                        }
                    }
                }
            });
            let menu = tray_menu(app.handle(), false)?;
            TrayIconBuilder::with_id("casegraph")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("CaseGraph 案件圖譜")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    let action = event.id.as_ref().to_string();
                    if action == "show" {
                        show(app);
                        return;
                    }
                    if action == "quit" {
                        app.exit(0);
                        return;
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<DesktopState>();
                        let mut desktop = state.0.lock().await;
                        let result = match action.as_str() {
                            "settings" => desktop.request_settings(&app).await,
                            "claude" | "codex" => desktop.open_client(&app, &action).await,
                            "logs" => app
                                .opener()
                                .open_path(
                                    desktop.root.join("logs").to_string_lossy().to_string(),
                                    None::<&str>,
                                )
                                .map(|_| Value::Null)
                                .map_err(|e| AppError::new(500, e.to_string())),
                            _ => desktop.action(&app, &action).await,
                        };
                        if let Err(e) = result {
                            desktop.log(&e.to_string());
                        }
                    });
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<DesktopState>();
                let mut desktop = state.0.lock().await;
                let _ = desktop.start(&handle, true).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CaseGraph desktop initialization failed");
    application.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !quitting.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    {
                        let state = app.state::<DesktopState>();
                        state.0.lock().await.stop(&app, false).await;
                    }
                    app.exit(0);
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_settings_are_read_without_rewriting_corrupt_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("CaseGraph");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("settings.json"), b"broken").unwrap();
        let desktop = Desktop::new(
            path.clone(),
            "casegraph-mcp.exe".into(),
            Arc::new(AtomicU16::new(0)),
        )
        .unwrap();
        assert!(desktop.repair);
        assert_eq!(fs::read(path.join("settings.json")).unwrap(), b"broken");
        desktop.persist().unwrap();
        let restored = Desktop::new(
            path,
            "casegraph-mcp.exe".into(),
            Arc::new(AtomicU16::new(0)),
        )
        .unwrap();
        assert!(!restored.repair);
        assert_eq!(restored.project(), desktop.project());
        #[cfg(windows)]
        assert_eq!(
            path_key(&temporary.path().join("unused/../CaseGraph")),
            path_key(&temporary.path().join("CaseGraph"))
        );
    }
}
