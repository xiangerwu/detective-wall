// Run after building casegraph-server and casegraph-mcp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {DatabaseSync} = require('node:sqlite');
const {serverBin, mcpBin: executable} = require('./runtime.cjs');

const root = path.resolve(__dirname, '..');
const output = process.env.WALL_TEST_OUT || path.join(root, 'test-results', 'rust-mcp');
fs.mkdirSync(output, {recursive: true});
const work = fs.mkdtempSync(path.join(output, 'run-'));
const dbPath = path.join(work, 'wall.db');
const source = path.join(work, 'sources');
fs.mkdirSync(source);
const dataOf = result => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent || JSON.parse(result.content[0].text);
};
const errorOf = result => { assert.equal(result.isError, true); return result.content[0].text; };
const call = (client, name, args = {}) => client.callTool({name, arguments: args});

async function connect(scope) {
  const transport = new StdioClientTransport({
    command: executable,
    args: [],
    env: {...process.env, WALL_DB: dbPath, WALL_PORT: '31415', ...(scope === undefined ? {} : {WALL_MCP_WALLS: scope})},
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({name: 'casegraph-rust-compatibility', version: '1.0.0'});
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw new Error(`${error.message}\n${stderr}`); }
  return client;
}

async function startServer() {
  const child = spawn(serverBin, [], {cwd: root, windowsHide: true, env: {...process.env, WALL_DB: dbPath, WALL_PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(new Error(`Rust server not ready: ${output}`)), 30000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', finish);
      child.once('exit', code => finish(new Error(`Rust server exited ${code}: ${output}`)));
      child.stderr.on('data', chunk => { output += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/WALL_READY (\d+)/);
        if (match) finish(null, `http://127.0.0.1:${match[1]}`);
      });
    });
    return {child, url};
  } catch (error) { child.kill(); throw error; }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

(async () => {
  assert.ok(fs.existsSync(executable), `Rust MCP binary missing: ${executable}; build it first`);
  fs.writeFileSync(path.join(source, 'safe.txt'), '線索'.repeat(30000));
  fs.writeFileSync(path.join(source, '.env.local'), 'TOKEN=never-expose');
  fs.writeFileSync(path.join(source, 'hidden.txt'), '-----BEGIN PRIVATE KEY-----');
  fs.writeFileSync(path.join(source, 'binary.txt'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(path.join(work, 'outside.txt'), 'outside');
  const escape = path.join(source, 'escape');
  let linked = false;
  try { fs.symlinkSync(work, escape, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
  catch (error) { console.log(`SKIP junction/symlink check: ${error.code || error.message}`); }
  const server = await startServer();
  const request = async (pathname, method = 'GET', value) => {
    const response = await fetch(server.url + pathname, {method, ...(value === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(value)})});
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  let store, rust;
  try {
    const fixture = {bands: [], tags: [{id: 't1', name: 'Needle tag'}], cards: [
      {id: 'c1', kind: 'card', x: 10, y: 20, title: 'Needle one', note: 'needle ' + 'x'.repeat(2200), tags: ['t1'], links: [{label: 'Paper', href: 'https://example.test/paper', locator: 'p. 2', quote: 'stored quote'}], fold: true, image: 'img1', level: 'source'},
      {id: 'c2', kind: 'note', x: 300, y: 20, title: 'Second needle', note: '', tags: [], links: [], level: 'key'},
      {id: 'c3', kind: 'card', x: 600, y: 20, title: 'Third', note: '', tags: [], links: []},
    ], edges: [{id: 'e1', from: 'c1', to: 'c2', type: 'builds', label: 'needle link'}, {id: 'e2', from: 'c2', to: 'c3', type: 'uses', label: ''}], preservedExtension: {value: 42}};
    await request('/api/walls/wall-a', 'PUT', {name: 'Wall A', data: fixture, version: null});
    await request('/api/walls/wall-b', 'PUT', {name: 'Wall B', data: {...fixture, cards: [], edges: []}, version: null});
    await request('/api/meta/sourceFolders', 'PUT', {value: [source]});
    store = new DatabaseSync(dbPath, {readOnly: true});
    const walls = () => store.prepare('SELECT * FROM walls ORDER BY id').all();
    const before = walls();
    rust = await connect();
    const tools = (await rust.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_board', 'get_cards', 'get_change_status', 'get_relations', 'list_boards', 'list_files', 'propose_changes', 'read_file', 'search_cards']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'propose_changes');
    }
    assert.equal(tools.find(t => t.name === 'propose_changes').annotations.destructiveHint, false);
    console.log('PASS official Node MCP SDK initializes Rust stdio and lists all nine tools with write permissions limited to proposals');

    assert.deepEqual(dataOf(await call(rust, 'list_boards')).boards.map(b => [b.wallId, b.cards, b.edges]), [['wall-a', 3, 2], ['wall-b', 0, 0]]);
    const pages = [];
    let cursor;
    do {
      const page = dataOf(await call(rust, 'get_board', {wallId: 'wall-a', limit: 1, ...(cursor ? {cursor} : {})}));
      assert.equal(page.cards.length, 1);
      pages.push(...page.cards);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pages.map(c => c.id), ['c1', 'c2', 'c3']);
    assert.equal(pages[0].note.length, 2000);
    assert.equal(pages[0].truncated, true);
    assert.equal(pages[0].image, true);
    assert.equal(pages[0].level, 'source');
    assert.equal(pages[0].ref.url, 'http://127.0.0.1:31415/#wall=wall-a&card=c1');
    const cards = dataOf(await call(rust, 'get_cards', {wallId: 'wall-a', cardIds: ['c1', 'c2', 'c1']})).cards;
    assert.deepEqual(cards.map(c => c.id), ['c1', 'c2']);
    assert.equal(cards[0].note, fixture.cards[0].note);
    assert.deepEqual(cards[0].sources, fixture.cards[0].links);
    const results = [];
    do {
      const page = dataOf(await call(rust, 'search_cards', {query: 'needle', limit: 2, ...(cursor ? {cursor} : {})}));
      assert.ok(page.results.length <= 2);
      results.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(results.map(r => [r.cardId, r.field]), [['c1', 'title'], ['c1', 'note'], ['c1', 'tag'], ['c1', 'edge'], ['c2', 'title']]);
    assert.ok(results.every(r => r.wallId === 'wall-a' && r.ref.cardId === r.cardId));
    const relations = dataOf(await call(rust, 'get_relations', {wallId: 'wall-a', cardId: 'c1', depth: 2}));
    assert.deepEqual(relations.edges.map(e => [e.id, e.from.id, e.to.id, e.direction]), [['e1', 'c1', 'c2', 'outgoing'], ['e2', 'c2', 'c3', 'outgoing']]);
    const limited = dataOf(await call(rust, 'get_relations', {wallId: 'wall-a', cardId: 'c2', limit: 1}));
    assert.equal(limited.edges.length, 1); assert.equal(limited.truncated, true);
    assert.equal(dataOf(await call(rust, 'read_file', {path: 'safe.txt', limit: 2})).content, '線索');
    const segment = dataOf(await call(rust, 'read_file', {path: 'safe.txt', offset: 3, limit: 65536}));
    assert.equal(segment.content, ('線索'.repeat(30000)).slice(3, 21848));
    assert.equal(segment.nextOffset, 21848); assert.equal(segment.eof, false);
    const files = dataOf(await call(rust, 'list_files')).files;
    assert.ok(files.some(f => f.path === path.join(source, 'safe.txt') && f.size === 180000));
    assert.ok(!files.some(f => f.path.endsWith('.env.local')));
    assert.deepEqual(walls(), before);
    console.log('PASS Rust MCP reads, search pagination, relations and source ranges preserve SQLite wall records');

    for (const [name, args, error] of [
      ['get_board', {wallId: 'wall-a', cursor: 'not-a-cursor'}, /invalid cursor/],
      ['get_cards', {wallId: 'wall-a', cardIds: ['missing']}, /unknown card/],
      ['list_files', {path: '..'}, /outside authorized/], ['read_file', {path: '../outside.txt'}, /outside authorized/],
      ['read_file', {path: '\\\\server\\share\\outside.txt'}, /network/],
      ['read_file', {path: '.env.local'}, /excluded/], ['read_file', {path: 'hidden.txt'}, /excluded/], ['read_file', {path: 'binary.txt'}, /binary/],
    ]) assert.match(errorOf(await call(rust, name, args)), error, name);
    console.log('PASS Rust rejects invalid cursors, unauthorized paths, excluded secrets and binary files');
    if (linked) {
      assert.match(errorOf(await call(rust, 'read_file', {path: path.join(escape, 'outside.txt')})), /outside authorized/);
      assert.ok(!dataOf(await call(rust, 'list_files')).files.some(file => file.path === path.join(work, 'outside.txt')));
      console.log('PASS Rust rejects junction/symlink escape without exposing outside files');
    }

    const proposal = {wallId: 'wall-a', idempotencyKey: 'rust-proposal', rationale: 'Compatibility check', ops: [{type: 'update_card', cardId: 'c1', title: 'Reviewed title'}]};
    assert.equal(errorOf(await call(rust, 'propose_changes', proposal)), 'AI proposals are disabled');
    await request('/api/meta/aiProposals', 'PUT', {value: true});
    const submitted = dataOf(await call(rust, 'propose_changes', proposal));
    assert.deepEqual(walls(), before, 'proposing must not alter wall data');
    assert.deepEqual(dataOf(await call(rust, 'propose_changes', proposal)), submitted);
    const statusArgs = {proposalId: submitted.proposalId};
    const status = dataOf(await call(rust, 'get_change_status', statusArgs));
    assert.equal(status.status, 'pending'); assert.deepEqual(status.opStatus, ['pending']);
    const stored = store.prepare('SELECT client,status,ops FROM proposals WHERE id=?').get(submitted.proposalId);
    assert.equal(stored.client, 'MCP'); assert.equal(stored.status, 'pending');
    assert.equal(JSON.parse(stored.ops)[0].title, 'Reviewed title');
    assert.match(errorOf(await call(rust, 'propose_changes', {...proposal, rationale: 'different'})), /idempotency/);
    console.log('PASS Rust writes only reviewable SQLite proposals with stable client identity and idempotency');
    const applied = await request(`/api/proposals/${submitted.proposalId}/apply`, 'POST', {opIndexes: [0]});
    assert.equal(applied.wall.data.cards[0].title, 'Reviewed title');
    assert.equal(dataOf(await call(rust, 'get_change_status', statusArgs)).status, 'applied');
    await request(`/api/audit/${applied.auditId}/revert`, 'POST', {});
    assert.deepEqual((await request('/api/walls/wall-a')).data, fixture);
    assert.deepEqual(JSON.parse(store.prepare('SELECT data FROM walls WHERE id=?').get('wall-a').data), fixture);
    assert.equal(dataOf(await call(rust, 'get_cards', {wallId: 'wall-a', cardIds: ['c1']})).cards[0].title, 'Needle one');
    console.log('PASS Rust HTTP applies and reverts MCP proposals without losing extension fields, readable through SQLite');
  } finally {
    await rust?.close(); store?.close(); await stopServer(server.child);
  }

  const scoped = await connect('wall-a');
  try {
    assert.deepEqual(dataOf(await call(scoped, 'list_boards')).boards.map(b => b.wallId), ['wall-a']);
    for (const wallId of ['wall-b', 'missing']) assert.equal(errorOf(await call(scoped, 'get_board', {wallId})), 'wall not in authorized scope');
    assert.equal(errorOf(await call(scoped, 'search_cards', {query: 'needle', wallIds: ['wall-b']})), 'wall not in authorized scope');
  } finally { await scoped.close(); }
  console.log('PASS Rust MCP scopes hide unauthorized and nonexistent walls identically');

  const missing = spawn(executable, [], {windowsHide: true, env: {...process.env, WALL_DB: path.join(work, 'missing.db')}, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; missing.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { missing.once('error', reject); missing.once('exit', resolve); });
  assert.notEqual(code, 0); assert.match(stderr, /MCP database not found/);
  assert.equal(fs.existsSync(path.join(work, 'missing.db')), false);
  console.log('PASS missing database fails without creating a new file');
})().catch(error => { console.error(error); process.exitCode = 1; });
