const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {DatabaseSync} = require('node:sqlite');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {serverBin, mcpBin} = require('./runtime.cjs');

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

async function measure(label, action) {
  const start = performance.now();
  const value = await action();
  const elapsed = performance.now() - start;
  console.log(`PERF Rust HTTP ${label} ${elapsed.toFixed(2)} ms`);
  return {value, elapsed};
}

function explain(db, label, sql, ...params) {
  const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(' | ');
  console.log(`PLAN ${label} ${details}`);
  return details;
}

function start(filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(serverBin, [], {cwd: path.join(__dirname, '..'),
      env: {...process.env, WALL_DB: filename, WALL_PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill(); done(new Error('Rust server timed out: ' + output)); }, 30000);
    function done(error, result) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
    child.stdout.on('data', value => { output += value; const match = output.match(/WALL_READY (\d+)/); if (match) done(null, {child, url: 'http://127.0.0.1:' + match[1]}); });
    child.stderr.on('data', value => { output += value; });
    child.once('error', done); child.once('exit', code => done(new Error(`Rust server exited ${code}: ${output}`)));
  });
}

(async () => {
  const output = process.env.WALL_TEST_OUT || path.join(__dirname, '..', 'test-results', 'db-perf');
  fs.mkdirSync(output, {recursive: true});
  const filename = path.join(fs.mkdtempSync(path.join(output, 'run-')), 'wall.db');
  const server = await start(filename);
  let client;
  const request = async (pathname, method = 'GET', body) => {
    const response = await fetch(server.url + pathname, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  try {
    const data = largeWall();
    await request('/api/images/image-0', 'PUT', {id: 'image-0', record: {id: 'image-0', mime: 'image/png', data: 'x'.repeat(128 * 1024)}});
    const save = await measure('save', () => request('/api/walls/perf-wall', 'PUT', {name: 'Performance wall', data, version: 0}));
    const read = await measure('read-wall', () => request('/api/walls/perf-wall'));
    const list = await measure('list-walls', async () => (await request('/api')).walls);
    const backup = await measure('backup', () => request('/api/walls/perf-wall/backups', 'POST', {reason: 'benchmark', data}));
    await request('/api/meta/aiProposals', 'PUT', {value: true});
    client = new Client({name: 'db-perf', version: '1.0.0'});
    await client.connect(new StdioClientTransport({command: mcpBin, args: [],
      env: {...process.env, WALL_DB: filename, WALL_PORT: new URL(server.url).port}, stderr: 'pipe'}));
    const ops = Array.from({length: 20}, (_, index) => ({op: 'update_card', cardId: `card-${index}`, note: `Updated ${index}`}));
    const result = await client.callTool({name: 'propose_changes', arguments: {wallId: 'perf-wall', idempotencyKey: 'perf-proposal', rationale: 'benchmark', ops}});
    assert.ok(!result.isError, JSON.stringify(result));
    const proposalId = (result.structuredContent || JSON.parse(result.content[0].text)).proposalId;
    const apply = await measure('proposal-apply', () => request(`/api/proposals/${proposalId}/apply`, 'POST', {opIndexes: ops.map((_, index) => index)}));

    ok(save.value.data.cards.length === 500 && save.value.data.edges.length === data.edges.length, 'save keeps the large wall intact');
    ok(read.value.data.cards.length === 500 && read.value.data.edges.length === data.edges.length, 'read returns 500 cards and 1000 edges');
    ok(list.value.length === 1 && list.value[0].data.cards.length === 500, 'bootstrap returns the full wall');
    ok(backup.value.id > 0, 'backup is stored');
    ok(apply.value.wall.data.cards.slice(0, 20).every((card, index) => card.note === `Updated ${index}`), 'proposal applies all 20 edits to the large wall');
    ok(save.elapsed < 10000 && read.elapsed < 5000 && list.elapsed < 5000 && backup.elapsed < 5000 && apply.elapsed < 10000,
      'large-wall HTTP operations stay within broad performance limits');

    const queryDb = new DatabaseSync(filename, {readOnly: true});
    try {
      const plans = [
        explain(queryDb, 'backups-by-wall', 'SELECT id FROM backups WHERE wall_id = ? ORDER BY id DESC', 'perf-wall'),
        explain(queryDb, 'audit-by-proposal', 'SELECT id FROM audit WHERE proposal_id = ? ORDER BY id', proposalId),
        explain(queryDb, 'chat-by-wall-client', 'SELECT id FROM chat_messages WHERE wall_id = ? AND client = ? ORDER BY id', 'perf-wall', 'codex'),
        explain(queryDb, 'proposals-by-status', "SELECT id FROM proposals WHERE status = 'pending' ORDER BY created DESC, id DESC"),
      ];
      ok(!plans.some(plan => /SCAN (backups|audit|chat_messages|proposals)\b/i.test(plan)), 'common indexed queries do not scan their tables');
      ok(queryDb.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'database integrity_check is ok');
    } finally { queryDb.close(); }
  } finally {
    if (client) await client.close();
    if (server.child.exitCode === null) { const closed = new Promise(resolve => server.child.once('exit', resolve)); server.child.kill(); await closed; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
