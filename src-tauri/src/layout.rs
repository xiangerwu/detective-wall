//! Server-side subset of assets/layout.js; the browser keeps its existing layout code.
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

pub fn width(card: &Value) -> f64 {
    card["w"]
        .as_f64()
        .unwrap_or(if card["kind"] == "note" { 170.0 } else { 200.0 })
}
pub fn height(card: &Value) -> f64 {
    card["h"].as_f64().unwrap_or_else(|| {
        let title = card["title"].as_str().unwrap_or("");
        let note = card["note"].as_str().unwrap_or("");
        let title_lines = (title.encode_utf16().count() as f64 / 24.0).ceil().max(1.0);
        let note_lines: f64 = if note.is_empty() {
            0.0
        } else {
            note.split('\n')
                .map(|line| {
                    (line.trim_end_matches('\r').encode_utf16().count() as f64 / 42.0)
                        .ceil()
                        .max(1.0)
                })
                .sum()
        };
        (52.0 + title_lines * 22.0 + note_lines * 18.0 + if note.is_empty() { 0.0 } else { 8.0 })
            .clamp(140.0, 360.0)
    })
}
fn n(card: &Value, key: &str) -> f64 {
    card[key].as_f64().unwrap_or(0.0)
}
fn hash(value: &str) -> u32 {
    value
        .encode_utf16()
        .fold(2166136261u32, |h, c| (h ^ c as u32).wrapping_mul(16777619))
}

fn grid(cards: &[Value], y: f64, w: f64, h: f64) -> (f64, f64) {
    // ponytail: preserve the existing fixed-column placement; change both runtimes together if it changes.
    for row in 0u64.. {
        for col in 0..1000 {
            let x = 80.0 + col as f64 * 420.0;
            let top = y + row as f64 * 160.0;
            if !cards.iter().any(|c| {
                x < n(c, "x") + width(c)
                    && n(c, "x") < x + w
                    && top < n(c, "y") + height(c)
                    && n(c, "y") < top + h
            }) {
                return (x, top);
            }
        }
    }
    unreachable!()
}
pub fn place_card(data: &Value, op: &Value) -> (f64, f64) {
    let y = data["bands"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["title"] == op["band"])
        .map(|b| n(b, "y"))
        .unwrap_or(0.0)
        + 60.0;
    grid(
        data["cards"].as_array().map(Vec::as_slice).unwrap_or(&[]),
        y,
        width(op),
        height(op),
    )
}
pub fn layout_new_cards(
    data: &mut Value,
    new_ids: &HashSet<String>,
    band_y: &HashMap<String, f64>,
) {
    let mut cards = data["cards"].as_array().cloned().unwrap_or_default();
    let by_id: HashMap<String, usize> = cards
        .iter()
        .enumerate()
        .filter_map(|(i, c)| Some((c["id"].as_str()?.to_owned(), i)))
        .collect();
    let mut neighbours: HashMap<String, Vec<String>> =
        new_ids.iter().map(|id| (id.clone(), vec![])).collect();
    for edge in data["edges"].as_array().into_iter().flatten() {
        let (a, b) = (
            edge["from"].as_str().unwrap_or(""),
            edge["to"].as_str().unwrap_or(""),
        );
        if let Some(v) = neighbours.get_mut(a) {
            v.push(b.to_owned());
        }
        if let Some(v) = neighbours.get_mut(b) {
            v.push(a.to_owned());
        }
    }
    let fixed: Vec<Value> = cards
        .iter()
        .filter(|c| !new_ids.contains(c["id"].as_str().unwrap_or("")))
        .cloned()
        .collect();
    let mut unseen: BTreeSet<String> = new_ids.iter().cloned().collect();
    while let Some(start) = unseen.first().cloned() {
        unseen.remove(&start);
        let mut queue = VecDeque::from([start]);
        let mut component = vec![];
        while let Some(id) = queue.pop_front() {
            for next in &neighbours[&id] {
                if unseen.remove(next) {
                    queue.push_back(next.clone());
                }
            }
            component.push(id);
        }
        component.sort();
        let anchors: BTreeSet<String> = component
            .iter()
            .flat_map(|id| neighbours[id].iter())
            .filter(|id| !new_ids.contains(*id) && by_id.contains_key(*id))
            .cloned()
            .collect();
        let (ox, oy) = if !anchors.is_empty() {
            let points: Vec<_> = anchors.iter().map(|id| &cards[by_id[id]]).collect();
            (
                points
                    .iter()
                    .map(|c| n(c, "x") + width(c) / 2.0)
                    .sum::<f64>()
                    / points.len() as f64,
                points
                    .iter()
                    .map(|c| n(c, "y") + height(c) / 2.0)
                    .sum::<f64>()
                    / points.len() as f64,
            )
        } else {
            let w = component
                .iter()
                .map(|id| width(&cards[by_id[id]]))
                .fold(0.0, f64::max);
            let h = component
                .iter()
                .map(|id| height(&cards[by_id[id]]))
                .fold(0.0, f64::max);
            let y = component
                .iter()
                .filter_map(|id| band_y.get(id).copied())
                .reduce(f64::min)
                .unwrap_or(0.0);
            let (x, y) = grid(&fixed, y, w, h);
            (x + w / 2.0, y + h / 2.0)
        };
        for (i, id) in component.iter().enumerate() {
            let angle = if component.len() == 1 {
                0.0
            } else {
                -std::f64::consts::FRAC_PI_4
                    + i as f64 * std::f64::consts::TAU / component.len() as f64
            };
            let radius = if component.len() == 1 { 240.0 } else { 250.0 };
            let c = &mut cards[by_id[id]];
            c["x"] = json!(ox + angle.cos() * radius - width(c) / 2.0);
            c["y"] = json!(oy + angle.sin() * radius - height(c) / 2.0);
        }
    }
    let mut order: Vec<usize> = (0..cards.len()).collect();
    order.sort_by(|a, b| cards[*a]["id"].as_str().cmp(&cards[*b]["id"].as_str()));
    let mut active = HashSet::new();
    for i in 0..order.len() {
        for j in i + 1..order.len() {
            let (a, b) = (&cards[order[i]], &cards[order[j]]);
            if overlap(a, b).0 > 0.0 && overlap(a, b).1 > 0.0 {
                for c in [a, b] {
                    let id = c["id"].as_str().unwrap_or("");
                    if new_ids.contains(id) {
                        active.insert(id.to_owned());
                    }
                }
            }
        }
    }
    for _ in 0..48 {
        let mut moved = false;
        for i in 0..order.len() {
            for j in i + 1..order.len() {
                let (ai, bi) = (order[i], order[j]);
                let (a, b) = (&cards[ai], &cards[bi]);
                let (ma, mb) = (
                    active.contains(a["id"].as_str().unwrap_or("")),
                    active.contains(b["id"].as_str().unwrap_or("")),
                );
                let (ox, oy) = overlap(a, b);
                if ox <= 0.0 || oy <= 0.0 || (!ma && !mb) {
                    continue;
                }
                let horizontal = ox < oy;
                let key = if horizontal { "x" } else { "y" };
                let delta = if horizontal {
                    n(b, "x") + width(b) / 2.0 - n(a, "x") - width(a) / 2.0
                } else {
                    n(b, "y") + height(b) / 2.0 - n(a, "y") - height(a) / 2.0
                };
                let mut sign = if delta > 0.0 {
                    1.0
                } else if delta < 0.0 {
                    -1.0
                } else {
                    0.0
                };
                if sign == 0.0 {
                    sign = if !horizontal && ma && !mb {
                        -1.0
                    } else if !horizontal && !ma && mb {
                        1.0
                    } else if hash(&format!(
                        "{}\0{}{}",
                        a["id"].as_str().unwrap_or(""),
                        b["id"].as_str().unwrap_or(""),
                        key
                    )) % 2
                        == 1
                    {
                        1.0
                    } else {
                        -1.0
                    };
                }
                let amount = if horizontal { ox } else { oy };
                let each = if ma && mb { amount / 2.0 } else { amount };
                let (av, bv) = (n(a, key), n(b, key));
                if ma {
                    cards[ai][key] = json!(av - sign * each);
                }
                if mb {
                    cards[bi][key] = json!(bv + sign * each);
                }
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    for c in &mut cards {
        if new_ids.contains(c["id"].as_str().unwrap_or("")) {
            for key in ["x", "y"] {
                let v = (n(c, key) * 1000.0 + 0.5).floor() / 1000.0;
                c[key] = json!(if v == 0.0 { 0.0 } else { v });
            }
        }
    }
    data["cards"] = json!(cards);
}
fn overlap(a: &Value, b: &Value) -> (f64, f64) {
    (
        (width(a) + width(b)) / 2.0 + 25.0
            - (n(b, "x") + width(b) / 2.0 - n(a, "x") - width(a) / 2.0).abs(),
        (height(a) + height(b)) / 2.0 + 25.0
            - (n(b, "y") + height(b) / 2.0 - n(a, "y") - height(a) / 2.0).abs(),
    )
}
