use crate::layout;
use crate::{AppError, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn invalid(label: &str) -> AppError {
    AppError::new(400, format!("invalid proposal {label}"))
}
fn string(value: &Value, label: &str, limit: usize) -> Result<String> {
    let s = value.as_str().ok_or_else(|| invalid(label))?;
    if s.encode_utf16().count() > limit {
        return Err(invalid(label));
    }
    Ok(s.to_owned())
}
fn id(value: &Value, label: &str) -> Result<String> {
    let s = string(value, label, 200)?;
    if s.is_empty() {
        Err(invalid(label))
    } else {
        Ok(s)
    }
}
pub fn safe_source_href(value: &str) -> bool {
    if value.is_empty()
        || value.encode_utf16().count() > 4096
        || value.chars().any(|c| c < ' ' || c == '\x7f')
    {
        return false;
    }
    let mut decoded = value.trim().to_owned();
    if decoded.is_empty() {
        return false;
    }
    for _ in 0..8 {
        let Ok(next) = percent_encoding::percent_decode_str(&decoded).decode_utf8() else {
            break;
        };
        if next == decoded {
            break;
        }
        decoded = next.into_owned();
    }
    if decoded.chars().any(|c| c < ' ' || c == '\x7f') {
        return false;
    }
    if decoded
        .chars()
        .take(2)
        .filter(|c| *c == '/' || *c == '\\')
        .count()
        == 2
    {
        return false;
    }
    let bytes = decoded.as_bytes();
    if decoded.starts_with('/')
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'))
    {
        return true;
    }
    let probe: String = decoded
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\\')
        .flat_map(char::to_lowercase)
        .collect();
    if let Some((scheme, _)) = probe.split_once(':') {
        if scheme
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        {
            return ["http", "https", "file", "mailto"].contains(&scheme);
        }
    }
    true
}
pub fn color(value: &Value) -> Result<Value> {
    let s = value.as_str().ok_or_else(|| invalid("color"))?;
    if ["slate", "amber", "red", "green", "purple", "cream"].contains(&s) {
        return Ok(json!(s));
    }
    if s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit()) {
        return Ok(json!(s.to_ascii_lowercase()));
    }
    Err(invalid("color"))
}
pub fn normalize_tabs_meta(value: &Value) -> Result<Value> {
    let order = value["order"]
        .as_array()
        .ok_or_else(|| AppError::new(400, "invalid tabs meta"))?;
    let colors = value["colors"]
        .as_object()
        .ok_or_else(|| AppError::new(400, "invalid tabs meta"))?;
    let mut seen = HashSet::new();
    let mut result = vec![];
    for v in order {
        let s = v
            .as_str()
            .ok_or_else(|| AppError::new(400, "invalid tabs order"))?;
        if seen.insert(s) {
            result.push(v.clone());
        }
    }
    let mut normalized = Map::new();
    for (key, v) in colors {
        if key.is_empty() {
            return Err(AppError::new(400, "invalid tabs color"));
        }
        normalized.insert(
            key.clone(),
            color(v).map_err(|_| AppError::new(400, "invalid tabs color"))?,
        );
    }
    Ok(json!({"order":result,"colors":normalized}))
}
fn tags(value: &Value) -> Result<Value> {
    let a = value
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| invalid("tags"))?;
    Ok(Value::Array(
        a.iter()
            .map(|v| {
                let s = string(v, "tag", 100)?.trim().to_owned();
                if s.is_empty() {
                    Err(invalid("tag"))
                } else {
                    Ok(json!(s))
                }
            })
            .collect::<Result<_>>()?,
    ))
}
fn links(value: &Value) -> Result<Value> {
    let a = value
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| invalid("links"))?;
    let mut out = vec![];
    for v in a {
        if !v.is_object() {
            return Err(invalid("link"));
        }
        let href = string(&v["href"], "link href", 4096)?;
        if !safe_source_href(&href) {
            return Err(invalid("link href"));
        }
        let label = v["label"].as_str().unwrap_or(&href);
        if label.encode_utf16().count() > 5000 {
            return Err(invalid("link label"));
        }
        let mut result = json!({"label":label,"href":href});
        for field in ["locator", "quote"] {
            if let Some(v) = v.get(field) {
                result[field] = json!(string(v, &format!("link {field}"), 5000)?);
            }
        }
        out.push(result);
    }
    Ok(json!(out))
}
pub fn normalize_proposal_ops(value: &Value) -> Result<Value> {
    let ops = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 100)
        .ok_or_else(|| invalid("ops"))?;
    let names = [
        "add_card",
        "update_card",
        "add_edge",
        "delete_card",
        "delete_edge",
    ];
    let mut result = vec![];
    for op in ops {
        let operation = op["op"]
            .as_str()
            .or_else(|| op["type"].as_str().filter(|s| names.contains(s)))
            .or_else(|| op["operation"].as_str())
            .ok_or_else(|| invalid("op"))?;
        let normalized = match operation {
            "add_card" => {
                if !["card", "note"].contains(&op["kind"].as_str().unwrap_or("")) {
                    return Err(invalid("card kind"));
                }
                let mut v = json!({"type":"add_card","tempId":id(&op["tempId"],"tempId")?,"kind":op["kind"],"title":string(&op["title"],"title",500)?,
                    "note":string(op.get("note").filter(|v|!v.is_null()).unwrap_or(&json!("")),"note",50000)?,
                    "tags":tags(op.get("tags").filter(|v|!v.is_null()).unwrap_or(&json!([])))?,"links":links(op.get("links").filter(|v|!v.is_null()).unwrap_or(&json!([])))?});
                if let Some(c) = op.get("color") {
                    v["color"] = color(c)?;
                }
                if let Some(b) = op.get("band") {
                    let b = string(b, "band", 60)?.trim().to_owned();
                    if b.is_empty() {
                        return Err(invalid("band"));
                    }
                    v["band"] = json!(b);
                }
                v
            }
            "update_card" => {
                let mut v = json!({"type":"update_card","cardId":id(&op["cardId"],"cardId")?});
                for (field, limit) in [("title", 500), ("note", 50000)] {
                    if let Some(s) = op.get(field) {
                        v[field] = json!(string(s, field, limit)?);
                    }
                }
                if let Some(s) = op.get("tags") {
                    v["tags"] = tags(s)?;
                }
                if let Some(s) = op.get("links") {
                    v["links"] = links(s)?;
                }
                if let Some(s) = op.get("color") {
                    v["color"] = color(s)?;
                }
                if v.as_object().unwrap().len() == 2 {
                    return Err(AppError::new(400, "proposal update has no fields"));
                }
                v
            }
            "add_edge" => {
                let kind = op
                    .get("edgeType")
                    .filter(|v| !v.is_null())
                    .or_else(|| op.get("typeName").filter(|v| !v.is_null()))
                    .or_else(|| op.get("relation").filter(|v| !v.is_null()))
                    .or_else(|| {
                        if op["op"] == "add_edge" || op["operation"] == "add_edge" {
                            op.get("type")
                        } else {
                            None
                        }
                    })
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !["builds", "uses", "question"].contains(&kind) {
                    return Err(invalid("edge type"));
                }
                json!({"type":"add_edge","from":id(&op["from"],"edge from")?,"to":id(&op["to"],"edge to")?,"edgeType":kind,"label":string(op.get("label").filter(|v|!v.is_null()).unwrap_or(&json!("")),"edge label",500)?})
            }
            "delete_card" => json!({"type":"delete_card","cardId":id(&op["cardId"],"cardId")?}),
            "delete_edge" => {
                json!({"type":"delete_edge","from":id(&op["from"],"edge from")?,"to":id(&op["to"],"edge to")?})
            }
            _ => return Err(invalid("op")),
        };
        result.push(normalized);
    }
    Ok(json!(result))
}
pub fn cards(data: &Value) -> &[Value] {
    data["cards"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn edges(data: &Value) -> &[Value] {
    data["edges"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn card<'a>(data: &'a Value, id: &Value) -> Option<&'a Value> {
    cards(data).iter().find(|c| c["id"] == *id)
}
fn edge<'a>(data: &'a Value, a: &Value, b: &Value) -> Option<&'a Value> {
    edges(data)
        .iter()
        .find(|e| (e["from"] == *a && e["to"] == *b) || (e["from"] == *b && e["to"] == *a))
}
fn snapshot(list: &mut Vec<Value>, v: Option<&Value>) {
    if let Some(v) = v {
        if !list.iter().any(|i| i["id"] == v["id"]) {
            list.push(v.clone());
        }
    }
}
pub fn validate_proposal(wall: &Value, ops: &Value) -> Result<Value> {
    if !wall["data"].is_object() {
        return Err(AppError::new(404, "wall not found"));
    }
    let data = &wall["data"];
    let normalized = normalize_proposal_ops(ops)?;
    let existing: HashSet<&str> = cards(data)
        .iter()
        .filter_map(|c| c["id"].as_str())
        .collect();
    let bands: HashSet<&str> = data["bands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["title"].as_str())
        .collect();
    let mut temp = HashSet::new();
    for op in normalized
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["type"] == "add_card")
    {
        if let Some(b) = op["band"].as_str() {
            if !bands.contains(b) {
                return Err(AppError::new(400, "proposal band not found"));
            }
        }
        let id = op["tempId"].as_str().unwrap();
        if existing.contains(id) || !temp.insert(id) {
            return Err(AppError::new(400, "duplicate proposal tempId"));
        }
    }
    let mut base_cards = vec![];
    let mut base_edges = vec![];
    for op in normalized.as_array().unwrap() {
        match op["type"].as_str().unwrap() {
            "add_card" => {}
            "update_card" | "delete_card" => {
                let c = card(data, &op["cardId"])
                    .ok_or_else(|| AppError::new(400, "proposal card not found"))?;
                snapshot(&mut base_cards, Some(c));
                if op["type"] == "delete_card" {
                    for e in edges(data)
                        .iter()
                        .filter(|e| e["from"] == op["cardId"] || e["to"] == op["cardId"])
                    {
                        snapshot(&mut base_edges, Some(e));
                    }
                }
            }
            _ => {
                let (a, b) = (op["from"].as_str().unwrap(), op["to"].as_str().unwrap());
                if !(existing.contains(a) || temp.contains(a))
                    || !(existing.contains(b) || temp.contains(b))
                    || a == b
                {
                    return Err(AppError::new(400, "proposal edge endpoint not found"));
                }
                if op["type"] == "delete_edge" {
                    let e = edge(data, &op["from"], &op["to"])
                        .ok_or_else(|| AppError::new(400, "proposal edge not found"))?;
                    snapshot(&mut base_edges, Some(e));
                }
                snapshot(&mut base_cards, card(data, &op["from"]));
                snapshot(&mut base_cards, card(data, &op["to"]));
            }
        }
    }
    Ok(json!({"ops":normalized,"baseCards":{"cards":base_cards,"edges":base_edges}}))
}
pub fn deterministic_id(prefix: &str, proposal: &str, value: &str) -> String {
    format!(
        "{prefix}-{}",
        &format!(
            "{:x}",
            Sha256::digest(format!("{proposal}\0{value}").as_bytes())
        )[..32]
    )
}
pub fn proposal_payload(wall_id: &str, ops: &Value, rationale: &str) -> String {
    json!({"wallId":wall_id,"ops":ops,"rationale":rationale}).to_string()
}
pub fn status(statuses: &Value) -> &'static str {
    let s = statuses.as_array().unwrap();
    if s.iter().all(|v| v == "pending") {
        "pending"
    } else if s.iter().all(|v| v == "rejected") {
        "rejected"
    } else if s.iter().all(|v| v == "applied") {
        "applied"
    } else {
        "partial"
    }
}
fn content(card: &Value) -> Value {
    let mut c = card.clone();
    if let Some(c) = c.as_object_mut() {
        for key in ["x", "y", "w", "h", "color", "fold", "mount"] {
            c.remove(key);
        }
    }
    c
}
fn tag_ids(data: &mut Value, names: &Value) -> Value {
    if !data["tags"].is_array() {
        data["tags"] = json!([]);
    }
    let tags = data["tags"].as_array_mut().unwrap();
    let mut result = vec![];
    for name in names.as_array().unwrap() {
        let id = if let Some(tag) = tags.iter().find(|t| t["name"] == *name) {
            tag["id"].clone()
        } else {
            let mut id = deterministic_id("t", "wall", name.as_str().unwrap());
            while tags.iter().any(|t| t["id"] == id && t["name"] != *name) {
                id = format!(
                    "t-{}",
                    &format!("{:x}", Sha256::digest(id.as_bytes()))[..32]
                );
            }
            tags.push(json!({"id":id,"name":name,"color":"slate"}));
            json!(id)
        };
        if !result.contains(&id) {
            result.push(id);
        }
    }
    json!(result)
}
pub fn indexes(value: &Value, count: usize) -> Result<HashSet<usize>> {
    let a = value.as_array().ok_or_else(|| invalid("opIndexes"))?;
    let mut result = HashSet::new();
    for v in a {
        let n = v
            .as_u64()
            .filter(|n| *n <= 9007199254740991 && *n < count as u64)
            .ok_or_else(|| invalid("opIndexes"))?;
        result.insert(n as usize);
    }
    Ok(result)
}
pub struct Simulation {
    pub before: Value,
    pub after: Value,
    pub statuses: Value,
    pub affected: Value,
    pub results: Value,
    pub temp_ids: Map<String, Value>,
}
impl Simulation {
    pub fn changed(&self) -> bool {
        self.before != self.after
    }
}
pub fn simulate(proposal: &Value, wall: &Value, selected: &Value) -> Result<Simulation> {
    let ops = proposal["ops"].as_array().ok_or_else(|| invalid("ops"))?;
    let selected = indexes(selected, ops.len())?;
    let before = wall["data"].clone();
    let mut after = before.clone();
    for key in ["cards", "edges"] {
        if !after[key].is_array() {
            after[key] = json!([]);
        }
    }
    let mut statuses = proposal["opStatus"].clone();
    let base = &proposal["baseCards"];
    let pid = proposal["id"].as_str().unwrap();
    let mut temp_ids = Map::new();
    for op in ops.iter().filter(|op| op["type"] == "add_card") {
        let id = deterministic_id("c", pid, op["tempId"].as_str().unwrap());
        if card(&after, &json!(id)).is_some() {
            temp_ids.insert(op["tempId"].as_str().unwrap().to_owned(), json!(id));
        }
    }
    let mut results:Vec<Value>=ops.iter().enumerate().map(|(i,_)|json!({"index":i,"status":statuses[i],"selected":selected.contains(&i),"changed":false})).collect();
    let mut affected = json!({"cards":[],"edges":[],"opIndexes":[]});
    let mut new_ids = HashSet::new();
    let mut band_y = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        if !selected.contains(&i) || statuses[i] != "pending" {
            continue;
        }
        let kind = op["type"].as_str().unwrap();
        let endpoint = |v: &Value| {
            temp_ids
                .get(v.as_str().unwrap_or(""))
                .cloned()
                .unwrap_or_else(|| v.clone())
        };
        let conflict = match kind {
            "update_card" | "delete_card" => {
                match (card(&after, &op["cardId"]), card(base, &op["cardId"])) {
                    (Some(a), Some(b)) => content(a) != content(b),
                    _ => true,
                }
            }
            "delete_edge" => match (
                edge(&after, &op["from"], &op["to"]),
                edge(base, &op["from"], &op["to"]),
            ) {
                (Some(a), Some(b)) => a != b,
                _ => true,
            },
            "add_edge" => {
                card(&after, &endpoint(&op["from"])).is_none()
                    || card(&after, &endpoint(&op["to"])).is_none()
            }
            _ => false,
        };
        if conflict {
            statuses[i] = json!("conflict");
            results[i]["status"] = json!("conflict");
            continue;
        }
        match kind {
            "add_card" => {
                let id = deterministic_id("c", pid, op["tempId"].as_str().unwrap());
                let existing = card(&after, &json!(id)).cloned();
                let (x, y) = if let Some(c) = &existing {
                    (
                        c["x"].as_f64().unwrap_or(0.0),
                        c["y"].as_f64().unwrap_or(0.0),
                    )
                } else if op.get("band").is_some() {
                    layout::place_card(&after, op)
                } else {
                    (0.0, 0.0)
                };
                let tags = tag_ids(&mut after, &op["tags"]);
                let mut c = json!({"id":id,"kind":op["kind"],"x":x,"y":y,"title":op["title"],"note":op["note"],"tags":tags,"links":op["links"]});
                if let Some(v) = op.get("color") {
                    c["color"] = v.clone();
                }
                temp_ids.insert(op["tempId"].as_str().unwrap().to_owned(), json!(id));
                if let Some(existing) = existing {
                    if existing != c {
                        statuses[i] = json!("conflict");
                        results[i]["status"] = json!("conflict");
                        continue;
                    }
                } else {
                    after["cards"].as_array_mut().unwrap().push(c);
                    new_ids.insert(id.clone());
                    if let Some(b) = after["bands"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|b| b["title"] == op["band"])
                    {
                        band_y.insert(id.clone(), b["y"].as_f64().unwrap_or(0.0) + 60.0);
                    }
                    results[i]["changed"] = json!(true);
                    add_affected(&mut affected, "cards", json!(id));
                }
            }
            "update_card" => {
                let tags = if op.get("tags").is_some() {
                    Some(tag_ids(&mut after, &op["tags"]))
                } else {
                    None
                };
                let c = after["cards"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|c| c["id"] == op["cardId"])
                    .unwrap();
                for field in ["title", "note", "links", "color"] {
                    if let Some(v) = op.get(field) {
                        c[field] = v.clone();
                    }
                }
                if let Some(tags) = tags {
                    c["tags"] = tags;
                }
                results[i]["changed"] = json!(true);
                add_affected(&mut affected, "cards", c["id"].clone());
            }
            "add_edge" => {
                let (a, b) = (endpoint(&op["from"]), endpoint(&op["to"]));
                if edge(&after, &a, &b).is_none() {
                    let id = deterministic_id("e", pid, &i.to_string());
                    after["edges"].as_array_mut().unwrap().push(
                        json!({"id":id,"from":a,"to":b,"type":op["edgeType"],"label":op["label"]}),
                    );
                    results[i]["changed"] = json!(true);
                    add_affected(&mut affected, "edges", json!(id));
                }
            }
            "delete_card" => {
                for e in edges(&after)
                    .iter()
                    .filter(|e| e["from"] == op["cardId"] || e["to"] == op["cardId"])
                {
                    add_affected(&mut affected, "edges", e["id"].clone());
                }
                after["cards"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|c| c["id"] != op["cardId"]);
                after["edges"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|e| e["from"] != op["cardId"] && e["to"] != op["cardId"]);
                results[i]["changed"] = json!(true);
                add_affected(&mut affected, "cards", op["cardId"].clone());
            }
            "delete_edge" => {
                let id = edge(&after, &op["from"], &op["to"]).unwrap()["id"].clone();
                let index = after["edges"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|e| e["id"] == id)
                    .unwrap();
                after["edges"].as_array_mut().unwrap().remove(index);
                results[i]["changed"] = json!(true);
                add_affected(&mut affected, "edges", id);
            }
            _ => {}
        }
        statuses[i] = json!("applied");
        results[i]["status"] = json!("applied");
        affected["opIndexes"].as_array_mut().unwrap().push(json!(i));
    }
    if !new_ids.is_empty() {
        layout::layout_new_cards(&mut after, &new_ids, &band_y);
    }
    Ok(Simulation {
        before,
        after,
        statuses,
        affected,
        results: json!(results),
        temp_ids,
    })
}
fn add_affected(affected: &mut Value, key: &str, v: Value) {
    let a = affected[key].as_array_mut().unwrap();
    if !v.is_null() && !a.contains(&v) {
        a.push(v);
    }
}
