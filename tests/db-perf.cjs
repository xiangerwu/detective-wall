const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {DatabaseSync} = require('node:sqlite');
const {createDatabase, normalizeProposalOps, validateProposal} = require('../server/db.js');

const ok = (condition, message) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + message);
  if (!condition) process.exitCode = 1;
};

function largeWall() {
  const cards = Array.from({length: 500}, (_, index) => ({
    id: `card-${index}`,
    kind: index % 5 === 0 ? 'note' : 'card',
    x: (index % 25) * 240,
    y: Math.floor(index / 25) * 180,
    title: `Card ${index}`,
    note: `Performance fixture note ${index}`,
    tags: [`tag-${index % 20}`],
    links: index === 0 ? [{label: 'image', href: 'file:///fixture.png'}] : [],
  }));
  const edges = Array.from({length: 1000}, (_, index) => ({
    id: `edge-${index}`,
    from: cards[index % cards.length].id,
    to: cards[(index * 7 + 3) % cards.length].id,
    type: ['builds', 'uses', 'question'][index % 3],
    label: `relation ${index}`,
  })).filter(edge => edge.from !== edge.to);
  return {
    tags: Array.from({length: 20}, (_, index) => ({id: `tag-${index}`, name: `Tag ${index}`, color: 'slate'})),
    bands: Array.from({length: 10}, (_, index) => ({id: `band-${index}`, title: `Band ${index}`, y: index * 240})),
    cards,
    edges,
  };
}

function measure(label, action) {
  const start = performance.now();
  const value = action();
  const elapsed = performance.now() - start;
  console.log(`PERF ${label} ${elapsed.toFixed(2)} ms`);
  return {value, elapsed};
}

function explain(db, label, sql, ...params) {
  const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(' | ');
  console.log(`PLAN ${label} ${details}`);
  return details;
}

const temp = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'detective-wall-db-perf-'));
const filename = path.join(temp, 'wall.db');
const store = createDatabase(filename);
const data = largeWall();
store.putImage({id: 'image-0', mime: 'image/png', data: 'x'.repeat(128 * 1024)});

const save = measure('save', () => store.putWall('perf-wall', 'Performance wall', data, 0));
const read = measure('read-wall', () => store.getWall('perf-wall'));
const list = measure('list-walls', () => store.listWalls(true));
const backup = measure('backup', () => store.addBackup('perf-wall', 'benchmark', data));

const wall = store.getWall('perf-wall');
const ops = normalizeProposalOps(Array.from({length: 20}, (_, index) => ({
  op: 'update_card',
  cardId: `card-${index}`,
  note: `Updated ${index}`,
})));
const prepared = validateProposal(wall, ops);
const proposalId = 'perf-proposal';
store.insertProposal({
  id: proposalId,
  wallId: 'perf-wall',
  baseVersion: wall.version,
  created: Date.now(),
  client: 'db-perf',
  idempotencyKey: proposalId,
  rationale: 'benchmark',
  ops: prepared.ops,
  baseCards: prepared.baseCards,
});
const apply = measure('proposal-apply', () => store.applyProposal(proposalId, ops.map((_, index) => index)));

ok(save.value.data.cards.length === 500 && save.value.data.edges.length === data.edges.length, 'save keeps the large wall intact');
ok(read.value.data.cards.length === 500 && read.value.data.edges.length === data.edges.length, 'read returns 500 cards and 1000 edges');
ok(list.value.length === 1 && list.value[0].data.cards.length === 500, 'list returns the full wall');
ok(backup.value > 0, 'backup is stored');
ok(apply.value.wall.data.cards[0].note === 'Updated 0', 'proposal applies to the large wall');
ok(save.elapsed < 10000 && read.elapsed < 5000 && list.elapsed < 5000 && backup.elapsed < 5000 && apply.elapsed < 10000,
  'large-wall operations stay within broad performance limits');

const queryDb = new DatabaseSync(filename, {readOnly: true});
const plans = [
  explain(queryDb, 'backups-by-wall', 'SELECT id FROM backups WHERE wall_id = ? ORDER BY id DESC', 'perf-wall'),
  explain(queryDb, 'audit-by-proposal', 'SELECT id FROM audit WHERE proposal_id = ? ORDER BY id', proposalId),
  explain(queryDb, 'chat-by-wall-client', 'SELECT id FROM chat_messages WHERE wall_id = ? AND client = ? ORDER BY id', 'perf-wall', 'codex'),
  explain(queryDb, 'proposals-by-status', "SELECT id FROM proposals WHERE status = 'pending' ORDER BY created DESC, id DESC"),
];
ok(!plans.some(plan => /SCAN (backups|audit|chat_messages|proposals)\b/i.test(plan)), 'common indexed queries do not scan their tables');
ok(queryDb.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'database integrity_check is ok');
queryDb.close();
store.close();
