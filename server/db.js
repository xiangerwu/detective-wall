const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, constants: sqliteConstants } = require('node:sqlite');
const { createHash } = require('node:crypto');
const wallLayout = require('./layout.js');

class VersionConflict extends Error {
  constructor() {
    super('wall version conflict');
    this.status = 409;
  }
}

class ProposalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PROPOSAL_LIMITS = {
  ops: 100,
  id: 200,
  tempId: 100,
  title: 500,
  note: 50000,
  tag: 100,
  tags: 100,
  links: 100,
  href: 4096,
  linkText: 5000,
  label: 500,
  band: 60,
  rationale: 10000,
  idempotencyKey: 200,
};

const proposalJson = value => JSON.stringify(value);
const clone = value => structuredClone(value);

function safeSourceHref(value) {
  if (typeof value !== 'string' || !value || value.length > PROPOSAL_LIMITS.href) return false;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let decoded = trimmed;
  for (let attempt = 0; attempt < 8; attempt++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break;
    decoded = next;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return false;
  if (/^[\\/]{2}/.test(decoded)) return false;
  if (/^[A-Za-z]:[\\/]/.test(decoded) || decoded.startsWith('/')) return true;
  const probe = decoded.replace(/[\s\\]/g, '').toLowerCase();
  const scheme = probe.match(/^([a-z][a-z\d+.-]*):/)?.[1];
  return !scheme || ['http', 'https', 'file', 'mailto'].includes(scheme);
}

function proposalString(value, label, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new ProposalError(400, `invalid proposal ${label}`);
  return value;
}

function proposalId(value, label) {
  const result = proposalString(value, label, PROPOSAL_LIMITS.id);
  if (!result) throw new ProposalError(400, `invalid proposal ${label}`);
  return result;
}

function proposalTags(value) {
  if (!Array.isArray(value) || value.length > PROPOSAL_LIMITS.tags) throw new ProposalError(400, 'invalid proposal tags');
  return value.map(tag => {
    const name = proposalString(tag, 'tag', PROPOSAL_LIMITS.tag).trim();
    if (!name) throw new ProposalError(400, 'invalid proposal tag');
    return name;
  });
}

function proposalLinks(value) {
  if (!Array.isArray(value) || value.length > PROPOSAL_LIMITS.links) throw new ProposalError(400, 'invalid proposal links');
  return value.map(link => {
    if (!link || typeof link !== 'object' || Array.isArray(link)) throw new ProposalError(400, 'invalid proposal link');
    const href = proposalString(link.href, 'link href', PROPOSAL_LIMITS.href);
    if (!safeSourceHref(href)) throw new ProposalError(400, 'invalid proposal link href');
    const result = {label: typeof link.label === 'string' ? link.label : href, href};
    if (result.label.length > PROPOSAL_LIMITS.linkText) throw new ProposalError(400, 'invalid proposal link label');
    for (const field of ['locator', 'quote']) {
      if (link[field] !== undefined) result[field] = proposalString(link[field], `link ${field}`, PROPOSAL_LIMITS.linkText);
    }
    return result;
  });
}

function edgeKey(edge) {
  return [edge.from, edge.to].sort().join('\n');
}

function cardIn(data, id) {
  return (Array.isArray(data.cards) ? data.cards : []).find(card => card?.id === id);
}

function edgeIn(data, from, to) {
  return (Array.isArray(data.edges) ? data.edges : []).find(edge => edgeKey(edge) === edgeKey({from, to}));
}

function pushSnapshot(list, value, key) {
  if (value && !list.some(item => item[key] === value[key])) list.push(clone(value));
}

function normalizeProposalOp(op) {
  const names = new Set(['add_card', 'update_card', 'add_edge', 'delete_card', 'delete_edge']);
  const operation = op && typeof op === 'object' && !Array.isArray(op)
    ? (typeof op.op === 'string' ? op.op : names.has(op.type) ? op.type : op.operation)
    : undefined;
  if (!names.has(operation)) {
    throw new ProposalError(400, 'invalid proposal op');
  }
  switch (operation) {
    case 'add_card':
      const result = {
        type: 'add_card',
        tempId: proposalId(op.tempId, 'tempId'),
        kind: op.kind === 'note' ? 'note' : op.kind === 'card' ? 'card' : (() => { throw new ProposalError(400, 'invalid proposal card kind'); })(),
        title: proposalString(op.title, 'title', PROPOSAL_LIMITS.title),
        note: proposalString(op.note ?? '', 'note', PROPOSAL_LIMITS.note),
        tags: proposalTags(op.tags ?? []),
        links: proposalLinks(op.links ?? []),
      };
      if (op.band !== undefined) {
        result.band = proposalString(op.band, 'band', PROPOSAL_LIMITS.band).trim();
        if (!result.band) throw new ProposalError(400, 'invalid proposal band');
      }
      return result;
    case 'update_card': {
      const result = {type: 'update_card', cardId: proposalId(op.cardId, 'cardId')};
      if (op.title !== undefined) result.title = proposalString(op.title, 'title', PROPOSAL_LIMITS.title);
      if (op.note !== undefined) result.note = proposalString(op.note, 'note', PROPOSAL_LIMITS.note);
      if (op.tags !== undefined) result.tags = proposalTags(op.tags);
      if (op.links !== undefined) result.links = proposalLinks(op.links);
      if (Object.keys(result).length === 2) throw new ProposalError(400, 'proposal update has no fields');
      return result;
    }
    case 'add_edge':
      {
      const edgeType = op.edgeType ?? op.typeName ?? op.relation ?? (op.op === 'add_edge' || op.operation === 'add_edge' ? op.type : undefined);
      if (!['builds', 'uses', 'question'].includes(edgeType)) throw new ProposalError(400, 'invalid proposal edge type');
      return {
        type: 'add_edge',
        from: proposalId(op.from, 'edge from'),
        to: proposalId(op.to, 'edge to'),
        edgeType,
        label: proposalString(op.label ?? '', 'edge label', PROPOSAL_LIMITS.label),
      };
      }
    case 'delete_card':
      return {type: 'delete_card', cardId: proposalId(op.cardId, 'cardId')};
    case 'delete_edge':
      return {type: 'delete_edge', from: proposalId(op.from, 'edge from'), to: proposalId(op.to, 'edge to')};
    default:
      throw new ProposalError(400, 'invalid proposal op type');
  }
}

function validateProposal(wall, inputOps) {
  if (!wall || !wall.data || typeof wall.data !== 'object') throw new ProposalError(404, 'wall not found');
  const data = wall.data;
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const normalized = normalizeProposalOps(inputOps);
  const existingIds = new Set(cards.map(card => card?.id).filter(id => typeof id === 'string'));
  const bandNames = new Set((Array.isArray(data.bands) ? data.bands : [])
    .map(band => band?.title).filter(title => typeof title === 'string'));
  const tempIds = new Set();
  for (const op of normalized) {
    if (op.type !== 'add_card') continue;
    if (op.band !== undefined && !bandNames.has(op.band)) throw new ProposalError(400, 'proposal band not found');
    if (existingIds.has(op.tempId) || tempIds.has(op.tempId)) throw new ProposalError(400, 'duplicate proposal tempId');
    tempIds.add(op.tempId);
  }
  const baseCards = [], baseEdges = [];
  const addCard = card => pushSnapshot(baseCards, card, 'id');
  const addEdge = edge => pushSnapshot(baseEdges, edge, 'id');
  const resolveCard = id => existingIds.has(id) || tempIds.has(id);
  for (const op of normalized) {
    if (op.type === 'add_card') continue;
    if (op.type === 'update_card' || op.type === 'delete_card') {
      const card = cardIn(data, op.cardId);
      if (!card) throw new ProposalError(400, 'proposal card not found');
      addCard(card);
      if (op.type === 'delete_card') for (const edge of Array.isArray(data.edges) ? data.edges : []) {
        if (edge?.from === op.cardId || edge?.to === op.cardId) addEdge(edge);
      }
      continue;
    }
    if (!resolveCard(op.from) || !resolveCard(op.to) || op.from === op.to) {
      throw new ProposalError(400, 'proposal edge endpoint not found');
    }
    if (op.type === 'add_edge') {
      addCard(cardIn(data, op.from));
      addCard(cardIn(data, op.to));
    } else {
      const edge = edgeIn(data, op.from, op.to);
      if (!edge) throw new ProposalError(400, 'proposal edge not found');
      addEdge(edge);
      addCard(cardIn(data, op.from));
      addCard(cardIn(data, op.to));
    }
  }
  return {ops: normalized, baseCards: {cards: baseCards, edges: baseEdges}};
}

function normalizeProposalOps(inputOps) {
  if (!Array.isArray(inputOps) || inputOps.length < 1 || inputOps.length > PROPOSAL_LIMITS.ops) {
    throw new ProposalError(400, 'invalid proposal ops');
  }
  return inputOps.map(normalizeProposalOp);
}

function proposalPayload(wallId, ops, rationale) {
  return proposalJson({wallId, ops, rationale: rationale || ''});
}

function parseProposal(row, auditIds = []) {
  if (!row) return undefined;
  const ops = JSON.parse(row.ops);
  const baseCards = JSON.parse(row.base_cards);
  const opStatus = JSON.parse(row.op_status);
  const counts = Object.fromEntries(['pending', 'applied', 'rejected', 'conflict'].map(status => [status, opStatus.filter(value => value === status).length]));
  return {
    id: row.id,
    proposalId: row.id,
    wallId: row.wall_id,
    baseVersion: row.base_version,
    status: row.status,
    created: row.created,
    client: row.client,
    idempotencyKey: row.idempotency_key,
    rationale: row.rationale,
    ops,
    baseCards,
    opStatus,
    counts,
    auditIds,
  };
}

function proposalStatus(opStatus) {
  if (!opStatus.length || opStatus.every(status => status === 'pending')) return 'pending';
  if (opStatus.every(status => status === 'rejected')) return 'rejected';
  if (opStatus.every(status => status === 'applied')) return 'applied';
  return 'partial';
}

function proposalRow(db, id) {
  return db.prepare('SELECT id, wall_id, base_version, status, created, client, idempotency_key, rationale, ops, base_cards, op_status FROM proposals WHERE id = ?').get(id);
}

function proposalByKey(db, key) {
  return db.prepare('SELECT id, wall_id, base_version, status, created, client, idempotency_key, rationale, ops, base_cards, op_status FROM proposals WHERE idempotency_key = ?').get(key);
}

function sameProposalPayload(row, proposal) {
  return row.wall_id === proposal.wallId && row.rationale === proposal.rationale && proposalJson(JSON.parse(row.ops)) === proposalJson(proposal.ops);
}

function insertProposalRow(db, transaction, proposal) {
  return transaction(() => {
    const existing = proposalByKey(db, proposal.idempotencyKey);
    if (existing) {
      if (!sameProposalPayload(existing, proposal)) throw new ProposalError(409, 'idempotency key already used with different payload');
      return parseProposal(existing);
    }
    db.prepare(`INSERT INTO proposals
      (id, wall_id, base_version, status, created, client, idempotency_key, rationale, ops, base_cards, op_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(proposal.id, proposal.wallId, proposal.baseVersion, 'pending', proposal.created, proposal.client,
        proposal.idempotencyKey, proposal.rationale, proposalJson(proposal.ops), proposalJson(proposal.baseCards),
        proposalJson(proposal.ops.map(() => 'pending')));
    return parseProposal(proposalRow(db, proposal.id));
  });
}

function insertBackupRow(db, wallId, reason, data) {
  const encoded = proposalJson(data);
  const rows = db.prepare('SELECT id, data FROM backups WHERE wall_id = ? ORDER BY id').all(wallId);
  const latest = rows.at(-1);
  if (latest && latest.data === encoded) return Number(latest.id);
  const result = db.prepare(
    'INSERT INTO backups (wall_id, at, reason, cards, edges, data) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(wallId, Date.now(), reason, data.cards.length, data.edges.length, encoded);
  const excess = rows.length + 1 - 20;
  if (excess > 0) for (const row of rows.slice(0, excess)) db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
  return Number(result.lastInsertRowid);
}

function deterministicId(prefix, proposalId, value) {
  return `${prefix}-${createHash('sha256').update(`${proposalId}\0${value}`).digest('hex').slice(0, 32)}`;
}

function tagIds(data, names) {
  if (!Array.isArray(data.tags)) data.tags = [];
  const result = [];
  for (const name of names) {
    let tag = data.tags.find(row => row?.name === name);
    if (!tag) {
      tag = {id: deterministicId('t', 'wall', name), name, color: 'slate'};
      while (data.tags.some(row => row.id === tag.id && row.name !== name)) tag.id = 't-' + createHash('sha256').update(tag.id).digest('hex').slice(0, 32);
      data.tags.push(tag);
    }
    if (!result.includes(tag.id)) result.push(tag.id);
  }
  return result;
}

// Moving, resizing, recoloring, folding or re-pinning a card is not a content change, so it does not block AI edits.
const cardContent = ({x, y, size, color, fold, pin, ...content}) => proposalJson(content);
function matchingCardSnapshot(data, baseCards, cardId) {
  const expected = baseCards.cards.find(card => card.id === cardId);
  const current = cardIn(data, cardId);
  return expected && current && cardContent(expected) === cardContent(current);
}

function matchingEdgeSnapshot(data, baseCards, from, to) {
  const expected = baseCards.edges.find(edge => edgeKey(edge) === edgeKey({from, to}));
  const current = edgeIn(data, from, to);
  return expected && current && proposalJson(expected) === proposalJson(current);
}

// The band grid keeps its legacy 140px row; non-band layout uses the shared
// title/note height heuristic from server/layout.js.
const CARD_H = 140;
const cardWidth = card => (card.kind === 'note' ? 170 : 200) * ({s: .8, m: 1, l: 1.4, xl: 1.8}[card.size] || 1);
function freeSpot(cards, x, y, width) {
  const hits = top => cards.some(c => x < c.x + cardWidth(c) && c.x < x + width && top < c.y + CARD_H && c.y < top + CARD_H);
  while (hits(y)) y += CARD_H + 20;
  return {x, y};
}
function freeGridSpot(cards, y, width) {
  // ponytail: fixed columns cover the largest card; use measured card geometry if layouts become denser.
  const stepX = 420, stepY = CARD_H + 20;
  for (let row = 0; ; row++) for (let column = 0; column < 1000; column++) {
    const point = freeSpot(cards, 80 + column * stepX, y + row * stepY, width);
    if (point.y === y + row * stepY) return point;
  }
}
function placeCard(data, op) {
  const band = (Array.isArray(data.bands) ? data.bands : []).find(value => value?.title === op.band);
  return freeGridSpot(data.cards, (band?.y || 0) + 60, cardWidth(op));
}

function layoutNewCards(data, newIds) {
  const cards = data.cards.map(card => ({
    id: card.id,
    width: cardWidth(card),
    height: Math.max(CARD_H, wallLayout.estimateHeight(card)),
    fixed: !newIds.has(card.id),
    x: card.x,
    y: card.y,
  }));
  const positions = wallLayout.layout(cards, data.edges);
  for (const card of data.cards) if (newIds.has(card.id)) {
    const point = positions[card.id];
    if (point) { card.x = point.x; card.y = point.y; }
  }
}

function simulateProposal(row, wallRow, opIndexes) {
  const ops = JSON.parse(row.ops), baseCards = JSON.parse(row.base_cards), opStatus = JSON.parse(row.op_status);
  if (opIndexes.some(index => index >= ops.length)) throw new ProposalError(400, 'invalid proposal opIndexes');
  const selected = new Set(opIndexes), before = JSON.parse(wallRow.data), after = clone(before);
  if (!Array.isArray(after.cards)) after.cards = [];
  if (!Array.isArray(after.edges)) after.edges = [];
  const tempIds = new Map();
  for (const op of ops) if (op.type === 'add_card') {
    const derived = deterministicId('c', row.id, op.tempId);
    if (cardIn(after, derived)) tempIds.set(op.tempId, derived);
  }
  const affected = {cards: [], edges: [], opIndexes: []};
  const results = ops.map((op, index) => ({index, status: opStatus[index], selected: selected.has(index), changed: false}));
  const newNonBandIds = new Set();
  const addAffected = (kind, value) => { if (value && !affected[kind].includes(value)) affected[kind].push(value); };
  const resolveEndpoint = value => tempIds.get(value) || value;
  for (let index = 0; index < ops.length; index++) {
    if (!selected.has(index) || opStatus[index] !== 'pending') continue;
    const op = ops[index], result = results[index];
    let conflict = false;
    if (op.type === 'update_card' || op.type === 'delete_card') conflict = !matchingCardSnapshot(after, baseCards, op.cardId);
    if (op.type === 'delete_edge') conflict = !matchingEdgeSnapshot(after, baseCards, op.from, op.to);
    if (op.type === 'add_edge') {
      const from = resolveEndpoint(op.from), to = resolveEndpoint(op.to);
      conflict = !cardIn(after, from) || !cardIn(after, to);
    }
    if (conflict) {
      opStatus[index] = 'conflict';
      result.status = 'conflict';
      continue;
    }
    if (op.type === 'add_card') {
      const id = deterministicId('c', row.id, op.tempId), existing = cardIn(after, id);
      const point = existing ? {x: existing.x, y: existing.y} : op.band !== undefined ? placeCard(after, op) : {x: 0, y: 0};
      const tags = tagIds(after, op.tags), card = {id, kind: op.kind, x: point.x, y: point.y, title: op.title, note: op.note, tags, links: clone(op.links)};
      tempIds.set(op.tempId, id);
      if (existing) {
        if (proposalJson(existing) !== proposalJson(card)) {
          opStatus[index] = 'conflict'; result.status = 'conflict'; continue;
        }
      } else {
        after.cards.push(card);
        if (op.band === undefined) newNonBandIds.add(id);
        result.changed = true;
        addAffected('cards', id);
      }
    } else if (op.type === 'update_card') {
      const card = cardIn(after, op.cardId);
      if (op.title !== undefined) card.title = op.title;
      if (op.note !== undefined) card.note = op.note;
      if (op.tags !== undefined) card.tags = tagIds(after, op.tags);
      if (op.links !== undefined) card.links = clone(op.links);
      result.changed = true;
      addAffected('cards', card.id);
    } else if (op.type === 'add_edge') {
      const from = resolveEndpoint(op.from), to = resolveEndpoint(op.to);
      if (!edgeIn(after, from, to)) {
        const edge = {id: deterministicId('e', row.id, index), from, to, type: op.edgeType, label: op.label};
        after.edges.push(edge);
        result.changed = true;
        addAffected('edges', edge.id);
      }
    } else if (op.type === 'delete_card') {
      const removedEdges = after.edges.filter(edge => edge.from === op.cardId || edge.to === op.cardId);
      after.cards = after.cards.filter(card => card.id !== op.cardId);
      after.edges = after.edges.filter(edge => edge.from !== op.cardId && edge.to !== op.cardId);
      result.changed = true;
      addAffected('cards', op.cardId);
      for (const edge of removedEdges) addAffected('edges', edge.id);
    } else if (op.type === 'delete_edge') {
      const edge = edgeIn(after, op.from, op.to);
      after.edges = after.edges.filter(value => value !== edge);
      result.changed = true;
      addAffected('edges', edge.id);
    }
    opStatus[index] = 'applied';
    result.status = 'applied';
    affected.opIndexes.push(index);
  }
  if (newNonBandIds.size) layoutNewCards(after, newNonBandIds);
  return {ops, baseCards, opStatus, before, after, tempIds, affected, results, changed: proposalJson(before) !== proposalJson(after)};
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function snippet(value, query) {
  const text = String(value ?? '');
  if (text.length <= 120) return text;
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  let start = Math.max(0, (at < 0 ? 0 : at) - 50);
  let end = Math.min(text.length, start + 120);
  start = Math.max(0, end - 120);
  let result = text.slice(start, end);
  if (start > 0) result = '…' + result;
  if (end < text.length) result += '…';
  return result.slice(0, 120);
}

function createDatabase(filename, {readOnly = false} = {}) {
  const location = path.resolve(filename);
  if (readOnly) {
    if (!fs.existsSync(location)) throw new Error(`database not found: ${location}`);
  } else {
    fs.mkdirSync(path.dirname(location), {recursive: true});
  }
  const db = readOnly ? new DatabaseSync(location, {readOnly: true}) : new DatabaseSync(location);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS walls (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated INTEGER NOT NULL,
      version INTEGER NOT NULL,
      data JSON NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      record JSON NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      cards INTEGER NOT NULL,
      edges INTEGER NOT NULL,
      data JSON NOT NULL
    );
    CREATE INDEX IF NOT EXISTS backups_wall_id_id ON backups(wall_id, id);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value JSON NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      wall_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      created INTEGER NOT NULL,
      client TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      rationale TEXT NOT NULL,
      ops JSON NOT NULL,
      base_cards JSON NOT NULL,
      op_status JSON NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proposals_wall_status ON proposals(wall_id, status, created);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      proposal_id TEXT,
      wall_id TEXT NOT NULL,
      before_version INTEGER NOT NULL,
      after_version INTEGER NOT NULL,
      affected JSON NOT NULL,
      before JSON NOT NULL,
      after JSON NOT NULL,
      reverted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS audit_wall_id_id ON audit(wall_id, id);
    CREATE TABLE IF NOT EXISTS chat_sessions (
      wall_id TEXT NOT NULL,
      client TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY (wall_id, client)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id TEXT NOT NULL,
      client TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      error TEXT,
      status TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_messages_wall_client_id ON chat_messages(wall_id, client, id);
  `);
  if (!readOnly && !db.prepare('PRAGMA table_info(chat_messages)').all().some(column => column.name === 'status')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN status TEXT');
  }

  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };
  const wall = row => row && ({...row, data: JSON.parse(row.data)});
  const backup = row => row && ({...row, data: JSON.parse(row.data)});
  const image = row => row && JSON.parse(row.record);

  return {
    listWalls(full = false) {
      const rows = db.prepare('SELECT id, name, updated, version, data FROM walls ORDER BY id').all();
      return rows.map(row => full ? wall(row) : {id: row.id, name: row.name, updated: row.updated, version: row.version});
    },
    // ponytail: JSON LIKE keeps the existing schema; use FTS only if search volume makes it slow.
    search(query, limit = 50, wallIds = null, offset = 0) {
      const text = String(query).trim();
      if (!text) return [];
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid search limit');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid search offset');
      const pattern = likePattern(text);
      const ids = Array.isArray(wallIds) ? [...new Set(wallIds.filter(id => typeof id === 'string' && id))] : null;
      const wallFilter = ids === null ? '' : ids.length ? `WHERE w.id IN (${ids.map(() => '?').join(',')})` : 'WHERE 0';
      const rows = db.prepare(`
        WITH visible_walls AS (
          SELECT w.id, w.name, w.data
          FROM walls w
          ${wallFilter}
        ), cards AS (
          SELECT w.id AS wallId, w.name AS wallName, CAST(c.key AS INTEGER) AS cardOrder,
            json_extract(c.value, '$.id') AS cardId,
            json_extract(c.value, '$.title') AS title,
            json_extract(c.value, '$.note') AS note,
            c.value AS card, w.data AS wallData
          FROM visible_walls w, json_each(w.data, '$.cards') c
        ), matches AS (
          SELECT wallId, wallName, 'card' AS type, cardId, NULL AS edgeFrom, NULL AS edgeTo,
            'title' AS field, title, title AS matched, cardOrder, 0 AS fieldOrder, 0 AS sourceOrder
          FROM cards
          WHERE title IS NOT NULL AND lower(title) LIKE lower(?) ESCAPE char(92)
          UNION ALL
          SELECT wallId, wallName, 'card', cardId, NULL, NULL, 'note', title, note, cardOrder, 1, 0
          FROM cards
          WHERE note IS NOT NULL AND lower(note) LIKE lower(?) ESCAPE char(92)
          UNION ALL
          SELECT c.wallId, c.wallName, 'card', c.cardId, NULL, NULL, 'tag', c.title,
            json_extract(tag.value, '$.name'), c.cardOrder, 2, CAST(tag.key AS INTEGER)
          FROM cards c
          JOIN json_each(c.card, '$.tags') attached
          JOIN json_each(c.wallData, '$.tags') tag
            ON json_extract(tag.value, '$.id') = attached.value
          WHERE json_extract(tag.value, '$.name') IS NOT NULL
            AND lower(json_extract(tag.value, '$.name')) LIKE lower(?) ESCAPE char(92)
          UNION ALL
          SELECT w.id, w.name, 'edge', json_extract(fromCard.value, '$.id'),
            json_extract(edge.value, '$.from'), json_extract(edge.value, '$.to'), 'edge',
            json_extract(fromCard.value, '$.title'), json_extract(edge.value, '$.label'),
            CAST(fromCard.key AS INTEGER), 3, CAST(edge.key AS INTEGER)
          FROM visible_walls w
          JOIN json_each(w.data, '$.edges') edge
          JOIN json_each(w.data, '$.cards') fromCard
            ON json_extract(fromCard.value, '$.id') = json_extract(edge.value, '$.from')
          WHERE json_extract(edge.value, '$.label') IS NOT NULL
            AND lower(json_extract(edge.value, '$.label')) LIKE lower(?) ESCAPE char(92)
        )
        SELECT wallId, wallName, type, cardId, edgeFrom, edgeTo, field, title, matched
        FROM matches
        ORDER BY wallName COLLATE NOCASE, wallId, cardOrder, fieldOrder, sourceOrder
        LIMIT ? OFFSET ?
      `).all(...(ids || []), pattern, pattern, pattern, pattern, limit, offset);
      return rows.map(({matched, edgeFrom, edgeTo, ...row}) => ({...row,
        ...(row.type === 'edge' ? {edgeFrom, edgeTo} : {}), snippet: snippet(matched, text)}));
    },
    getProject() {
      const images = db.prepare('SELECT record FROM images ORDER BY id').all().map(row => JSON.parse(row.record));
      const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta ORDER BY key').all()
        .map(row => [row.key, JSON.parse(row.value)]));
      return {
        format: 'detective-wall-project',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        walls: this.listWalls(true),
        images,
        meta,
      };
    },
    replaceProject(project) {
      return transaction(() => {
        db.prepare('DELETE FROM proposals').run();
        db.prepare('DELETE FROM audit').run();
        db.prepare('DELETE FROM chat_sessions').run();
        db.prepare('DELETE FROM chat_messages').run();
        db.prepare('DELETE FROM walls').run();
        db.prepare('DELETE FROM images').run();
        db.prepare('DELETE FROM meta').run();
        if (project.walls.length) {
          const insertWall = db.prepare('INSERT INTO walls (id, name, updated, version, data) VALUES (?, ?, ?, ?, ?)');
          for (const row of project.walls) insertWall.run(row.id, row.name, row.updated, row.version, JSON.stringify(row.data));
        }
        if (project.images.length) {
          const insertImage = db.prepare('INSERT INTO images (id, record) VALUES (?, ?)');
          for (const record of project.images) insertImage.run(record.id, JSON.stringify(record));
        }
        const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(project.meta)) insertMeta.run(key, JSON.stringify(value));
        if (project.walls.length) {
          const placeholders = project.walls.map(() => '?').join(',');
          db.prepare(`DELETE FROM backups WHERE wall_id NOT IN (${placeholders})`).run(...project.walls.map(row => row.id));
        } else {
          db.prepare('DELETE FROM backups').run();
        }
        return this.getProject();
      });
    },
    getWall(id) {
      return wall(db.prepare('SELECT id, name, updated, version, data FROM walls WHERE id = ?').get(id));
    },
    putWall(id, name, data, baseVersion) {
      const encoded = JSON.stringify(data);
      return transaction(() => {
        const current = db.prepare('SELECT version FROM walls WHERE id = ?').get(id);
        let version;
        if (current) {
          if (baseVersion !== current.version) throw new VersionConflict();
          version = current.version + 1;
          db.prepare('UPDATE walls SET name = ?, updated = ?, version = ?, data = ? WHERE id = ?')
            .run(name, Date.now(), version, encoded, id);
        } else {
          if (baseVersion != null && baseVersion !== 0) throw new VersionConflict();
          version = 1;
          db.prepare('INSERT INTO walls (id, name, updated, version, data) VALUES (?, ?, ?, ?, ?)')
            .run(id, name, Date.now(), version, encoded);
        }
        return {...this.getWall(id), version};
      });
    },
    deleteWall(id) {
      return transaction(() => {
        db.prepare('DELETE FROM proposals WHERE wall_id = ?').run(id);
        db.prepare('DELETE FROM audit WHERE wall_id = ?').run(id);
        db.prepare('DELETE FROM chat_sessions WHERE wall_id = ?').run(id);
        db.prepare('DELETE FROM chat_messages WHERE wall_id = ?').run(id);
        db.prepare('DELETE FROM backups WHERE wall_id = ?').run(id);
        db.prepare('DELETE FROM walls WHERE id = ?').run(id);
      });
    },
    addBackup(wallId, reason, data) {
      return transaction(() => insertBackupRow(db, wallId, reason, data));
    },
    listBackups(wallId) {
      return db.prepare('SELECT id, wall_id AS wallId, at, reason, cards, edges FROM backups WHERE wall_id = ? ORDER BY id DESC')
        .all(wallId);
    },
    getBackup(id) {
      return backup(db.prepare('SELECT id, wall_id AS wallId, at, reason, cards, edges, data FROM backups WHERE id = ?').get(id));
    },
    deleteBackups(wallId) {
      return transaction(() => { db.prepare('DELETE FROM backups WHERE wall_id = ?').run(wallId); });
    },
    putImage(record) {
      const encoded = JSON.stringify(record);
      db.prepare('INSERT INTO images (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record')
        .run(record.id, encoded);
      return record.id;
    },
    getImage(id) {
      return image(db.prepare('SELECT record FROM images WHERE id = ?').get(id));
    },
    getMeta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : undefined;
    },
    getChatHistory(wallId, client) {
      const session = db.prepare('SELECT session_id, updated FROM chat_sessions WHERE wall_id = ? AND client = ?')
        .get(wallId, client);
      const messages = db.prepare('SELECT id, role, text, at, error, status FROM chat_messages WHERE wall_id = ? AND client = ? ORDER BY id')
        .all(wallId, client).map(row => ({id: Number(row.id), role: row.role, text: row.text, at: row.at, error: row.error, ...(row.status ? {status: row.status} : {})}));
      return {wallId, client, sessionId: session?.session_id || null, updated: session?.updated || null, messages};
    },
    setChatSession(wallId, client, sessionId) {
      db.prepare(`INSERT INTO chat_sessions (wall_id, client, session_id, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT(wall_id, client) DO UPDATE SET session_id = excluded.session_id, updated = excluded.updated`)
        .run(wallId, client, sessionId, Date.now());
    },
    addChatMessage(wallId, client, role, text, error = null, status = null) {
      const result = db.prepare('INSERT INTO chat_messages (wall_id, client, role, text, at, error, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(wallId, client, role, text, Date.now(), error, status);
      return Number(result.lastInsertRowid);
    },
    resetChat(wallId, client) {
      return transaction(() => {
        db.prepare('DELETE FROM chat_messages WHERE wall_id = ? AND client = ?').run(wallId, client);
        db.prepare('DELETE FROM chat_sessions WHERE wall_id = ? AND client = ?').run(wallId, client);
      });
    },
    setMeta(key, value) {
      const encoded = JSON.stringify(value);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, encoded);
      return key;
    },
    getProposalByIdempotencyKey(key) {
      return parseProposal(proposalByKey(db, key));
    },
    insertProposal(proposal) {
      return insertProposalRow(db, transaction, proposal);
    },
    listProposals(status = 'pending', wallId = null) {
      const clauses = [], values = [];
      if (status === 'pending') { clauses.push("status = 'pending'"); }
      if (wallId) { clauses.push('wall_id = ?'); values.push(wallId); }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const rows = db.prepare(`SELECT id, wall_id, base_version, status, created, client, idempotency_key, rationale, ops, base_cards, op_status
        FROM proposals${where} ORDER BY created DESC, id DESC`).all(...values);
      const proposals = rows.map(row => {
        const parsed = parseProposal(row);
        const {ops, baseCards, ...summary} = parsed;
        summary.pendingTypes = {};
        ops.forEach((op, index) => { if (parsed.opStatus[index] === 'pending') summary.pendingTypes[op.type] = (summary.pendingTypes[op.type] || 0) + 1; });
        return summary;
      });
      const counts = Object.fromEntries(['pending', 'partial', 'applied', 'rejected'].map(value => [value, 0]));
      for (const proposal of proposals) counts[proposal.status]++;
      return {proposals, counts, pending: counts.pending, total: proposals.length};
    },
    getProposal(id) {
      const row = proposalRow(db, id);
      if (!row) return undefined;
      const auditIds = db.prepare('SELECT id FROM audit WHERE proposal_id = ? ORDER BY id').all(id).map(value => Number(value.id));
      return parseProposal(row, auditIds);
    },
    previewProposal(id, opIndexes) {
      if (!Array.isArray(opIndexes) || opIndexes.some(index => !Number.isSafeInteger(index) || index < 0)) {
        throw new ProposalError(400, 'invalid proposal opIndexes');
      }
      const row = proposalRow(db, id);
      if (!row) throw new ProposalError(404, 'proposal not found');
      const wallRow = db.prepare('SELECT id, version, data FROM walls WHERE id = ?').get(row.wall_id);
      if (!wallRow) throw new ProposalError(404, 'wall not found');
      const simulation = simulateProposal(row, wallRow, opIndexes);
      const beforeIds = new Set(simulation.before.cards.map(card => card.id));
      const positions = simulation.ops.map((op, index) => {
        if (op.type !== 'add_card' || !simulation.results[index].selected || simulation.results[index].status !== 'applied') return null;
        const cardId = deterministicId('c', row.id, op.tempId), card = cardIn(simulation.after, cardId);
        if (!card || beforeIds.has(cardId) || !simulation.results[index].changed) return null;
        return {opIndex: index, tempId: op.tempId, id: cardId, x: card.x, y: card.y, width: cardWidth(card), height: Math.max(CARD_H, wallLayout.estimateHeight(card))};
      }).filter(Boolean);
      const edges = simulation.ops.map((op, index) => {
        if (op.type !== 'add_edge' || !simulation.results[index].selected || simulation.results[index].status !== 'applied'
          || !simulation.results[index].changed) return null;
        return {opIndex: index, id: deterministicId('e', row.id, index), from: simulation.tempIds.get(op.from) || op.from,
          to: simulation.tempIds.get(op.to) || op.to, type: op.edgeType, label: op.label};
      }).filter(Boolean);
      return {
        proposalId: row.id,
        wallId: row.wall_id,
        version: wallRow.version,
        positions,
        edges,
        idMap: Object.fromEntries(simulation.tempIds),
        results: simulation.results,
      };
    },
    applyProposal(id, opIndexes) {
      if (!Array.isArray(opIndexes) || opIndexes.some(index => !Number.isSafeInteger(index) || index < 0)) {
        throw new ProposalError(400, 'invalid proposal opIndexes');
      }
      return transaction(() => {
        const row = proposalRow(db, id);
        if (!row) throw new ProposalError(404, 'proposal not found');
        const wallRow = db.prepare('SELECT id, name, updated, version, data FROM walls WHERE id = ?').get(row.wall_id);
        if (!wallRow) throw new ProposalError(404, 'wall not found');
        const {before, after, opStatus, affected, results, changed} = simulateProposal(row, wallRow, opIndexes);
        let auditId = null, afterVersion = wallRow.version;
        if (changed) {
          insertBackupRow(db, row.wall_id, 'AI 套用前', before);
          afterVersion++;
          db.prepare('UPDATE walls SET updated = ?, version = ?, data = ? WHERE id = ?')
            .run(Date.now(), afterVersion, proposalJson(after), row.wall_id);
          const result = db.prepare(`INSERT INTO audit
            (at, actor, proposal_id, wall_id, before_version, after_version, affected, before, after, reverted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(Date.now(), row.client || 'MCP', row.id, row.wall_id, wallRow.version, afterVersion,
              proposalJson(affected), proposalJson(before), proposalJson(after));
          auditId = Number(result.lastInsertRowid);
        }
        const status = proposalStatus(opStatus);
        db.prepare('UPDATE proposals SET status = ?, op_status = ? WHERE id = ?').run(status, proposalJson(opStatus), row.id);
        const currentWall = db.prepare('SELECT id, name, updated, version, data FROM walls WHERE id = ?').get(row.wall_id);
        const auditIds = db.prepare('SELECT id FROM audit WHERE proposal_id = ? ORDER BY id').all(row.id).map(value => Number(value.id));
        return {
          wall: wall(currentWall),
          results,
          auditId,
          proposal: parseProposal(proposalRow(db, row.id), auditIds),
        };
      });
    },
    rejectProposal(id, opIndexes) {
      if (opIndexes !== undefined && (!Array.isArray(opIndexes) || opIndexes.some(index => !Number.isSafeInteger(index) || index < 0))) {
        throw new ProposalError(400, 'invalid proposal opIndexes');
      }
      return transaction(() => {
        const row = proposalRow(db, id);
        if (!row) throw new ProposalError(404, 'proposal not found');
        const ops = JSON.parse(row.ops), opStatus = JSON.parse(row.op_status);
        const selected = opIndexes === undefined ? new Set(ops.map((_, index) => index)) : new Set(opIndexes);
        if ([...selected].some(index => index >= ops.length)) throw new ProposalError(400, 'invalid proposal opIndexes');
        for (const index of selected) if (opStatus[index] === 'pending') opStatus[index] = 'rejected';
        const status = proposalStatus(opStatus);
        db.prepare('UPDATE proposals SET status = ?, op_status = ? WHERE id = ?').run(status, proposalJson(opStatus), id);
        const auditIds = db.prepare('SELECT id FROM audit WHERE proposal_id = ? ORDER BY id').all(id).map(value => Number(value.id));
        return parseProposal(proposalRow(db, id), auditIds);
      });
    },
    listAudit(wallId = null) {
      const rows = wallId
        ? db.prepare('SELECT id, at, actor, proposal_id, wall_id, before_version, after_version, affected, before, after, reverted_at FROM audit WHERE wall_id = ? ORDER BY id DESC').all(wallId)
        : db.prepare('SELECT id, at, actor, proposal_id, wall_id, before_version, after_version, affected, before, after, reverted_at FROM audit ORDER BY id DESC').all();
      return rows.map(row => ({id: Number(row.id), at: row.at, actor: row.actor, proposalId: row.proposal_id, wallId: row.wall_id,
        beforeVersion: row.before_version, afterVersion: row.after_version, affected: JSON.parse(row.affected),
        before: JSON.parse(row.before), after: JSON.parse(row.after), revertedAt: row.reverted_at}));
    },
    revertAudit(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new ProposalError(400, 'invalid audit id');
      return transaction(() => {
        const audit = db.prepare('SELECT id, at, actor, proposal_id, wall_id, before_version, after_version, affected, before, after, reverted_at FROM audit WHERE id = ?').get(id);
        if (!audit) throw new ProposalError(404, 'audit not found');
        const current = db.prepare('SELECT id, name, updated, version, data FROM walls WHERE id = ?').get(audit.wall_id);
        if (!current) throw new ProposalError(404, 'wall not found');
        // A restored project can reuse the version number, so the content must match too.
        if (current.version !== audit.after_version || current.data !== audit.after) throw new ProposalError(409, 'wall changed since this apply; nothing was reverted');
        const before = JSON.parse(current.data), after = JSON.parse(audit.before);
        insertBackupRow(db, audit.wall_id, 'AI 套用回復前', before);
        const afterVersion = current.version + 1;
        db.prepare('UPDATE walls SET updated = ?, version = ?, data = ? WHERE id = ?')
          .run(Date.now(), afterVersion, proposalJson(after), audit.wall_id);
        const result = db.prepare(`INSERT INTO audit
          (at, actor, proposal_id, wall_id, before_version, after_version, affected, before, after, reverted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
          .run(Date.now(), '使用者回復', audit.proposal_id, audit.wall_id, current.version, afterVersion,
            proposalJson({...JSON.parse(audit.affected), revertOf: Number(id)}), proposalJson(before), proposalJson(after));
        db.prepare('UPDATE audit SET reverted_at = ? WHERE id = ?').run(Date.now(), id);
        return {wall: wall(db.prepare('SELECT id, name, updated, version, data FROM walls WHERE id = ?').get(audit.wall_id)),
          auditId: Number(result.lastInsertRowid), revertedAuditId: Number(id)};
      });
    },
    integrityCheck() {
      return db.prepare('PRAGMA integrity_check').get().integrity_check;
    },
    close() { db.close(); },
  };
}

function createProposalWriter(filename) {
  const location = path.resolve(filename);
  if (!fs.existsSync(location)) throw new Error(`database not found: ${location}`);
  const db = new DatabaseSync(location);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proposals'").get();
  if (!table) {
    db.close();
    throw new Error('proposal schema not found; start the HTTP service first');
  }
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };
  let confinement = 'module';
  if (typeof db.setAuthorizer === 'function' && sqliteConstants
    && typeof sqliteConstants.SQLITE_OK === 'number' && typeof sqliteConstants.SQLITE_DENY === 'number'
    && typeof sqliteConstants.SQLITE_INSERT === 'number' && typeof sqliteConstants.SQLITE_READ === 'number'
    && typeof sqliteConstants.SQLITE_SELECT === 'number' && typeof sqliteConstants.SQLITE_TRANSACTION === 'number') {
    const allow = new Set([sqliteConstants.SQLITE_OK, sqliteConstants.SQLITE_READ, sqliteConstants.SQLITE_SELECT, sqliteConstants.SQLITE_TRANSACTION]);
    db.setAuthorizer((actionCode, arg1) => {
      if (actionCode === sqliteConstants.SQLITE_INSERT) return arg1 === 'proposals' ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
      return allow.has(actionCode) ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
    });
    confinement = 'authorizer';
  }
  return {
    confinement,
    insertProposal(proposal) { return insertProposalRow(db, transaction, proposal); },
    close() { db.close(); },
  };
}

module.exports = { createDatabase, createProposalWriter, ProposalError, VersionConflict, normalizeProposalOps, proposalPayload, validateProposal, safeSourceHref };
