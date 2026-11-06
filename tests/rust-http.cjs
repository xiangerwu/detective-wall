// Public HTTP contract against the real Rust server and MCP proposal writer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {serverBin: executable, mcpBin} = require('./runtime.cjs');

const root = path.resolve(__dirname, '..');
const output = process.env.WALL_TEST_OUT || path.join(root, 'test-results', 'rust-http');
fs.mkdirSync(output, {recursive: true});
const work = fs.mkdtempSync(path.join(output, 'run-'));
let checks = 0;

function start(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: root, env: {...process.env, WALL_DB: db, WALL_PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '', settled = false;
    const timer = setTimeout(() => { child.kill(); done(new Error(`server start timed out: ${text}`)); }, 30000);
    function done(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    child.stdout.on('data', chunk => { text += chunk; const match = text.match(/WALL_READY (\d+)/); if (match) done(null, {child, db, url: `http://127.0.0.1:${match[1]}`}); });
    child.stderr.on('data', chunk => { text += chunk; });
    child.once('error', done); child.once('exit', code => done(new Error(`server exited ${code}: ${text}`)));
  });
}
async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  const closed = new Promise(resolve => server.child.once('exit', resolve)); server.child.kill(); await closed;
}
function request(server, pathname, method = 'GET', value, headers = {}, raw) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, server.url), data = raw === undefined ? value === undefined ? '' : JSON.stringify(value) : raw;
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {...(data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}), ...headers}}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let body = text; try { body = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, body, headers: res.headers});
      });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error(`request timed out: ${pathname}`))); req.end(data);
  });
}

(async () => {
  assert.ok(fs.existsSync(executable), `Build Rust server first: ${executable}`);
  let rust, client;
  const fixtures = {cards: [{id: 'a', kind: 'card', x: 10, y: 20, title: 'Needle 100%', note: '中文 note', links: [], tags: ['t'], privateExtension: {keep: 42}},
    {id: 'b', kind: 'note', x: 300, y: 20, title: 'Second', note: '', links: []}], edges: [{id: 'e', from: 'a', to: 'b', type: 'uses', label: 'needle relation'}],
    bands: [], tags: [{id: 't', name: 'Needle tag', color: 'slate'}], extra: {nested: ['preserve']}};
  try {
    rust = await start(path.join(work, 'rust.db'));
    async function check(label, pathname, method = 'GET', value, headers, raw, status = 200) {
      const fresh = await request(rust, pathname, method, value, headers, raw);
      assert.equal(fresh.status, status, `${label}: ${JSON.stringify(fresh.body)}`);
      checks++;
      return fresh;
    }
    {
      const server = rust;
      const health = await request(server, '/api/health'); assert.equal(health.status, 200); assert.equal(health.body.app, 'casegraph');
      assert.equal(health.body.db, server.db); assert.equal(health.body.port, Number(new URL(server.url).port));
      const page = await request(server, '/'); assert.equal(page.status, 200); assert.match(page.body, /wall-tabs/);
      assert.equal(page.headers['cache-control'], 'no-cache');
      assert.equal((await request(server, '/', 'GET', undefined, {'if-none-match': page.headers.etag})).status, 304);
      assert.equal((await request(server, '/api', 'GET', undefined, {origin: 'http://evil.example'})).status, 403);
      assert.equal((await request(server, '/api', 'GET', undefined, {host: 'evil.example'})).status, 403);
      const port = new URL(server.url).port;
      assert.equal((await request(server, '/api', 'GET', undefined, {host: `localhost:${port}`, origin: `http://localhost:${port}`})).status, 200);
    }
    console.log('PASS real Rust HTTP health, embedded whiteboard, ETag and Host/Origin boundaries');
    assert.deepEqual((await check('empty bootstrap', '/api')).body.walls, []);
    await check('create wall', '/api/walls/w-main', 'PUT', {id: 'w-main', name: 'Main', data: fixtures, version: null});
    assert.deepEqual((await check('read wall', '/api/walls/w-main')).body.data, fixtures);
    assert.equal((await check('list walls', '/api/walls')).body[0].id, 'w-main');
    await check('set current wall', '/api/meta/currentWall', 'PUT', {value: 'w-main'});
    assert.deepEqual((await check('bootstrap existing wall', '/api')).body.data, fixtures);
    const changed = structuredClone(fixtures); changed.cards[0].title = 'Needle updated';
    assert.equal((await check('save version 2', '/api/walls/w-main', 'PUT', {name: 'Main', data: changed, version: 1})).body.version, 2);
    await check('reject stale version', '/api/walls/w-main', 'PUT', {name: 'Main', data: fixtures, version: 1}, {}, undefined, 409);
    assert.equal((await check('search needle', '/api/search?q=needle')).body.length, 3);
    assert.deepEqual((await check('literal percent', '/api/search?q=%25')).body, []);
    assert.equal((await check('search limit', '/api/search?q=needle&limit=1')).body.length, 1);
    for (const limit of ['0', 'bad']) await check('invalid search limit', '/api/search?limit=' + limit, 'GET', undefined, {}, undefined, 400);
    await check('normalize tabs', '/api/meta/tabs', 'PUT', {value: {order: ['w-main', 'w-main'], colors: {'w-main': '#AABBCC'}}});
    assert.deepEqual((await check('read tabs', '/api/meta/tabs')).body.value, {order: ['w-main'], colors: {'w-main': '#aabbcc'}});
    await check('put null meta', '/api/meta/optional', 'PUT', {value: null});
    assert.deepEqual((await check('read null meta', '/api/meta/optional')).body, {value: null});
    await check('read missing meta', '/api/meta/missing', 'GET', undefined, {}, undefined, 404);
    const image = {id: 'img', blob: {type: 'image/png', base64: 'AA=='}, width: 1, extension: true};
    await check('put image', '/api/images/img', 'PUT', {id: 'img', record: image}); assert.deepEqual((await check('get image', '/api/images/img')).body, image);
    const backup = await check('create backup', '/api/walls/w-main/backups', 'POST', {reason: 'manual', data: fixtures});
    assert.deepEqual((await check('deduplicate backup', '/api/walls/w-main/backups', 'POST', {reason: 'manual', data: fixtures})).body, backup.body);
    await check('list backups', '/api/walls/w-main/backups'); assert.deepEqual((await check('get backup', '/api/backups/' + backup.body.id)).body.data, fixtures);
    fs.writeFileSync(path.join(work, 'source.txt'), 'source');
    const sources = await check('source status', '/api/sources/check', 'POST', {hrefs: ['source.txt', 'missing.txt', 'https://example.test', '\\\\server\\share\\file', 'file://server/share/file']});
    assert.deepEqual(sources.body.results.map(item => item.status), ['ok', 'missing', 'unchecked', 'unchecked', 'unchecked']);
    console.log('PASS CRUD, search, metadata, images, backups and source contracts');

    await check('enable AI proposals', '/api/meta/aiProposals', 'PUT', {value: true});
    client = new Client({name: 'rust-http-contract', version: '1.0.0'});
    await client.connect(new StdioClientTransport({command: mcpBin, args: [],
      env: {...process.env, WALL_DB: rust.db, WALL_PORT: new URL(rust.url).port}, stderr: 'pipe'}));
    const result = await client.callTool({name: 'propose_changes', arguments: {wallId: 'w-main', idempotencyKey: 'http-test',
      ops: [{op: 'update_card', cardId: 'a', title: 'Reviewed'}, {op: 'add_card', tempId: 'new', kind: 'note', title: 'New clue'}]}});
    assert.ok(!result.isError, JSON.stringify(result));
    const proposalId = (result.structuredContent || JSON.parse(result.content[0].text)).proposalId;
    await check('list proposals', '/api/proposals'); await check('read proposal', `/api/proposals/${proposalId}`);
    const preview = await check('preview proposal', `/api/proposals/${proposalId}/preview`, 'POST', {opIndexes: [0, 1]});
    const applied = await check('apply proposal', `/api/proposals/${proposalId}/apply`, 'POST', {opIndexes: [0, 1]});
    assert.equal(applied.body.wall.data.cards[0].title, 'Reviewed');
    assert.equal(applied.body.wall.data.cards[2].id, preview.body.positions[0].id);
    assert.equal((await check('list audit', '/api/audit')).body.length, 1);
    assert.equal((await check('repeat apply', `/api/proposals/${proposalId}/apply`, 'POST', {opIndexes: [0, 1]})).body.auditId, null);
    assert.deepEqual((await check('revert applied proposal', `/api/audit/${applied.body.auditId}/revert`, 'POST')).body.wall.data, changed);
    await check('reject applied proposal', `/api/proposals/${proposalId}/reject`, 'POST');
    await check('project export', '/api/project');
    const exported = (await request(rust, '/api/project')).body;
    exported.walls[0].data.cards[0].links = [{href: 'javascript:alert(1)'}, {href: 'https://example.test', quote: 'keep'}];
    delete exported.walls[0].data.cards[1].links;
    await check('project import sanitizes links', '/api/project', 'PUT', exported);
    const imported = (await check('project import state', '/api/project')).body;
    assert.deepEqual(imported.walls[0].data.cards[0].links, [{href: 'https://example.test', quote: 'keep'}]);
    assert.deepEqual(imported.walls[0].data.cards[0].privateExtension, {keep: 42});
    const duplicate = structuredClone(exported); duplicate.walls.push(duplicate.walls[0]);
    await check('reject duplicate project walls', '/api/project', 'PUT', duplicate, {}, undefined, 400);
    assert.deepEqual((await request(rust, '/api/walls/w-main')).body.data, imported.walls[0].data);
    assert.equal((await request(rust, '/api/walls/w-main')).body.data.extra.nested[0], 'preserve');
    console.log('PASS completed proposal preview/apply/revert and project compatibility checks');

    for (const [label, pathname, method, value, raw, status = 400] of [
      ['missing JSON body', '/api/walls/w-main', 'PUT', undefined, ''],
      ['invalid JSON', '/api/walls/w-main', 'PUT', undefined, '{'],
      ['JSON null body', '/api/walls/w-main', 'PUT', null],
      ['wall id mismatch', '/api/walls/w-main', 'PUT', {id: 'other', name: 'Main', data: fixtures}],
      ['negative version', '/api/walls/w-main', 'PUT', {name: 'Main', data: fixtures, version: -1}],
      ['invalid image', '/api/images/img', 'PUT', {id: 'img', record: {id: 'other'}}],
      ['invalid backup', '/api/walls/w-main/backups', 'POST', {reason: '', data: fixtures}],
      ['invalid tabs', '/api/meta/tabs', 'PUT', {value: {order: [1], colors: {}}}],
      ['invalid percent escape', '/api/walls/%zz', 'GET'],
      ['invalid UTF8 escape', '/api/walls/%E0', 'GET'],
      ['missing wall', '/api/walls/missing', 'GET', undefined, undefined, 404],
      ['unknown route', '/api/no-such-route', 'POST', undefined, undefined, 404],
      ['invalid proposal status', '/api/proposals?status=bad', 'GET'],
      ['null rejection body', `/api/proposals/${proposalId}/reject`, 'POST', null],
      ['GET ignores body', '/api/walls', 'GET', undefined, '{', 200],
    ]) await check(label, pathname, method, value, {}, raw, status);
    await check('delete backups', '/api/walls/w-main/backups', 'DELETE', undefined, {}, undefined, 204);
    await check('delete wall', '/api/walls/w-main', 'DELETE', undefined, {}, undefined, 204); await check('deleted wall is gone', '/api/walls/w-main', 'GET', undefined, {}, undefined, 404);
    console.log('PASS completed invalid input and deletion compatibility checks');
    console.log(`PASS all ${checks} Rust HTTP contract requests`);
  } finally { if (client) await client.close(); await stop(rust); }
})().catch(error => { console.error(error); process.exitCode = 1; });
