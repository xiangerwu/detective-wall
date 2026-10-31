const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const playwright = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {createDatabase, safeSourceHref} = require('../server/db.js');
const {openActivity, ready} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const db = path.join(process.env.TEMP, 'wall.db');
const out = process.env.WALL_TEST_OUT;
const root = path.join(out, 'p12-sources');

function request(pathname, method = 'GET', value, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {...(value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}), ...headers}}, res => {
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
}

function dataOf(result) {
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function errorOf(result) {
  assert.equal(result.isError, true);
  return result.content[0].text;
}

function call(client, name, arguments_) {
  return client.callTool({name, arguments: arguments_});
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child did not exit')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({code, signal, stdout, stderr}); });
  });
}

function startMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server', 'mcp.js')],
    env: {...process.env, WALL_DB: db, WALL_PORT: new URL(base).port},
    stderr: 'pipe',
  });
  const client = new Client({name: 'detective-wall-p12-tests', version: '1.0.0'});
  return client.connect(transport).then(() => client);
}

function seedWall(id, title = id) {
  return {id, name: title, updated: Date.now(), version: 1,
    data: {bands: [], tags: [], cards: [{id: id + '-card', kind: 'card', x: 20, y: 20, title, note: '', tags: [], links: []}], edges: []}};
}

function insertProposal(store, id, wallId) {
  return store.insertProposal({id, wallId, baseVersion: 1, created: Date.now(), client: 'P12',
    idempotencyKey: id + '-key', rationale: 'P12 cleanup',
    ops: [{type: 'add_card', tempId: id + '-card', kind: 'card', title: id, note: '', tags: [], links: []}],
    baseCards: {cards: [], edges: []}});
}

async function sourceExclusionTest(client) {
  fs.mkdirSync(root, {recursive: true});
  const excludedDirs = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'gcloud', '.terraform.d', '.git', 'node_modules'];
  for (const directory of excludedDirs) {
    const target = path.join(root, directory, 'hidden.txt');
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, 'hidden');
  }
  const ghFile = path.join(root, '.config', 'gh', 'hosts.yml');
  fs.mkdirSync(path.dirname(ghFile), {recursive: true}); fs.writeFileSync(ghFile, 'oauth_token: hidden');
  const excludedFiles = [
    '.env.local', '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json',
    'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_dsa.pub', 'id_ecdsa', 'id_ecdsa.pub', 'id_ed25519', 'id_ed25519.pub',
    'id_ecdsa_sk', 'id_ecdsa_sk.pub', 'id_ed25519_sk', 'id_ed25519_sk.pub', 'certificate.pem', 'private.key', 'bundle.p12',
    'bundle.pfx', 'store.jks', 'store.keystore', 'private.ppk', 'vault.kdbx', 'secret.gpg', 'public.pgp', 'signed.asc',
    'certificate.crt', 'certificate.cer', 'certificate.der', 'secret.json', 'token.yaml', 'secret.toml', 'terraform.tfstate.backup',
    'wall.db', 'wall.sqlite3', 'wall.db-wal', 'wall.db-shm',
  ];
  for (const file of excludedFiles) fs.writeFileSync(path.join(root, file), 'hidden');
  fs.writeFileSync(path.join(root, 'private-looking.txt'), '-----BEGIN CERTIFICATE-----\nPRIVATE KEY\n-----END CERTIFICATE-----');
  fs.writeFileSync(path.join(root, 'id_mapping.txt'), 'visible id mapping');
  for (const file of ['safe.md', 'safe.txt', 'safe.js']) fs.writeFileSync(path.join(root, file), 'safe content');
  assert.equal((await request('/api/meta/sourceFolders', 'PUT', {value: [root]})).status, 200);
  const listed = dataOf(await call(client, 'list_files', {})).files.map(file => file.path);
  assert.ok(listed.includes(path.join(root, 'safe.md')));
  assert.ok(listed.includes(path.join(root, 'safe.txt')));
  assert.ok(listed.includes(path.join(root, 'safe.js')));
  assert.ok(listed.includes(path.join(root, 'id_mapping.txt')));
  for (const file of excludedFiles) assert.equal(listed.includes(path.join(root, file)), false, file);
  for (const directory of [...excludedDirs, path.join('.config', 'gh')]) {
    assert.equal(listed.some(file => file.includes(path.sep + directory + path.sep)), false, directory);
  }
  for (const file of excludedFiles) assert.match(errorOf(await call(client, 'read_file', {path: path.join(root, file)})), /excluded/i, file);
  assert.match(errorOf(await call(client, 'read_file', {path: path.join(root, 'private-looking.txt')})), /excluded/i);
  for (const file of ['safe.md', 'safe.txt', 'safe.js', 'id_mapping.txt']) {
    assert.equal(dataOf(await call(client, 'read_file', {path: path.join(root, file)})).content.includes('safe') || file === 'id_mapping.txt', true);
  }
  console.log('PASS P12 MCP exclusion list covers credential directories, key/certificate names, secret formats, databases, private-key headers, and safe files');
}

async function cleanupTest() {
  const store = createDatabase(db);
  const wallA = seedWall('cleanup-a'), wallB = seedWall('cleanup-b');
  try {
    store.putWall(wallA.id, wallA.name, wallA.data, null);
    store.putWall(wallB.id, wallB.name, wallB.data, null);
    const proposal = insertProposal(store, 'cleanup-proposal', wallA.id);
    store.applyProposal(proposal.proposalId, [0]);
    store.setChatSession(wallA.id, 'claude', 'cleanup-session-a');
    store.addChatMessage(wallA.id, 'claude', 'user', 'old chat');
    store.setChatSession(wallB.id, 'claude', 'cleanup-session-b');
    store.addChatMessage(wallB.id, 'claude', 'user', 'other wall chat');
    store.replaceProject({format: 'detective-wall-project', formatVersion: 1, exportedAt: new Date().toISOString(),
      walls: [wallB], images: [], meta: {}});
    assert.equal(store.listProposals('all').total, 0);
    assert.deepEqual(store.listAudit(), []);
    assert.deepEqual(store.getChatHistory(wallA.id, 'claude').messages, []);
    assert.equal(store.getChatHistory(wallA.id, 'claude').sessionId, null);
    assert.equal(store.getWall(wallA.id), undefined);
    store.putWall(wallA.id, wallA.name, wallA.data, null);
    insertProposal(store, 'delete-proposal-a', wallA.id);
    insertProposal(store, 'delete-proposal-b', wallB.id);
    store.setChatSession(wallA.id, 'codex', 'delete-session-a');
    store.addChatMessage(wallA.id, 'codex', 'user', 'delete me');
    store.setChatSession(wallB.id, 'codex', 'keep-session-b');
    store.addChatMessage(wallB.id, 'codex', 'user', 'keep me');
    store.deleteWall(wallA.id);
    assert.equal(store.listProposals('all', wallA.id).total, 0);
    assert.deepEqual(store.listAudit(wallA.id), []);
    assert.deepEqual(store.getChatHistory(wallA.id, 'codex').messages, []);
    assert.equal(store.listProposals('all', wallB.id).total, 1);
    assert.equal(store.getChatHistory(wallB.id, 'codex').sessionId, 'keep-session-b');
    console.log('PASS P12 project restore clears proposals, audit, sessions, and messages; deleting one wall leaves another wall intact');
  } finally { store.close(); }
}

async function startupFailureTests() {
  const serverScript = path.join(__dirname, '..', 'server', 'server.js');
  const badRoot = path.join(out, 'chat-workdir-file');
  fs.mkdirSync(badRoot, {recursive: true});
  const badDb = path.join(badRoot, 'wall.db');
  fs.writeFileSync(path.join(badRoot, 'chat-workdir'), 'not a directory');
  const bad = await waitForExit(spawn(process.execPath, [serverScript], {
    cwd: path.join(__dirname, '..'), env: {...process.env, WALL_DB: badDb, WALL_PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /chat workdir is not a directory/);
  console.log('PASS P12 chat workdir refuses an existing non-directory with a clear startup error');

  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const port = blocker.address().port;
  const conflict = await waitForExit(spawn(process.execPath, [serverScript], {
    cwd: path.join(__dirname, '..'), env: {...process.env, WALL_DB: path.join(out, 'port-conflict.db'), WALL_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  await new Promise(resolve => blocker.close(resolve));
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /WALL_PORT.*占用/);
  assert.doesNotMatch(conflict.stderr, /\n\s+at /);
  console.log('PASS P12 occupied port exits non-zero with a readable WALL_PORT message and no stack trace');
}

(async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json')));
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.engines.node, '>=24');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8').includes('Copyright (c) 2026 xiangerwu'), true);
  assert.equal(safeSourceHref('https://example.test/source'), true);
  assert.equal(safeSourceHref('file:///tmp/source.txt'), true);
  assert.equal(safeSourceHref('mailto:research@example.test'), true);
  assert.equal(safeSourceHref('C:\\Users\\me\\source.txt'), true);
  assert.equal(safeSourceHref('relative/source.txt'), true);
  for (const href of ['javascript:alert(1)', ' JaVaScRiPt:', 'java\tscript:', 'data:text/html,<b>x</b>', 'blob:https://example.test/id', 'java%73cript:alert(1)']) {
    assert.equal(safeSourceHref(href), false, href);
  }
  console.log('PASS P12 MIT metadata, Node engine, license file, and source href allowlist are present');

  let response = await request('/api/walls/p12-main', 'PUT', {id: 'p12-main', name: 'P12', data: {
    bands: [], tags: [], cards: [{id: 'danger', kind: 'card', x: 20, y: 20, title: 'Danger', note: '', tags: [], links: []}], edges: [],
  }, version: null});
  assert.equal(response.status, 200);
  assert.equal((await request('/api/meta/aiProposals', 'PUT', {value: true})).status, 200);
  const client = await startMcp();
  try {
    for (const [index, href] of ['javascript:alert(1)', ' JaVaScRiPt:', 'java\tscript:', 'data:text/html,<b>x</b>'].entries()) {
      assert.match(errorOf(await call(client, 'propose_changes', {wallId: 'p12-main', idempotencyKey: 'p12-danger-' + index,
        ops: [{op: 'add_card', tempId: 'danger-' + index, kind: 'card', title: 'Danger', note: '', tags: [], links: [{label: 'bad', href}]}]})), /invalid proposal link href/);
    }
    const safe = dataOf(await call(client, 'propose_changes', {wallId: 'p12-main', idempotencyKey: 'p12-safe',
      ops: [{op: 'add_card', tempId: 'safe', kind: 'card', title: 'Safe', note: '', tags: [], links: [
        {label: 'web', href: 'https://example.test'}, {label: 'file', href: 'file:///tmp/a'},
        {label: 'mail', href: 'mailto:research@example.test'},
        {label: 'drive', href: 'C:\\Users\\me\\a.txt'}, {label: 'relative', href: 'notes/a.md'},
      ]}]}));
    assert.equal(safe.status, 'pending');
    console.log('PASS P12 AI proposal rejects javascript, case/space/tab variants, data, and encoded schemes while retaining legal sources');
    await sourceExclusionTest(client);

    const direct = new DatabaseSync(db);
    const row = direct.prepare('SELECT data FROM walls WHERE id = ?').get('p12-main');
    const corrupted = JSON.parse(row.data);
    corrupted.cards[0].links = [
      {label: 'bad', href: 'javascript:alert(1)'}, {label: 'bad2', href: 'data:text/html,x'},
      {label: 'web', href: 'https://example.test'},
    ];
    direct.prepare('UPDATE walls SET data = ? WHERE id = ?').run(JSON.stringify(corrupted), 'p12-main');
    direct.close();

    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
    try {
      const page = await browser.newPage({viewport: {width: 1400, height: 900}});
      await page.goto(base + '/#wall=p12-main'); await ready(page);
      assert.equal(await page.locator('.card[data-id="danger"] a[href]').count(), 1);
      await page.evaluate(() => openPanel('danger'));
      assert.doesNotMatch(await page.inputValue('#f-links'), /javascript:|data:/i);
      await page.fill('#f-links', [
        'Web | https://example.test/source', 'File | file:///tmp/source.txt',
        'Drive | C:\\Users\\me\\source.txt', 'Relative | notes/source.md',
        'Bad | javascript:alert(1)', 'Bad case |  JaVaScRiPt:', 'Bad tab | java\tscript:', 'Bad data | data:text/html,x',
      ].join('\n'));
      const editedLinks = await page.evaluate(() => structuredClone(byId('danger').links));
      assert.deepEqual(editedLinks.map(link => link.href), ['https://example.test/source', 'file:///tmp/source.txt', 'C:\\Users\\me\\source.txt', 'notes/source.md']);
      await page.click('#f-close');
      console.log('PASS P12 old dangerous DB links and card-editor input render or persist no unsafe href');

      const importData = {cards: [{id: 'import-danger', kind: 'card', x: 100, y: 100, title: 'Import', note: '', tags: [], links: [
        {label: 'safe', href: 'https://example.test/import'}, {label: 'bad', href: 'javascript:alert(1)'}, {label: 'bad2', href: ' JaVaScRiPt:'},
        {label: 'bad3', href: 'java\tscript:'}, {label: 'bad4', href: 'data:text/html,x'},
      ]}], edges: [], bands: [], tags: []};
      await openActivity(page, 'files');
      await page.setInputFiles('#import-file', {name: 'p12-danger.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importData))});
      await page.waitForSelector('#importer[open]');
      assert.equal(await page.evaluate(() => pending.skippedLinks.length), 4);
      assert.match(await page.textContent('#im-summary'), /略過不安全來源 4/);
      assert.deepEqual(await page.evaluate(() => pending.cards[0].links.map(link => link.href)), ['https://example.test/import']);
      await page.click('#im-cancel');

      const canvas = {nodes: [
        {id: 'canvas-text', type: 'text', x: 0, y: 0, text: '# Canvas\ntext', detective: {kind: 'card', title: 'Canvas', note: 'text', links: [
          {label: 'safe', href: 'https://example.test/canvas'}, {label: 'bad', href: 'data:text/html,x'},
        ]}},
        {id: 'canvas-link', type: 'link', x: 300, y: 0, url: 'javascript:alert(1)'},
      ], edges: []};
      await page.setInputFiles('#import-file', {name: 'p12-danger.canvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(canvas))});
      await page.waitForSelector('#importer[open]');
      assert.equal(await page.evaluate(() => pending.skippedLinks.length), 2);
      assert.match(await page.textContent('#im-summary'), /略過不安全來源 2/);
      assert.deepEqual(await page.evaluate(() => pending.cards.find(card => card.id === 'canvas-text').links.map(link => link.href)), ['https://example.test/canvas']);
      await page.click('#im-cancel');

      const reviewDb = new DatabaseSync(db);
      reviewDb.prepare(`INSERT INTO proposals
        (id, wall_id, base_version, status, created, client, idempotency_key, rationale, ops, base_cards, op_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('p12-review-danger', 'p12-main', 1, 'pending', Date.now(), 'P12', 'p12-review-danger-key', 'review',
          JSON.stringify([{type: 'add_card', tempId: 'review-danger', kind: 'card', title: 'Review', note: '', tags: [], links: [{label: 'bad', href: 'javascript:alert(1)'}]}]),
          JSON.stringify({cards: [], edges: []}), JSON.stringify(['pending']));
      reviewDb.close();
      await page.evaluate(async () => openProposalImporter(await store.getProposal('p12-review-danger')));
      await page.waitForSelector('#proposal-review:not([hidden])');
      await page.locator('#review-list .review-item-toggle').click();
      assert.equal(await page.locator('#review-list a[href]').count(), 0);
      await page.click('#review-close');
      console.log('PASS P12 JSON and Canvas imports skip unsafe sources with preview warnings, and review rendering creates no unsafe anchor');

      const project = {format: 'detective-wall-project', formatVersion: 1, exportedAt: new Date().toISOString(),
        walls: [{id: 'p12-project', name: 'Project', updated: Date.now(), version: 1, data: {
          bands: [], tags: [], cards: [{id: 'project-card', kind: 'card', x: 20, y: 20, title: 'Project', note: '', tags: [], links: [
            {label: 'safe', href: 'https://example.test/project'}, {label: 'bad1', href: 'javascript:alert(1)'},
            {label: 'bad2', href: ' JaVaScRiPt:'}, {label: 'bad3', href: 'java\tscript:'}, {label: 'bad4', href: 'data:text/html,x'},
          ]}], edges: [], bands: [], tags: [],
        }}], images: [], meta: {currentWall: 'p12-project'}};
      await page.click('#import-project');
      await page.setInputFiles('#project-file', {name: 'p12-project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project))});
      await page.waitForFunction(() => projectDraft && projectWarnings.length === 4);
      assert.match(await page.textContent('#import-project'), /略過 4 個不安全來源/);
      await page.click('#import-project');
      await page.waitForFunction(() => !wallBusy && currentWall.id === 'p12-project');
      assert.deepEqual(await page.evaluate(() => byId('project-card').links.map(link => link.href)), ['https://example.test/project']);
      assert.equal(await page.locator('.card[data-id="project-card"] a[href]').count(), 1);
      console.log('PASS P12 whole-project restore previews and removes unsafe source links without failing the project');
    } finally { await browser.close(); }
  } finally { await client.close(); }

  await cleanupTest();
  await startupFailureTests();
})().catch(error => { console.error(error); process.exitCode = 1; });
