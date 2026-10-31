const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const playwright = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {openMcpDatabase} = require('../server/mcp.js');

const base = process.env.WALL_TEST_URL;
const db = path.join(process.env.TEMP, 'wall.db');
const request = (pathname, method = 'GET', value) => new Promise((resolve, reject) => {
  const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
  const headers = value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)};
  const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers}, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text;
      try { body = JSON.parse(text); } catch {}
      resolve({status: res.statusCode, body});
    });
  });
  req.on('error', reject);
  req.end(body);
});

async function connect(scope) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server', 'mcp.js')],
    env: {...process.env, WALL_DB: db, WALL_PORT: new URL(base).port, ...(scope ? {WALL_MCP_WALLS: scope} : {})},
    stderr: 'pipe',
  });
  const errors = [];
  transport.stderr?.on('data', chunk => errors.push(chunk.toString()));
  const client = new Client({name: 'detective-wall-tests', version: '1.0.0'});
  await client.connect(transport);
  return {client, transport, errors};
}

function dataOf(result) {
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function errorOf(result) {
  assert.equal(result.isError, true);
  return result.content[0].text;
}

async function call(client, name, args) {
  return client.callTool({name, arguments: args});
}

const wallA = {
  bands: [{id: 'band-a', title: 'Methods', y: 0}],
  tags: [{id: 'tag-a', name: 'Important', color: 'slate'}],
  cards: [
    {id: 'a-one', kind: 'card', x: 10, y: 20, title: 'Needle one', note: 'needle ' + 'x'.repeat(2200), tags: ['tag-a'], links: [{label: 'Paper', href: 'https://example.test/paper', locator: 'p. 2', quote: 'stored quote'}], fold: true, image: 'image-a'},
    {id: 'a-two', kind: 'note', x: 300, y: 20, title: 'Second needle', note: 'another needle', tags: [], links: []},
    {id: 'a-three', kind: 'card', x: 600, y: 20, title: 'Third card', note: '', tags: [], links: []},
  ],
  edges: [{id: 'edge-a1', from: 'a-one', to: 'a-two', type: 'builds', label: 'needle edge'}, {id: 'edge-a2', from: 'a-two', to: 'a-three', type: 'uses', label: 'next edge'}],
};
const wallB = {
  bands: [],
  tags: [],
  cards: [{id: 'b-one', kind: 'card', x: 20, y: 20, title: 'Other wall', note: 'outside scope', tags: [], links: []}],
  edges: [],
};

(async () => {
  let response = await request('/api/walls/wall-a', 'PUT', {id: 'wall-a', name: 'Wall A', data: wallA, version: null});
  assert.equal(response.status, 200);
  let version = response.body.version;
  response = await request('/api/walls/wall-b', 'PUT', {id: 'wall-b', name: 'Wall B', data: wallB, version: null});
  assert.equal(response.status, 200);

  const beforeDb = openMcpDatabase(db);
  const before = beforeDb.listWalls(true);
  beforeDb.close();
  const readOnly = openMcpDatabase(db);
  assert.throws(() => readOnly.putWall('wall-a', 'changed', wallA, version), /readonly|read-only/i);
  readOnly.close();
  const afterReadOnlyDb = openMcpDatabase(db);
  assert.deepEqual(afterReadOnlyDb.listWalls(true), before);
  afterReadOnlyDb.close();

  let connection = await connect();
  try {
    const listed = await connection.client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['get_board', 'get_cards', 'get_change_status', 'get_relations', 'list_boards', 'list_files', 'propose_changes', 'read_file', 'search_cards']);
    assert.ok(listed.tools.filter(tool => tool.name !== 'propose_changes').every(tool => tool.annotations?.readOnlyHint === true));
    assert.equal(listed.tools.find(tool => tool.name === 'propose_changes').annotations?.readOnlyHint, false);
    assert.equal(listed.tools.find(tool => tool.name === 'propose_changes').annotations?.destructiveHint, false);
    assert.equal(listed.tools.find(tool => tool.name === 'list_files').annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find(tool => tool.name === 'read_file').annotations?.readOnlyHint, true);
    console.log('PASS MCP lists nine tools with only propose_changes writable');

    const boards = dataOf(await call(connection.client, 'list_boards'));
    assert.deepEqual(boards.boards.map(board => board.wallId), ['wall-a', 'wall-b']);
    assert.equal(boards.boards.find(board => board.wallId === 'wall-a').cards, 3);
    console.log('PASS list_boards returns scoped board metadata');

    const boardPages = [], seenCards = new Set();
    let cursor;
    do {
      const page = dataOf(await call(connection.client, 'get_board', {wallId: 'wall-a', limit: 1, ...(cursor ? {cursor} : {})}));
      assert.ok(page.cards.length <= 1);
      for (const card of page.cards) { assert.ok(!seenCards.has(card.id)); seenCards.add(card.id); boardPages.push(card); }
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(boardPages.map(card => card.id), wallA.cards.map(card => card.id));
    assert.equal(boardPages[0].note.length, 2000);
    assert.equal(boardPages[0].truncated, true);
    assert.equal(boardPages[0].image, true);
    assert.match(boardPages[0].ref.url, /#wall=wall-a&card=a-one$/);
    const cappedBoard = dataOf(await call(connection.client, 'get_board', {wallId: 'wall-a', limit: 999}));
    assert.ok(cappedBoard.cards.length <= 200);
    console.log('PASS get_board paginates without gaps and caps limits');

    const cards = dataOf(await call(connection.client, 'get_cards', {wallId: 'wall-a', cardIds: ['a-one', 'a-two']}));
    assert.equal(cards.cards[0].note.length, wallA.cards[0].note.length);
    assert.deepEqual(cards.cards[0].sources, wallA.cards[0].links);
    assert.equal(cards.cards[0].ref.cardId, 'a-one');
    assert.deepEqual(dataOf(await call(connection.client, 'get_cards', {wallId: 'wall-a', cardIds: ['a-three']})).cards[0].sources, []);
    console.log('PASS get_cards returns full notes, stored sources and refs');

    const searchPages = [], seenResults = new Set();
    cursor = undefined;
    do {
      const page = dataOf(await call(connection.client, 'search_cards', {query: 'needle', limit: 1, ...(cursor ? {cursor} : {})}));
      assert.ok(page.results.length <= 1);
      for (const result of page.results) { const key = JSON.stringify(result); assert.ok(!seenResults.has(key)); seenResults.add(key); searchPages.push(result); }
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(searchPages.length >= 3);
    assert.ok(searchPages.every(result => result.ref?.wallId === result.wallId));
    assert.ok(dataOf(await call(connection.client, 'search_cards', {query: 'needle', wallIds: ['wall-b']})).results.every(result => result.wallId === 'wall-b'));
    assert.ok(dataOf(await call(connection.client, 'search_cards', {query: 'needle', limit: 999})).results.length <= 100);
    assert.equal(errorOf(await call(connection.client, 'search_cards', {query: 'needle', cursor: 'not-a-cursor'})), 'invalid cursor');
    console.log('PASS search_cards filters, paginates, caps and rejects invalid cursors');

    const relations = dataOf(await call(connection.client, 'get_relations', {wallId: 'wall-a', cardId: 'a-one', depth: 2}));
    assert.equal(relations.edges.length, 2);
    assert.equal(relations.edges[0].from.id, 'a-one');
    assert.equal(relations.edges[0].direction, 'outgoing');
    console.log('PASS get_relations returns titled directed edges');
  } finally {
    await connection.client.close();
  }

  connection = await connect('wall-a');
  try {
    const scoped = dataOf(await call(connection.client, 'list_boards'));
    assert.deepEqual(scoped.boards.map(board => board.wallId), ['wall-a']);
    const outOfScope = errorOf(await call(connection.client, 'get_board', {wallId: 'wall-b'}));
    const missing = errorOf(await call(connection.client, 'get_board', {wallId: 'does-not-exist'}));
    assert.equal(outOfScope, 'wall not in authorized scope');
    assert.equal(missing, outOfScope);
    assert.ok(dataOf(await call(connection.client, 'search_cards', {query: 'outside'})).results.every(result => result.wallId === 'wall-a'));
    assert.equal(errorOf(await call(connection.client, 'get_cards', {wallId: 'wall-a', cardIds: ['b-one']})),
      errorOf(await call(connection.client, 'get_cards', {wallId: 'wall-a', cardIds: ['no-such-card']})));
    console.log('PASS WALL_MCP_WALLS hides out-of-scope and nonexistent walls identically');
  } finally {
    await connection.client.close();
  }

  let current = wallA;
  const readers = Array.from({length: 8}, async () => {
    const live = await connect();
    try {
      for (let i = 0; i < 12; i++) {
        const result = await call(live.client, 'get_board', {wallId: 'wall-a', limit: 2});
        assert.equal(result.isError, undefined);
      }
    } finally { await live.client.close(); }
  });
  const writes = (async () => {
    for (let i = 0; i < 8; i++) {
      current = {...current, cards: current.cards.map((card, index) => index ? card : {...card, note: `write ${i} needle`})};
      response = await request('/api/walls/wall-a', 'PUT', {id: 'wall-a', name: 'Wall A', data: current, version});
      assert.equal(response.status, 200);
      version = response.body.version;
    }
  })();
  await Promise.all([...readers, writes]);
  connection = await connect();
  try {
    assert.equal(dataOf(await call(connection.client, 'get_board', {wallId: 'wall-a'})).version, version);
  } finally { await connection.client.close(); }
  console.log('PASS MCP reads alongside HTTP writes without SQLITE_BUSY and sees the new version');

  const missingPath = path.join(process.env.WALL_TEST_OUT, 'missing-wall.db');
  const missingProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], {
    cwd: path.join(__dirname, '..'), env: {...process.env, WALL_DB: missingPath}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  missingProcess.stderr.on('data', chunk => { stderr += chunk; });
  const missingExit = await new Promise(resolve => missingProcess.once('exit', resolve));
  assert.notEqual(missingExit, 0);
  assert.match(stderr, /MCP database not found/);
  console.log('PASS missing DB exits non-zero with clear stderr');

  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(`${base}/#wall=wall-b&card=b-one`);
    await page.waitForFunction(() => window.wallReady === true);
    await page.waitForFunction(() => currentWall.id === 'wall-b' && selCard === 'b-one' && !byId('b-one').fold);
    assert.equal(await page.locator('.card[data-id="b-one"]').evaluate(el => el.classList.contains('sel')), true);
    await page.goto(`${base}/#wall=wall-a&card=a-one`);
    await page.waitForFunction(() => currentWall.id === 'wall-a' && selCard === 'a-one');
    assert.equal(await page.evaluate(() => activeTags.size), 0);
    console.log('PASS MCP refs deep-link into the HTTP UI and select the card');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
