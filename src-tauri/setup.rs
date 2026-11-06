//! Installer operations share the production SQLite and CLI implementations.
//! The NSIS request is UTF-16 INI; installed settings remain the existing JSON format.
use crate::{chat, db::Database, AppError, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const LOCATOR: &str = "casegraph-install.json";
type Request = BTreeMap<String, String>;

fn absolute(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.contains(['\r', '\n', '\0']) {
        return Err(AppError::new(400, "請指定完整的絕對路徑"));
    }
    Ok(std::path::absolute(path)?)
}

pub fn legacy_root() -> PathBuf {
    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("CaseGraph/CaseGraph")
}

pub fn data_root(install: &Path) -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("CASEGRAPH_USER_DATA") {
        return Ok(PathBuf::from(root).join("CaseGraph"));
    }
    let locator = install.join(LOCATOR);
    if locator.exists() {
        let config: Value = serde_json::from_slice(&fs::read(locator)?)?;
        return absolute(config["dataRoot"].as_str().unwrap_or(""));
    }
    if cfg!(debug_assertions) {
        return Ok(
            PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
                .join("detective-wall/CaseGraph"),
        );
    }
    let legacy = legacy_root();
    Ok(if legacy.join("settings.json").exists() {
        legacy
    } else {
        install.join("data")
    })
}

fn read_settings(root: &Path) -> Result<Value> {
    let path = root.join("settings.json");
    if path.exists() {
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    } else {
        Ok(json!({}))
    }
}

fn read_request(path: &Path) -> Result<Request> {
    let bytes = fs::read(path)?;
    let text = if bytes.starts_with(&[255, 254]) {
        String::from_utf16(
            &bytes[2..]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| AppError::new(400, "安裝設定編碼無效"))?
    } else {
        String::from_utf8(bytes).map_err(|_| AppError::new(400, "安裝設定編碼無效"))?
    };
    Ok(text
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().into(), v.trim().trim_matches('"').into()))
        .collect())
}

fn write_request(path: &Path, request: &Request) -> Result<()> {
    let mut text = String::from("\u{feff}[setup]\r\n");
    for (key, value) in request {
        text.push_str(&format!("{key}={value}\r\n"));
    }
    fs::write(
        path,
        text.encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )?;
    Ok(())
}

fn value<'a>(request: &'a Request, key: &str) -> &'a str {
    request.get(key).map(String::as_str).unwrap_or("")
}

fn inspect(install: &Path, old_root: &Path) -> Result<Request> {
    let locator = install.join(LOCATOR);
    let old_root = if locator.exists() {
        let config: Value = serde_json::from_slice(&fs::read(locator)?)?;
        absolute(config["dataRoot"].as_str().unwrap_or(""))?
    } else {
        old_root.to_path_buf()
    };
    let settings = read_settings(&old_root)?;
    let old_project = settings["activeProjectFolder"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| old_root.join("projects/default"));
    let has_old = old_root.join("settings.json").exists() || old_project.join("wall.db").exists();
    let root = if has_old {
        old_root.clone()
    } else {
        install.join("data")
    };
    let project = if has_old {
        old_project.clone()
    } else {
        root.join("projects/default")
    };
    let ai_workdir = settings["recentProjects"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| r["folder"].as_str() == settings["activeProjectFolder"].as_str())
        })
        .and_then(|r| r["aiWorkdir"].as_str())
        .unwrap_or("");
    let mut request: Request = [
        ("install", install.to_string_lossy().into_owned()),
        ("root", root.to_string_lossy().into_owned()),
        ("project", project.to_string_lossy().into_owned()),
        (
            "oldRoot",
            if has_old {
                old_root.to_string_lossy().into_owned()
            } else {
                String::new()
            },
        ),
        (
            "oldProject",
            if has_old {
                old_project.to_string_lossy().into_owned()
            } else {
                String::new()
            },
        ),
        ("mode", if has_old { "reuse" } else { "new" }.into()),
        (
            "port",
            settings["port"].as_u64().unwrap_or(3000).to_string(),
        ),
        ("aiWorkdir", ai_workdir.into()),
        (
            "claude",
            settings["cliPaths"]["claude"].as_str().unwrap_or("").into(),
        ),
        (
            "codex",
            settings["cliPaths"]["codex"].as_str().unwrap_or("").into(),
        ),
        ("registerMcp", "0".into()),
        ("scope", String::new()),
        ("aiProposals", "0".into()),
        ("appearance", "0".into()),
        ("theme", "paper".into()),
        ("cardStyle", "paper".into()),
        ("mascotVisible", "1".into()),
        ("reduceMotion", "0".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    // The installer displays existing choices instead of silently resetting an upgrade.
    if old_project.join("wall.db").exists() {
        let db = Database::open(&old_project.join("wall.db"), true)?;
        request.insert(
            "aiProposals".into(),
            if db.get_meta("aiProposals")? == Value::Bool(true) {
                "1"
            } else {
                "0"
            }
            .into(),
        );
    }
    Ok(request)
}

fn validate(request: &Request) -> Result<()> {
    let install = absolute(value(request, "install"))?;
    let root = absolute(value(request, "root"))?;
    let project = absolute(value(request, "project"))?;
    let port = value(request, "port")
        .parse::<u16>()
        .ok()
        .filter(|p| *p >= 1024);
    if port.is_none() {
        return Err(AppError::new(400, "服務埠必須是 1024–65535"));
    }
    for key in ["aiWorkdir", "claude", "codex"] {
        if !value(request, key).is_empty() {
            let path = absolute(value(request, key))?;
            if key != "aiWorkdir" && !path.is_file() {
                return Err(AppError::new(400, format!("找不到 {key} 執行檔")));
            }
            if key == "aiWorkdir"
                && (path == project.join("wall.db") || (path.exists() && !path.is_dir()))
            {
                return Err(AppError::new(400, "AI 工作資料夾不是目錄"));
            }
        }
    }
    if !["reuse", "move", "new"].contains(&value(request, "mode")) {
        return Err(AppError::new(400, "請選擇舊資料處理方式"));
    }
    if value(request, "mode") == "reuse" {
        if root != absolute(value(request, "oldRoot"))?
            || project != absolute(value(request, "oldProject"))?
        {
            return Err(AppError::new(
                400,
                "沿用舊資料時請保留舊路徑；要更換位置請選擇搬移",
            ));
        }
    } else {
        if project.join("wall.db").exists() || root.join("settings.json").exists() {
            return Err(AppError::new(
                409,
                "目的地已有資料或設定，請改用新的資料夾；不會覆蓋既有資料",
            ));
        }
        if value(request, "mode") == "move"
            && !absolute(value(request, "oldProject"))?
                .join("wall.db")
                .is_file()
        {
            return Err(AppError::new(400, "找不到要搬移的舊資料庫"));
        }
    }
    if !["whiteboard", "wood", "paper", "cork", "moon", "cyber"].contains(&value(request, "theme"))
        || !["tech", "paper"].contains(&value(request, "cardStyle"))
    {
        return Err(AppError::new(400, "外觀選項無效"));
    }
    if value(request, "registerMcp") == "1"
        && chat::resolve_cli("codex", Some(value(request, "codex"))).is_none()
    {
        return Err(AppError::new(
            400,
            "找不到 Codex CLI，請指定執行檔，或取消 MCP 設定選項",
        ));
    }
    // Validate write access before any database copy or installation settings change.
    for path in [&install, &root, &project] {
        fs::create_dir_all(path)?;
        let probe = path.join(format!(".casegraph-write-check-{}", uuid::Uuid::new_v4()));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?
            .sync_all()?;
        fs::remove_file(probe)?;
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn apply(request: &Request) -> Result<Value> {
    validate(request)?;
    let install = absolute(value(request, "install"))?;
    let root = absolute(value(request, "root"))?;
    let project = absolute(value(request, "project"))?;
    let mode = value(request, "mode");
    let mut settings = if mode == "new" {
        json!({})
    } else {
        read_settings(&absolute(value(request, "oldRoot"))?)?
    };
    let db_path = project.join("wall.db");
    if mode == "move" {
        let source = absolute(value(request, "oldProject"))?.join("wall.db");
        let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // VACUUM INTO includes committed WAL data and preserves tables unknown to this release.
        source.execute("VACUUM INTO ?1", [db_path.to_string_lossy().as_ref()])?;
        let old_log = absolute(value(request, "oldRoot"))?.join("logs/main.log");
        if old_log.is_file() {
            fs::create_dir_all(root.join("logs"))?;
            fs::copy(old_log, root.join("logs/main.log"))?;
        }
    }
    let db = Database::open(&db_path, false)?;
    db.set_meta("aiProposals", &json!(value(request, "aiProposals") == "1"))?;
    drop(db);
    let old_project = settings["activeProjectFolder"].clone();
    let mut recent = settings["recentProjects"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    recent.retain(|row| row["folder"] != old_project && row["folder"] != json!(project));
    recent.insert(0, json!({"folder":project,"aiWorkdir":if value(request,"aiWorkdir").is_empty() { Value::Null } else { json!(value(request,"aiWorkdir")) },"lastUsedAt":chrono::Utc::now().to_rfc3339()}));
    recent.truncate(10);
    settings["schemaVersion"] = json!(1);
    settings["port"] = json!(value(request, "port").parse::<u16>().unwrap());
    settings["activeProjectFolder"] = json!(project);
    settings["recentProjects"] = json!(recent);
    settings["cliPaths"] = json!({"claude":value(request,"claude"),"codex":value(request,"codex")});
    if value(request, "appearance") == "1" || settings.get("appearance").is_none() {
        settings["appearance"] = json!({"id":uuid::Uuid::new_v4().to_string(),"replace":value(request,"appearance")=="1","theme":value(request,"theme"),"cardStyle":value(request,"cardStyle"),"mascotVisible":value(request,"mascotVisible")=="1","reduceMotion":value(request,"reduceMotion")=="1"});
    }
    fs::create_dir_all(root.join("logs"))?;
    write_json(&root.join("settings.json"), &settings)?;
    // Commit the locator last; an unsuccessful migration never redirects the existing app.
    write_json(&install.join(LOCATOR), &json!({"dataRoot":root}))?;
    Ok(settings)
}

fn remove_data(install: &Path) -> Result<()> {
    let locator: Value = serde_json::from_slice(&fs::read(install.join(LOCATOR))?)?;
    let root = absolute(locator["dataRoot"].as_str().unwrap_or(""))?;
    let settings = read_settings(&root)?;
    let mut projects = Vec::new();
    if let Some(rows) = settings["recentProjects"].as_array() {
        for row in rows {
            let path = absolute(row["folder"].as_str().unwrap_or(""))?;
            if !projects.contains(&path) {
                projects.push(path);
            }
        }
    }
    for project in projects {
        for name in ["wall.db", "wall.db-wal", "wall.db-shm"] {
            let path = project.join(name);
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    for path in [
        root.join("settings.json"),
        root.join("logs/main.log"),
        install.join(LOCATOR),
    ] {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    // Custom project folders can contain source files: never recursively delete their contents.
    Ok(())
}

pub async fn command() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let result = command_inner().await;
    let output = if args.get(2).map(String::as_str) == Some("inspect") {
        args.get(4)
    } else {
        args.get(3)
    };
    if let Some(path) = output.filter(|_| args.get(2).map(String::as_str) != Some("remove-data")) {
        let mut receipt = Request::new();
        receipt.insert(
            "error".into(),
            result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default()
                .replace(['\r', '\n'], " "),
        );
        let _ = write_request(&Path::new(path).with_extension("result.ini"), &receipt);
    }
    result
}

async fn command_inner() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let operation = args.get(2).map(String::as_str).unwrap_or("");
    let path = args
        .get(3)
        .map(PathBuf::from)
        .ok_or_else(|| AppError::new(400, "缺少安裝設定路徑"))?;
    match operation {
        "inspect" => {
            let out = args
                .get(4)
                .map(PathBuf::from)
                .ok_or_else(|| AppError::new(400, "缺少輸出位置"))?;
            let previous = args.get(5).filter(|p| !p.is_empty()).map(PathBuf::from);
            let previous_locator = previous.map(|p| p.join(LOCATOR));
            let fallback = if let Some(locator) = previous_locator.filter(|p| p.is_file()) {
                let config: Value = serde_json::from_slice(&fs::read(locator)?)?;
                absolute(config["dataRoot"].as_str().unwrap_or(""))?
            } else {
                legacy_root()
            };
            write_request(
                &out,
                &inspect(&absolute(&path.to_string_lossy())?, &fallback)?,
            )?;
        }
        "validate" => validate(&read_request(&path)?)?,
        "apply" => {
            let request = read_request(&path)?;
            let settings = apply(&request)?;
            if value(&request, "registerMcp") == "1" {
                let install = absolute(value(&request, "install"))?;
                let command = chat::resolve_cli("codex", Some(value(&request, "codex")))
                    .ok_or_else(|| AppError::new(400, "找不到 Codex CLI"))?;
                chat::register_mcp(
                    &command,
                    &install.join("casegraph-mcp.exe"),
                    &absolute(value(&request, "project"))?.join("wall.db"),
                    settings["port"].as_u64().unwrap() as u16,
                    value(&request, "scope"),
                )
                .await?;
            }
        }
        "remove-data" => remove_data(&path)?,
        _ => return Err(AppError::new(400, "未知安裝操作")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_migrate_and_remove_only_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("程式 空白");
        let legacy = temp.path().join("舊資料");
        let mut request = inspect(&install, &legacy).unwrap();
        assert_eq!(value(&request, "mode"), "new");
        let ini = temp.path().join("request.ini");
        write_request(&ini, &request).unwrap();
        assert_eq!(read_request(&ini).unwrap(), request);
        request.insert("port".into(), "80".into());
        assert!(apply(&request).is_err());
        request.insert("port".into(), "3100".into());
        request.insert(
            "aiWorkdir".into(),
            Path::new(value(&request, "project"))
                .join("wall.db")
                .to_string_lossy()
                .into(),
        );
        assert!(
            apply(&request).is_err(),
            "AI workdir cannot be the database file"
        );
        request.insert("aiWorkdir".into(), String::new());
        request.insert("appearance".into(), "1".into());
        request.insert("theme".into(), "moon".into());
        request.insert("aiProposals".into(), "1".into());
        let settings = apply(&request).unwrap();
        assert_eq!(settings["appearance"]["theme"], "moon");
        assert!(
            apply(&request).is_err(),
            "new install cannot overwrite a DB"
        );
        let old_project = PathBuf::from(value(&request, "project"));
        let old_db = Connection::open(old_project.join("wall.db")).unwrap();
        old_db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE future_data(value); INSERT INTO future_data VALUES ('保留 WAL 資料');").unwrap();
        let mut request = inspect(&install, &legacy).unwrap();
        assert_eq!(value(&request, "mode"), "reuse");
        assert_eq!(value(&request, "aiProposals"), "1");
        request.insert("mode".into(), "move".into());
        request.insert(
            "root".into(),
            temp.path().join("新設定").to_string_lossy().into(),
        );
        request.insert(
            "project".into(),
            temp.path().join("新資料").to_string_lossy().into(),
        );
        let moved = apply(&request).unwrap();
        assert_eq!(moved["appearance"], settings["appearance"]);
        let project = PathBuf::from(value(&request, "project"));
        let db = Connection::open(project.join("wall.db")).unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM future_data", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "保留 WAL 資料"
        );
        drop(db);
        fs::write(project.join("user-source.txt"), "keep").unwrap();
        remove_data(&install).unwrap();
        assert!(!project.join("wall.db").exists());
        assert!(project.join("user-source.txt").exists());
        assert!(
            old_project.join("wall.db").exists(),
            "migration keeps source backup"
        );
    }
}
