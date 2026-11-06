//! SQLite storage preserving the existing wall.db schema and project JSON format.
pub use crate::proposals::{
    normalize_proposal_ops, normalize_tabs_meta, proposal_payload, safe_source_href,
    validate_proposal,
};
use crate::{layout, proposals};
use crate::{AppError, Result};
use rusqlite::{
    params, params_from_iter, types::ValueRef, Connection, OpenFlags, OptionalExtension, Params,
};
use serde_json::{json, Map, Value};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS walls(id TEXT PRIMARY KEY,name TEXT NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,data JSON NOT NULL);
CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,record JSON NOT NULL);
CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY AUTOINCREMENT,wall_id TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT NOT NULL,cards INTEGER NOT NULL,edges INTEGER NOT NULL,data JSON NOT NULL);
CREATE INDEX IF NOT EXISTS backups_wall_id_id ON backups(wall_id,id);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value JSON NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,wall_id TEXT NOT NULL,base_version INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,client TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,rationale TEXT NOT NULL,ops JSON NOT NULL,base_cards JSON NOT NULL,op_status JSON NOT NULL);
CREATE INDEX IF NOT EXISTS proposals_wall_status ON proposals(wall_id,status,created);
CREATE INDEX IF NOT EXISTS proposals_status_created_id ON proposals(status,created,id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,proposal_id TEXT,wall_id TEXT NOT NULL,before_version INTEGER NOT NULL,after_version INTEGER NOT NULL,affected JSON NOT NULL,before JSON NOT NULL,after JSON NOT NULL,reverted_at INTEGER);
CREATE INDEX IF NOT EXISTS audit_wall_id_id ON audit(wall_id,id);
CREATE INDEX IF NOT EXISTS audit_proposal_id_id ON audit(proposal_id,id);
CREATE TABLE IF NOT EXISTS chat_sessions(wall_id TEXT NOT NULL,client TEXT NOT NULL,session_id TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(wall_id,client));
CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,wall_id TEXT NOT NULL,client TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,error TEXT,status TEXT);
CREATE INDEX IF NOT EXISTS chat_messages_wall_client_id ON chat_messages(wall_id,client,id);
"#;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn conflict() -> AppError {
    AppError::new(409, "wall version conflict")
}
fn rows(conn: &Connection, sql: &str, values: impl Params) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let result = stmt
        .query_map(values, |row| {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    ValueRef::Blob(_) => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            i,
                            name.clone(),
                            rusqlite::types::Type::Blob,
                        ))
                    }
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}
fn one(conn: &Connection, sql: &str, values: impl Params) -> Result<Value> {
    Ok(rows(conn, sql, values)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}
fn parse_fields(mut row: Value, fields: &[&str]) -> Result<Value> {
    if row.is_object() {
        for field in fields {
            if let Some(text) = row[*field].as_str() {
                row[*field] = serde_json::from_str(text)?;
            }
        }
    }
    Ok(row)
}
fn transaction<T>(conn: &Connection, action: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match action() {
        Ok(v) => {
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
pub struct Database {
    conn: Connection,
}
impl Database {
    pub fn open(path: &Path, read_only: bool) -> Result<Self> {
        if !read_only {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
        }
        let conn = Connection::open_with_flags(
            path,
            if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
            },
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON")?;
        if !read_only {
            conn.execute_batch("PRAGMA journal_mode=WAL")?;
            conn.execute_batch(SCHEMA)?;
        }
        Ok(Self { conn })
    }
    pub fn list_walls(&self, full: bool) -> Result<Value> {
        let sql = if full {
            "SELECT id,name,updated,version,data FROM walls ORDER BY id"
        } else {
            "SELECT id,name,updated,version FROM walls ORDER BY id"
        };
        Ok(Value::Array(
            rows(&self.conn, sql, [])?
                .into_iter()
                .map(|v| parse_fields(v, &["data"]))
                .collect::<Result<_>>()?,
        ))
    }
    pub fn get_wall(&self, id: &str) -> Result<Value> {
        parse_fields(
            one(
                &self.conn,
                "SELECT id,name,updated,version,data FROM walls WHERE id=?",
                [id],
            )?,
            &["data"],
        )
    }
    pub fn put_wall(
        &self,
        id: &str,
        name: &str,
        data: &Value,
        base_version: Option<i64>,
    ) -> Result<Value> {
        transaction(&self.conn, || {
            let current = self.get_wall(id)?;
            let version = if current.is_null() {
                if base_version.is_some_and(|v| v != 0) {
                    return Err(conflict());
                }
                1
            } else {
                if base_version != current["version"].as_i64() {
                    return Err(conflict());
                }
                current["version"].as_i64().unwrap() + 1
            };
            self.conn.execute("INSERT INTO walls(id,name,updated,version,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated=excluded.updated,version=excluded.version,data=excluded.data",params![id,name,now(),version,data.to_string()])?;
            self.get_wall(id)
        })
    }
    pub fn delete_wall(&self, id: &str) -> Result<()> {
        transaction(&self.conn, || {
            for table in [
                "proposals",
                "audit",
                "chat_sessions",
                "chat_messages",
                "backups",
            ] {
                self.conn
                    .execute(&format!("DELETE FROM {table} WHERE wall_id=?"), [id])?;
            }
            self.conn.execute("DELETE FROM walls WHERE id=?", [id])?;
            Ok(())
        })
    }
    pub fn get_project(&self) -> Result<Value> {
        let images = rows(&self.conn, "SELECT record FROM images ORDER BY id", [])?
            .into_iter()
            .map(|v| serde_json::from_str(s(&v["record"])))
            .collect::<serde_json::Result<Vec<Value>>>()?;
        let mut meta = Map::new();
        for row in rows(&self.conn, "SELECT key,value FROM meta ORDER BY key", [])? {
            meta.insert(
                s(&row["key"]).to_owned(),
                serde_json::from_str(s(&row["value"]))?,
            );
        }
        Ok(
            json!({"format":"detective-wall-project","formatVersion":1,"exportedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"walls":self.list_walls(true)?,"images":images,"meta":meta}),
        )
    }
    pub fn replace_project(&self, project: &Value) -> Result<Value> {
        transaction(&self.conn, || {
            for table in [
                "proposals",
                "audit",
                "chat_sessions",
                "chat_messages",
                "walls",
                "images",
                "meta",
            ] {
                self.conn.execute(&format!("DELETE FROM {table}"), [])?;
            }
            for row in project["walls"]
                .as_array()
                .ok_or_else(|| AppError::new(400, "invalid project walls"))?
            {
                self.conn.execute(
                    "INSERT INTO walls(id,name,updated,version,data) VALUES(?,?,?,?,?)",
                    params![
                        s(&row["id"]),
                        s(&row["name"]),
                        row["updated"].as_i64(),
                        row["version"].as_i64(),
                        row["data"].to_string()
                    ],
                )?;
            }
            for image in project["images"]
                .as_array()
                .ok_or_else(|| AppError::new(400, "invalid project images"))?
            {
                self.put_image(image)?;
            }
            for (key, v) in project["meta"]
                .as_object()
                .ok_or_else(|| AppError::new(400, "invalid project meta"))?
            {
                self.conn.execute(
                    "INSERT INTO meta(key,value) VALUES(?,?)",
                    params![key, v.to_string()],
                )?;
            }
            self.conn.execute(
                "DELETE FROM backups WHERE wall_id NOT IN (SELECT id FROM walls)",
                [],
            )?;
            self.get_project()
        })
    }
    pub fn add_backup(&self, wall_id: &str, reason: &str, data: &Value) -> Result<i64> {
        transaction(&self.conn, || self.insert_backup(wall_id, reason, data))
    }
    fn insert_backup(&self, wall_id: &str, reason: &str, data: &Value) -> Result<i64> {
        let encoded = data.to_string();
        let latest = one(
            &self.conn,
            "SELECT id,data FROM backups WHERE wall_id=? ORDER BY id DESC LIMIT 1",
            [wall_id],
        )?;
        if latest["data"] == encoded {
            return Ok(latest["id"].as_i64().unwrap());
        }
        self.conn.execute(
            "INSERT INTO backups(wall_id,at,reason,cards,edges,data) VALUES(?,?,?,?,?,?)",
            params![
                wall_id,
                now(),
                reason,
                data["cards"].as_array().map_or(0, Vec::len) as i64,
                data["edges"].as_array().map_or(0, Vec::len) as i64,
                encoded
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.conn.execute("DELETE FROM backups WHERE wall_id=? AND id NOT IN(SELECT id FROM backups WHERE wall_id=? ORDER BY id DESC LIMIT 20)",params![wall_id,wall_id])?;
        Ok(id)
    }
    pub fn list_backups(&self, wall_id: &str) -> Result<Value> {
        Ok(json!(rows(&self.conn,"SELECT id,wall_id AS wallId,at,reason,cards,edges FROM backups WHERE wall_id=? ORDER BY id DESC",[wall_id])?))
    }
    pub fn get_backup(&self, id: i64) -> Result<Value> {
        parse_fields(
            one(
                &self.conn,
                "SELECT id,wall_id AS wallId,at,reason,cards,edges,data FROM backups WHERE id=?",
                [id],
            )?,
            &["data"],
        )
    }
    pub fn delete_backups(&self, wall_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM backups WHERE wall_id=?", [wall_id])?;
        Ok(())
    }
    pub fn put_image(&self, record: &Value) -> Result<String> {
        let id = s(&record["id"]);
        self.conn.execute("INSERT INTO images(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",params![id,record.to_string()])?;
        Ok(id.to_owned())
    }
    pub fn get_image(&self, id: &str) -> Result<Value> {
        let row = one(&self.conn, "SELECT record FROM images WHERE id=?", [id])?;
        if row.is_null() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_str(s(&row["record"]))?)
        }
    }
    pub fn get_meta(&self, key: &str) -> Result<Value> {
        let row = one(&self.conn, "SELECT value FROM meta WHERE key=?", [key])?;
        if row.is_null() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_str(s(&row["value"]))?)
        }
    }
    pub fn has_meta(&self, key: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key=?)",
            [key],
            |row| row.get(0),
        )?)
    }
    pub fn set_meta(&self, key: &str, value: &Value) -> Result<String> {
        let normalized = if key == "tabs" {
            normalize_tabs_meta(value)?
        } else {
            value.clone()
        };
        self.conn.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,normalized.to_string()])?;
        Ok(key.to_owned())
    }
    pub fn get_chat_history(&self, wall_id: &str, client: &str) -> Result<Value> {
        let session = one(
            &self.conn,
            "SELECT session_id,updated FROM chat_sessions WHERE wall_id=? AND client=?",
            params![wall_id, client],
        )?;
        let mut messages=rows(&self.conn,"SELECT id,role,text,at,error,status FROM chat_messages WHERE wall_id=? AND client=? ORDER BY id",params![wall_id,client])?;
        for row in &mut messages {
            if row["status"].is_null() || row["status"] == "" {
                row.as_object_mut().unwrap().remove("status");
            }
        }
        Ok(
            json!({"wallId":wall_id,"client":client,"sessionId":session["session_id"],"updated":session["updated"],"messages":messages}),
        )
    }
    pub fn set_chat_session(&self, wall_id: &str, client: &str, session_id: &str) -> Result<()> {
        self.conn.execute("INSERT INTO chat_sessions(wall_id,client,session_id,updated) VALUES(?,?,?,?) ON CONFLICT(wall_id,client) DO UPDATE SET session_id=excluded.session_id,updated=excluded.updated",params![wall_id,client,session_id,now()])?;
        Ok(())
    }
    pub fn add_chat_message(
        &self,
        wall_id: &str,
        client: &str,
        role: &str,
        text: &str,
        error: Option<&str>,
        status: Option<&str>,
    ) -> Result<i64> {
        self.conn.execute("INSERT INTO chat_messages(wall_id,client,role,text,at,error,status) VALUES(?,?,?,?,?,?,?)",params![wall_id,client,role,text,now(),error,status])?;
        Ok(self.conn.last_insert_rowid())
    }
    pub fn reset_chat(&self, wall_id: &str, client: &str) -> Result<()> {
        transaction(&self.conn, || {
            self.conn.execute(
                "DELETE FROM chat_messages WHERE wall_id=? AND client=?",
                params![wall_id, client],
            )?;
            self.conn.execute(
                "DELETE FROM chat_sessions WHERE wall_id=? AND client=?",
                params![wall_id, client],
            )?;
            Ok(())
        })
    }
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        wall_ids: Option<&[String]>,
        offset: usize,
    ) -> Result<Value> {
        let text = query.trim();
        if text.is_empty() {
            return Ok(json!([]));
        }
        if limit == 0 || limit > 9007199254740991 || offset > 9007199254740991 {
            return Err(AppError::new(400, "invalid search limit"));
        }
        let mut values: Vec<rusqlite::types::Value> = vec![];
        let filter = match wall_ids {
            None => String::new(),
            Some(ids) if ids.is_empty() => "WHERE 0".to_owned(),
            Some(ids) => {
                values.extend(ids.iter().map(|s| rusqlite::types::Value::Text(s.clone())));
                format!("WHERE w.id IN ({})", vec!["?"; ids.len()].join(","))
            }
        };
        let escaped = text
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        for _ in 0..4 {
            values.push(format!("%{escaped}%").into());
        }
        values.push((limit as i64).into());
        values.push((offset as i64).into());
        let sql = format!(
            r#"WITH visible_walls AS(SELECT w.id,w.name,w.data FROM walls w {filter}),
        cards AS(SELECT w.id AS wallId,w.name AS wallName,CAST(c.key AS INTEGER) AS cardOrder,json_extract(c.value,'$.id') AS cardId,json_extract(c.value,'$.title') AS title,json_extract(c.value,'$.note') AS note,c.value AS card,w.data AS wallData FROM visible_walls w,json_each(w.data,'$.cards') c),
        matches AS(
        SELECT wallId,wallName,'card' AS type,cardId,NULL AS edgeFrom,NULL AS edgeTo,'title' AS field,title,title AS matched,cardOrder,0 AS fieldOrder,0 AS sourceOrder FROM cards WHERE title IS NOT NULL AND lower(title) LIKE lower(?) ESCAPE char(92)
        UNION ALL SELECT wallId,wallName,'card',cardId,NULL,NULL,'note',title,note,cardOrder,1,0 FROM cards WHERE note IS NOT NULL AND lower(note) LIKE lower(?) ESCAPE char(92)
        UNION ALL SELECT c.wallId,c.wallName,'card',c.cardId,NULL,NULL,'tag',c.title,json_extract(tag.value,'$.name'),c.cardOrder,2,CAST(tag.key AS INTEGER) FROM cards c JOIN json_each(c.card,'$.tags') attached JOIN json_each(c.wallData,'$.tags') tag ON json_extract(tag.value,'$.id')=attached.value WHERE json_extract(tag.value,'$.name') IS NOT NULL AND lower(json_extract(tag.value,'$.name')) LIKE lower(?) ESCAPE char(92)
        UNION ALL SELECT w.id,w.name,'edge',json_extract(fromCard.value,'$.id'),json_extract(edge.value,'$.from'),json_extract(edge.value,'$.to'),'edge',json_extract(fromCard.value,'$.title'),json_extract(edge.value,'$.label'),CAST(fromCard.key AS INTEGER),3,CAST(edge.key AS INTEGER) FROM visible_walls w JOIN json_each(w.data,'$.edges') edge JOIN json_each(w.data,'$.cards') fromCard ON json_extract(fromCard.value,'$.id')=json_extract(edge.value,'$.from') WHERE json_extract(edge.value,'$.label') IS NOT NULL AND lower(json_extract(edge.value,'$.label')) LIKE lower(?) ESCAPE char(92))
        SELECT wallId,wallName,type,cardId,edgeFrom,edgeTo,field,title,matched FROM matches ORDER BY wallName COLLATE NOCASE,wallId,cardOrder,fieldOrder,sourceOrder LIMIT ? OFFSET ?"#
        );
        let mut found = rows(&self.conn, &sql, params_from_iter(values))?;
        for row in &mut found {
            let snippet = snippet(s(&row["matched"]), text);
            let edge = row["type"] == "edge";
            let obj = row.as_object_mut().unwrap();
            obj.remove("matched");
            if !edge {
                obj.remove("edgeFrom");
                obj.remove("edgeTo");
            }
            obj.insert("snippet".to_owned(), json!(snippet));
        }
        Ok(json!(found))
    }
    pub fn get_proposal_by_idempotency_key(&self, key: &str) -> Result<Value> {
        proposal_by(&self.conn, "idempotency_key", key)
    }
    pub fn insert_proposal(&self, proposal: &Value) -> Result<Value> {
        insert_proposal(&self.conn, proposal)
    }
    pub fn get_proposal(&self, id: &str) -> Result<Value> {
        let mut p = proposal_by(&self.conn, "id", id)?;
        if !p.is_null() {
            p["auditIds"] = self.audit_ids(id)?;
        }
        Ok(p)
    }
    fn audit_ids(&self, id: &str) -> Result<Value> {
        Ok(json!(rows(
            &self.conn,
            "SELECT id FROM audit WHERE proposal_id=? ORDER BY id",
            [id]
        )?
        .into_iter()
        .map(|r| r["id"].clone())
        .collect::<Vec<_>>()))
    }
    pub fn list_proposals(&self, status: &str, wall_id: Option<&str>) -> Result<Value> {
        let mut clauses = vec![];
        let mut values = vec![];
        if status == "pending" {
            clauses.push("status='pending'");
        }
        if let Some(id) = wall_id.filter(|id| !id.is_empty()) {
            clauses.push("wall_id=?");
            values.push(id);
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let list = rows(
            &self.conn,
            &format!("SELECT * FROM proposals{filter} ORDER BY created DESC,id DESC"),
            params_from_iter(values),
        )?;
        let mut counts = json!({"pending":0,"partial":0,"applied":0,"rejected":0});
        let mut summaries = vec![];
        for row in list {
            let mut p = parse_proposal(row)?;
            let mut types = Map::new();
            for (i, op) in p["ops"].as_array().unwrap().iter().enumerate() {
                if p["opStatus"][i] == "pending" {
                    let key = s(&op["type"]);
                    let n = types.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
                    types.insert(key.to_owned(), json!(n));
                }
            }
            let key = s(&p["status"]).to_owned();
            counts[&key] = json!(counts[&key].as_u64().unwrap_or(0) + 1);
            p.as_object_mut().unwrap().remove("ops");
            p.as_object_mut().unwrap().remove("baseCards");
            p["pendingTypes"] = json!(types);
            summaries.push(p);
        }
        Ok(
            json!({"pending":counts["pending"],"counts":counts,"total":summaries.len(),"proposals":summaries}),
        )
    }
    fn proposal_wall(&self, id: &str) -> Result<(Value, Value)> {
        let p = proposal_by(&self.conn, "id", id)?;
        if p.is_null() {
            return Err(AppError::new(404, "proposal not found"));
        }
        let w = self.get_wall(s(&p["wallId"]))?;
        if w.is_null() {
            return Err(AppError::new(404, "wall not found"));
        }
        Ok((p, w))
    }
    pub fn preview_proposal(&self, id: &str, op_indexes: &Value) -> Result<Value> {
        let (p, w) = self.proposal_wall(id)?;
        let simulation = proposals::simulate(&p, &w, op_indexes)?;
        let mut positions = vec![];
        let mut edges = vec![];
        for (i, op) in p["ops"].as_array().unwrap().iter().enumerate() {
            let r = &simulation.results[i];
            if r["selected"] != true || r["status"] != "applied" || r["changed"] != true {
                continue;
            }
            if op["type"] == "add_card" {
                let cid = proposals::deterministic_id("c", id, s(&op["tempId"]));
                if proposals::cards(&simulation.before)
                    .iter()
                    .any(|c| c["id"] == cid)
                {
                    continue;
                }
                if let Some(c) = proposals::cards(&simulation.after)
                    .iter()
                    .find(|c| c["id"] == cid)
                {
                    positions.push(json!({"opIndex":i,"tempId":op["tempId"],"id":cid,"x":c["x"],"y":c["y"],"width":layout::width(c),"height":layout::height(c)}));
                }
            }
            if op["type"] == "add_edge" {
                edges.push(json!({"opIndex":i,"id":proposals::deterministic_id("e",id,&i.to_string()),"from":simulation.temp_ids.get(s(&op["from"])).unwrap_or(&op["from"]),"to":simulation.temp_ids.get(s(&op["to"])).unwrap_or(&op["to"]),"type":op["edgeType"],"label":op["label"]}));
            }
        }
        Ok(
            json!({"proposalId":id,"wallId":p["wallId"],"version":w["version"],"positions":positions,"edges":edges,"idMap":simulation.temp_ids,"results":simulation.results}),
        )
    }
    pub fn apply_proposal(&self, id: &str, op_indexes: &Value) -> Result<Value> {
        transaction(&self.conn, || {
            let (p, w) = self.proposal_wall(id)?;
            let sim = proposals::simulate(&p, &w, op_indexes)?;
            let wall_id = s(&p["wallId"]);
            let mut audit_id = Value::Null;
            if sim.changed() {
                self.insert_backup(wall_id, "AI 套用前", &sim.before)?;
                let version = w["version"].as_i64().unwrap();
                self.conn.execute(
                    "UPDATE walls SET updated=?,version=?,data=? WHERE id=?",
                    params![now(), version + 1, sim.after.to_string(), wall_id],
                )?;
                self.conn.execute("INSERT INTO audit(at,actor,proposal_id,wall_id,before_version,after_version,affected,before,after,reverted_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",params![now(),if s(&p["client"]).is_empty(){"MCP"}else{s(&p["client"])},id,wall_id,version,version+1,sim.affected.to_string(),sim.before.to_string(),sim.after.to_string()])?;
                audit_id = json!(self.conn.last_insert_rowid());
            }
            self.conn.execute(
                "UPDATE proposals SET status=?,op_status=? WHERE id=?",
                params![
                    proposals::status(&sim.statuses),
                    sim.statuses.to_string(),
                    id
                ],
            )?;
            Ok(
                json!({"wall":self.get_wall(wall_id)?,"results":sim.results,"auditId":audit_id,"proposal":self.get_proposal(id)?}),
            )
        })
    }
    pub fn reject_proposal(&self, id: &str, op_indexes: Option<&Value>) -> Result<Value> {
        transaction(&self.conn, || {
            let p = proposal_by(&self.conn, "id", id)?;
            if p.is_null() {
                return Err(AppError::new(404, "proposal not found"));
            }
            let count = p["ops"].as_array().unwrap().len();
            let selected = match op_indexes {
                Some(v) => proposals::indexes(v, count)?,
                None => (0..count).collect(),
            };
            let mut statuses = p["opStatus"].clone();
            for i in selected {
                if statuses[i] == "pending" {
                    statuses[i] = json!("rejected");
                }
            }
            self.conn.execute(
                "UPDATE proposals SET status=?,op_status=? WHERE id=?",
                params![proposals::status(&statuses), statuses.to_string(), id],
            )?;
            self.get_proposal(id)
        })
    }
    pub fn list_audit(&self, wall_id: Option<&str>) -> Result<Value> {
        let base="SELECT id,at,actor,proposal_id AS proposalId,wall_id AS wallId,before_version AS beforeVersion,after_version AS afterVersion,affected,before,after,reverted_at AS revertedAt FROM audit";
        let list = if let Some(id) = wall_id {
            rows(
                &self.conn,
                &format!("{base} WHERE wall_id=? ORDER BY id DESC"),
                [id],
            )?
        } else {
            rows(&self.conn, &format!("{base} ORDER BY id DESC"), [])?
        };
        Ok(Value::Array(
            list.into_iter()
                .map(|v| parse_fields(v, &["affected", "before", "after"]))
                .collect::<Result<_>>()?,
        ))
    }
    pub fn revert_audit(&self, id: i64) -> Result<Value> {
        if !(1..=9007199254740991).contains(&id) {
            return Err(AppError::new(400, "invalid audit id"));
        }
        transaction(&self.conn, || {
            let a = one(&self.conn, "SELECT * FROM audit WHERE id=?", [id])?;
            if a.is_null() {
                return Err(AppError::new(404, "audit not found"));
            }
            let wid = s(&a["wall_id"]);
            let w = one(
                &self.conn,
                "SELECT id,version,data FROM walls WHERE id=?",
                [wid],
            )?;
            if w.is_null() {
                return Err(AppError::new(404, "wall not found"));
            }
            if w["version"] != a["after_version"] || w["data"] != a["after"] {
                return Err(AppError::new(
                    409,
                    "wall changed since this apply; nothing was reverted",
                ));
            }
            let before: Value = serde_json::from_str(s(&w["data"]))?;
            let after: Value = serde_json::from_str(s(&a["before"]))?;
            self.insert_backup(wid, "AI 套用回復前", &before)?;
            let version = w["version"].as_i64().unwrap();
            self.conn.execute(
                "UPDATE walls SET updated=?,version=?,data=? WHERE id=?",
                params![now(), version + 1, after.to_string(), wid],
            )?;
            let mut affected: Value = serde_json::from_str(s(&a["affected"]))?;
            affected["revertOf"] = json!(id);
            self.conn.execute("INSERT INTO audit(at,actor,proposal_id,wall_id,before_version,after_version,affected,before,after,reverted_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",params![now(),"使用者回復",a["proposal_id"].as_str(),wid,version,version+1,affected.to_string(),before.to_string(),after.to_string()])?;
            let audit_id = self.conn.last_insert_rowid();
            self.conn.execute(
                "UPDATE audit SET reverted_at=? WHERE id=?",
                params![now(), id],
            )?;
            Ok(json!({"wall":self.get_wall(wid)?,"auditId":audit_id,"revertedAuditId":id}))
        })
    }
    pub fn integrity_check(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))?)
    }
}
fn parse_proposal(row: Value) -> Result<Value> {
    if row.is_null() {
        return Ok(row);
    }
    let ops: Value = serde_json::from_str(s(&row["ops"]))?;
    let base: Value = serde_json::from_str(s(&row["base_cards"]))?;
    let statuses: Value = serde_json::from_str(s(&row["op_status"]))?;
    let mut counts = Map::new();
    for name in ["pending", "applied", "rejected", "conflict"] {
        counts.insert(
            name.to_owned(),
            json!(statuses
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| **v == name)
                .count()),
        );
    }
    Ok(
        json!({"id":row["id"],"proposalId":row["id"],"wallId":row["wall_id"],"baseVersion":row["base_version"],"status":row["status"],"created":row["created"],"client":row["client"],"idempotencyKey":row["idempotency_key"],"rationale":row["rationale"],"ops":ops,"baseCards":base,"opStatus":statuses,"counts":counts,"auditIds":[]}),
    )
}
fn proposal_by(conn: &Connection, column: &str, id: &str) -> Result<Value> {
    parse_proposal(one(
        conn,
        &format!("SELECT * FROM proposals WHERE {column}=?"),
        [id],
    )?)
}
fn insert_proposal(conn: &Connection, p: &Value) -> Result<Value> {
    transaction(conn, || {
        let key = s(&p["idempotencyKey"]);
        let existing = proposal_by(conn, "idempotency_key", key)?;
        if !existing.is_null() {
            if existing["wallId"] != p["wallId"]
                || existing["rationale"] != p["rationale"]
                || existing["ops"] != p["ops"]
            {
                return Err(AppError::new(
                    409,
                    "idempotency key already used with different payload",
                ));
            }
            return Ok(existing);
        }
        let statuses: Vec<&str> = p["ops"]
            .as_array()
            .ok_or_else(|| AppError::new(400, "invalid proposal ops"))?
            .iter()
            .map(|_| "pending")
            .collect();
        conn.execute("INSERT INTO proposals(id,wall_id,base_version,status,created,client,idempotency_key,rationale,ops,base_cards,op_status) VALUES(?,?,?,'pending',?,?,?,?,?,?,?)",params![s(&p["id"]),s(&p["wallId"]),p["baseVersion"].as_i64(),p["created"].as_i64(),s(&p["client"]),key,s(&p["rationale"]),p["ops"].to_string(),p["baseCards"].to_string(),json!(statuses).to_string()])?;
        proposal_by(conn, "id", s(&p["id"]))
    })
}
pub struct ProposalWriter {
    conn: Connection,
}
impl ProposalWriter {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON")?;
        let exists: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::new(
                500,
                "proposal schema not found; start the HTTP service first",
            ));
        }
        conn.authorizer(Some(|context: rusqlite::hooks::AuthContext<'_>| {
            use rusqlite::hooks::{AuthAction, Authorization};
            match context.action {
                AuthAction::Insert {
                    table_name: "proposals",
                }
                | AuthAction::Read { .. }
                | AuthAction::Select
                | AuthAction::Transaction { .. } => Authorization::Allow,
                _ => Authorization::Deny,
            }
        }))?;
        Ok(Self { conn })
    }
    pub fn insert_proposal(&self, p: &Value) -> Result<Value> {
        insert_proposal(&self.conn, p)
    }
}
fn snippet(text: &str, query: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= 120 {
        return text.to_owned();
    }
    let lower = text.to_lowercase();
    let at = lower
        .find(&query.to_lowercase())
        .map(|byte| lower[..byte].encode_utf16().count())
        .unwrap_or(0);
    let start = at.saturating_sub(50);
    let end = (start + 120).min(units.len());
    let start = end.saturating_sub(120);
    let mut result = String::new();
    if start > 0 {
        result.push('…');
    }
    result.push_str(&String::from_utf16_lossy(&units[start..end]));
    if end < units.len() {
        result.push('…');
    }
    String::from_utf16_lossy(&result.encode_utf16().take(120).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn json_numbers(mut value: Value) -> Value {
        match &mut value {
            Value::Array(items) => {
                for item in items {
                    *item = json_numbers(item.take());
                }
            }
            Value::Object(object) => {
                for item in object.values_mut() {
                    *item = json_numbers(item.take());
                }
            }
            Value::Number(number) if number.is_f64() => {
                let n = number.as_f64().unwrap();
                if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                    value = json!(n as i64);
                }
            }
            _ => {}
        }
        value
    }
    fn test_db(name: &str) -> std::path::PathBuf {
        // Keep compatibility artifacts under the repository's existing test-results directory.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/rust-data");
        std::fs::create_dir_all(&root).unwrap();
        root.join(format!("{name}-{}.db", uuid::Uuid::new_v4()))
    }
    #[test]
    fn legacy_schema_proposals_layout_and_roundtrip() {
        let path = test_db("legacy");
        // Independent v0.1 schema fixture: do not use SCHEMA or the application writer.
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(r#"
CREATE TABLE walls(id TEXT PRIMARY KEY,name TEXT NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,data JSON NOT NULL);
CREATE TABLE images(id TEXT PRIMARY KEY,record JSON NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY,value JSON NOT NULL);
CREATE TABLE backups(id INTEGER PRIMARY KEY AUTOINCREMENT,wall_id TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT NOT NULL,cards INTEGER NOT NULL,edges INTEGER NOT NULL,data JSON NOT NULL);
CREATE TABLE proposals(id TEXT PRIMARY KEY,wall_id TEXT NOT NULL,base_version INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,client TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,rationale TEXT NOT NULL,ops JSON NOT NULL,base_cards JSON NOT NULL,op_status JSON NOT NULL);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,proposal_id TEXT,wall_id TEXT NOT NULL,before_version INTEGER NOT NULL,after_version INTEGER NOT NULL,affected JSON NOT NULL,before JSON NOT NULL,after JSON NOT NULL,reverted_at INTEGER);

CREATE TABLE chat_sessions(wall_id TEXT NOT NULL,client TEXT NOT NULL,session_id TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(wall_id,client));
CREATE TABLE chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,wall_id TEXT NOT NULL,client TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,error TEXT,status TEXT);
"#).unwrap();
        let before = json!({"tags":[],"bands":[],"cards":[{"id":"anchor","kind":"card","x":30,"y":40,"title":"Existing","note":"original","tags":[],"links":[],"custom":{"keep":true}}],"edges":[],"extension":{"preserve":"未知欄位"}});
        legacy
            .execute(
                "INSERT INTO walls VALUES ('w','舊資料',1,1,?)",
                [before.to_string()],
            )
            .unwrap();
        legacy.execute("INSERT INTO images VALUES ('image',?)", [json!({"id":"image","blob":{"type":"image/png","base64":"aGVsbG8="},"extension":42}).to_string()]).unwrap();
        legacy
            .execute(
                "INSERT INTO meta VALUES ('sourceFolders',?)",
                [json!(["C:/authorized"]).to_string()],
            )
            .unwrap();
        legacy.execute_batch("INSERT INTO chat_sessions VALUES ('w','claude','session',1); INSERT INTO chat_messages(wall_id,client,role,text,at) VALUES ('w','claude','user','history',1);").unwrap();
        drop(legacy);
        let db = Database::open(&path, false).unwrap();
        assert_eq!(db.get_wall("w").unwrap()["data"], before);
        assert_eq!(db.get_image("image").unwrap()["extension"], 42);
        assert_eq!(
            db.get_meta("sourceFolders").unwrap(),
            json!(["C:/authorized"])
        );
        db.set_meta("nullable", &Value::Null).unwrap();
        assert!(db.has_meta("nullable").unwrap());
        assert!(!db.has_meta("absent").unwrap());
        assert_eq!(
            db.get_chat_history("w", "claude").unwrap()["sessionId"],
            "session"
        );
        assert_eq!(
            db.get_chat_history("w", "claude").unwrap()["messages"][0]["text"],
            "history"
        );
        let checked = validate_proposal(&db.get_wall("w").unwrap(), &json!([
            {"op":"add_card","tempId":"new","kind":"note","title":"新增","note":"a\nb","tags":["tag"],"links":[]},
            {"op":"add_edge","from":"anchor","to":"new","type":"uses","label":"relation"},
            {"op":"update_card","cardId":"anchor","note":"edited"}
        ])).unwrap();
        let proposal = json!({"id":"p","wallId":"w","baseVersion":1,"created":1,"client":"test","idempotencyKey":"key","rationale":"why","ops":checked["ops"],"baseCards":checked["baseCards"]});
        let writer = ProposalWriter::open(&path).unwrap();
        writer.insert_proposal(&proposal).unwrap();
        assert!(writer
            .conn
            .execute("UPDATE walls SET name='forbidden'", [])
            .is_err());
        assert!(writer.conn.execute("DELETE FROM proposals", []).is_err());
        let preview = db.preview_proposal("p", &json!([0, 1, 2])).unwrap();
        let position = json_numbers(preview["positions"][0].clone());
        // Golden v0.1 placement contract for an anchored note.
        assert_eq!(
            (
                position["x"].clone(),
                position["y"].clone(),
                position["width"].clone(),
                position["height"].clone()
            ),
            (json!(285), json!(40), json!(170), json!(140))
        );
        assert_eq!(
            db.get_wall("w").unwrap()["data"],
            before,
            "preview is read-only"
        );
        let applied = db.apply_proposal("p", &json!([0, 1, 2])).unwrap();
        assert_eq!(applied["wall"]["version"], 2);
        assert_eq!(applied["wall"]["data"]["cards"][0]["note"], "edited");
        assert_eq!(
            applied["wall"]["data"]["cards"][0]["custom"],
            before["cards"][0]["custom"]
        );
        assert_eq!(applied["wall"]["data"]["extension"], before["extension"]);
        let added = &applied["wall"]["data"]["cards"][1];
        assert_eq!(added["id"], position["id"]);
        assert_eq!(json_numbers(added["x"].clone()), position["x"]);
        assert_eq!(applied["wall"]["data"]["edges"][0]["to"], added["id"]);
        assert!(applied["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "applied"));
        assert!(db.apply_proposal("p", &json!([0, 1, 2])).unwrap()["auditId"].is_null());
        let reverted = db
            .revert_audit(applied["auditId"].as_i64().unwrap())
            .unwrap();
        assert_eq!(reverted["wall"]["data"], before);
        // A plain SQLite reader can still consume Rust-written JSON and the old columns.
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let stored: String = reader
            .query_row("SELECT data FROM walls WHERE id='w'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), before);
        assert_eq!(
            reader
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        let readonly = Database::open(&path, true).unwrap();
        assert!(readonly
            .put_wall("blocked", "blocked", &before, None)
            .is_err());
        assert!(readonly.set_meta("blocked", &json!(true)).is_err());
        let export = db.get_project().unwrap();
        let imported = Database::open(&test_db("roundtrip"), false).unwrap();
        imported.replace_project(&export).unwrap();
        assert_eq!(imported.get_wall("w").unwrap()["data"], before);
        assert_eq!(imported.get_image("image").unwrap()["extension"], 42);
    }
    #[test]
    fn transactions_conflicts_backup_pruning_and_search() {
        let path = test_db("transactions");
        let db = Database::open(&path, false).unwrap();
        let data = json!({"tags":[{"id":"t","name":"literal_%"}],"bands":[],"cards":[{"id":"c","kind":"card","x":0,"y":0,"title":"literal_%","note":"note","tags":["t"]}],"edges":[]});
        db.put_wall("w", "wall", &data, None).unwrap();
        assert_eq!(
            db.put_wall("w", "wrong", &data, Some(0))
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(
            db.search("_%", 50, None, 0)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(db.search("_%", 50, Some(&[]), 0).unwrap(), json!([]));
        for i in 0..25 {
            let mut changed = data.clone();
            changed["cards"][0]["title"] = json!(i.to_string());
            db.add_backup("w", "test", &changed).unwrap();
        }
        assert_eq!(db.list_backups("w").unwrap().as_array().unwrap().len(), 20);
        let mut project = db.get_project().unwrap();
        let duplicate = project["walls"][0].clone();
        project["walls"].as_array_mut().unwrap().push(duplicate);
        assert!(db.replace_project(&project).is_err());
        assert_eq!(db.get_wall("w").unwrap()["data"], data);
        let checked = validate_proposal(
            &db.get_wall("w").unwrap(),
            &json!([{"op":"update_card","cardId":"c","note":"AI"}]),
        )
        .unwrap();
        db.insert_proposal(&json!({"id":"p","wallId":"w","baseVersion":1,"created":1,"client":"test","idempotencyKey":"k","rationale":"","ops":checked["ops"],"baseCards":checked["baseCards"]})).unwrap();
        let mut changed = data.clone();
        changed["cards"][0]["note"] = json!("human");
        db.put_wall("w", "wall", &changed, Some(1)).unwrap();
        let applied = db.apply_proposal("p", &json!([0])).unwrap();
        assert_eq!(applied["results"][0]["status"], "conflict");
        assert_eq!(applied["wall"]["data"], changed);
        assert!(applied["auditId"].is_null());
        let checked = validate_proposal(
            &db.get_wall("w").unwrap(),
            &json!([
                {"op":"add_card","tempId":"rollback","kind":"note","title":"Rollback"}
            ]),
        )
        .unwrap();
        db.insert_proposal(&json!({"id":"rollback","wallId":"w","baseVersion":2,"created":2,"client":"test","idempotencyKey":"rollback","rationale":"","ops":checked["ops"],"baseCards":checked["baseCards"]})).unwrap();
        let pending = db.get_proposal("rollback").unwrap();
        // Fail the audit write after the wall update to exercise the real transaction rollback.
        db.conn.execute_batch("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END;").unwrap();
        assert!(db.apply_proposal("rollback", &json!([0])).is_err());
        assert_eq!(db.get_wall("w").unwrap()["data"], changed);
        assert_eq!(db.get_wall("w").unwrap()["version"], 2);
        assert_eq!(db.get_proposal("rollback").unwrap(), pending);
        assert_eq!(db.list_audit(None).unwrap(), json!([]));
    }

    #[test]
    fn partial_apply_reject_delete_and_cluster_layout() {
        let path = test_db("partial");
        let db = Database::open(&path, false).unwrap();
        let data = json!({"bands":[{"id":"band","title":"Group","y":300}],"tags":[],"cards":[
            {"id":"a","kind":"card","x":20,"y":20,"title":"A","note":"original","tags":[],"links":[]},
            {"id":"b","kind":"note","x":400,"y":20,"title":"B","note":"keep","tags":[],"links":[]}],
            "edges":[{"id":"ab","from":"a","to":"b","type":"uses","label":"old"}]});
        let wall = db.put_wall("w", "Wall", &data, None).unwrap();
        let checked = validate_proposal(&wall, &json!([
            {"op":"add_card","tempId":"one","kind":"card","title":"😀".repeat(30),"note":"line\n".repeat(4),"band":"Group","tags":["same"],"links":[],"color":"#AABBCC"},
            {"op":"add_card","tempId":"two","kind":"note","title":"Second","note":"","tags":["same"],"links":[]},
            {"op":"add_edge","from":"one","to":"two","type":"builds","label":"pair"},
            {"op":"add_edge","from":"a","to":"one","type":"uses","label":"anchor"},
            {"op":"update_card","cardId":"a","note":"edited","tags":["same"]},
            {"op":"delete_edge","from":"a","to":"b"}, {"op":"delete_card","cardId":"b"}
        ])).unwrap();
        db.insert_proposal(&json!({"id":"partial","wallId":"w","baseVersion":1,"created":1,"client":"test","idempotencyKey":"key","rationale":"why","ops":checked["ops"],"baseCards":checked["baseCards"]})).unwrap();
        let preview = db
            .preview_proposal("partial", &json!([0, 1, 2, 3]))
            .unwrap();
        assert_eq!(db.get_wall("w").unwrap(), wall);
        assert_eq!(preview["positions"].as_array().unwrap().len(), 2);
        let partial = db.apply_proposal("partial", &json!([4])).unwrap();
        assert_eq!(partial["wall"]["version"], 2);
        assert_eq!(partial["wall"]["data"]["cards"][0]["note"], "edited");
        let cluster = db.apply_proposal("partial", &json!([0, 1, 2, 3])).unwrap();
        assert_eq!(cluster["wall"]["version"], 3);
        let cards = cluster["wall"]["data"]["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 4);
        assert_eq!(
            (cards[0]["x"].clone(), cards[0]["y"].clone()),
            (json!(20), json!(20))
        );
        assert_eq!(cards[1], data["cards"][1]);
        assert_eq!(cards[2]["color"], "#aabbcc");
        assert_eq!(cards[2]["tags"], cards[3]["tags"]);
        for position in preview["positions"].as_array().unwrap() {
            let card = cards.iter().find(|c| c["id"] == position["id"]).unwrap();
            assert_eq!(
                (card["x"].clone(), card["y"].clone()),
                (position["x"].clone(), position["y"].clone())
            );
        }
        for a in 0..cards.len() {
            for b in a + 1..cards.len() {
                let (a, b) = (&cards[a], &cards[b]);
                let (ax, ay, bx, by) = (
                    a["x"].as_f64().unwrap(),
                    a["y"].as_f64().unwrap(),
                    b["x"].as_f64().unwrap(),
                    b["y"].as_f64().unwrap(),
                );
                assert!(
                    ax + layout::width(a) <= bx
                        || bx + layout::width(b) <= ax
                        || ay + layout::height(a) <= by
                        || by + layout::height(b) <= ay,
                    "cards overlap: {a} / {b}"
                );
            }
        }
        db.reject_proposal("partial", Some(&json!([6]))).unwrap();
        assert_eq!(
            db.get_proposal("partial").unwrap()["opStatus"][6],
            "rejected"
        );
        let deleted = db.apply_proposal("partial", &json!([5])).unwrap();
        assert_eq!(
            deleted["wall"]["data"]["edges"].as_array().unwrap().len(),
            2
        );
        assert_eq!(
            deleted["wall"]["data"]["cards"].as_array().unwrap().len(),
            4
        );
        let reverted = db
            .revert_audit(deleted["auditId"].as_i64().unwrap())
            .unwrap();
        assert_eq!(reverted["wall"]["data"], cluster["wall"]["data"]);
        assert_eq!(
            db.apply_proposal("partial", &json!([99]))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            db.revert_audit(partial["auditId"].as_i64().unwrap())
                .unwrap_err()
                .status,
            409
        );
    }
}
