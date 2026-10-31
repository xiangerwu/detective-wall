const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {ready, openSidebar, artifacts} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const db = path.join(process.env.TEMP, 'wall.db');
const out = artifacts('p11');

function request(pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
    const headers = value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)};
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname, method, headers}, res => {
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

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server', 'mcp.js')],
    env: {...process.env, WALL_DB: db, WALL_PORT: new URL(base).port, WALL_MCP_WALLS: 'p11-wall'},
    stderr: 'pipe',
  });
  const client = new Client({name: 'detective-wall-p11-tests', version: '1.0.0'});
  await client.connect(transport);
  return client;
}

function dataOf(result) {
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function overlap(a, b) {
  return a.x < b.x + b.width + 24 && b.x < a.x + a.width + 24
    && a.y < b.y + b.height + 24 && b.y < a.y + a.height + 24;
}

function proposalOps() {
  const ops = [{op: 'add_card', tempId: 'c', kind: 'card', title: '核心問題', note: '', tags: [], links: []}];
  for (let i = 0; i < 6; i++) ops.push({op: 'add_card', tempId: 'b' + i, kind: 'card', title: '主線 ' + i, note: '', tags: [], links: []});
  for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) {
    ops.push({op: 'add_card', tempId: `b${i}k${j}`, kind: j === 0 ? 'note' : 'card', title: `線索 ${i}-${j}`, note: '', tags: [], links: []});
  }
  ops.push({op: 'add_edge', from: 'existing', to: 'c', type: 'builds', label: '核心入口'});
  for (let i = 0; i < 6; i++) {
    ops.push({op: 'add_edge', from: 'c', to: 'b' + i, type: 'builds', label: '主線'});
    for (let j = 0; j < 5; j++) ops.push({op: 'add_edge', from: 'b' + i, to: `b${i}k${j}`, type: 'builds', label: '線索'});
  }
  for (const [from, to] of [['b0k0', 'b2k1'], ['b1k2', 'b3k0'], ['b4k1', 'b0k3'],
    ['b2k3', 'b4k2'], ['b5k0', 'b1k4'], ['b3k4', 'b5k2']]) {
    ops.push({op: 'add_edge', from, to, type: 'question', label: '跨線索'});
  }
  return ops;
}

function messyWall() {
  const cards = Array.from({length: 7}, (_, i) => ({id: 'messy-' + i, kind: i === 6 ? 'note' : 'card',
    x: 40 + (i % 3) * 24, y: 80 + Math.floor(i / 3) * 22, title: '整理卡 ' + i, note: i === 0 ? '固定內容' : '', tags: [], links: []}));
  return {bands: [{id: 'messy-band', title: '既有分層', y: 0}], tags: [], cards, edges: cards.slice(1).map(card => ({id: 'edge-' + card.id, from: 'messy-0', to: card.id, type: 'builds', label: '關係'}))};
}

async function setWallFixture(page, fixture, selected = []) {
  await page.evaluate(async ({fixture, selected}) => {
    data = structuredClone(fixture);
    lastJSON = JSON.stringify(data);
    past.length = future.length = 0;
    picked.clear(); selected.forEach(id => picked.add(id));
    selCard = null;
    render(); fitView(true);
    await store.putWall(currentWall.id, currentWall.name, data);
  }, {fixture, selected});
}

(async () => {
  const initial = {bands: [], tags: [], cards: [
    {id: 'existing', kind: 'card', x: 120, y: 120, title: '既有中心', note: '', tags: [], links: []},
    {id: 'existing-side', kind: 'note', x: 420, y: 120, title: '既有卡', note: '', tags: [], links: []},
  ], edges: []};
  assert.equal((await request('/api/walls/p11-wall', 'PUT', {id: 'p11-wall', name: 'P11 wall', data: initial, version: null})).status, 200);
  assert.equal((await request('/layout.js')).status, 200);
  const client = await connect();
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(`${base}/#wall=p11-wall`); await ready(page); await openSidebar(page);
    await page.evaluate(() => setCardStyle('tech'));
    await page.check('#ai-proposals-toggle');
    await page.waitForFunction(() => document.querySelector('#ai-proposals-toggle').checked);

    const ops = proposalOps();
    const proposal = dataOf(await client.callTool({name: 'propose_changes', arguments: {
      wallId: 'p11-wall', ops, idempotencyKey: 'p11-hub-40', rationale: 'P11 40 張卡驗收',
    }}));
    const indexes = ops.map((_, index) => index);
    const preview = (await request(`/api/proposals/${proposal.proposalId}/preview`, 'POST', {opIndexes: indexes})).body;
    await page.evaluate(async id => openProposalImporter(await store.getProposal(id)), proposal.proposalId);
    await page.waitForSelector('#proposal-review:not([hidden])');
    await page.waitForFunction(() => pending?.preview?.positions?.length === 37);
    assert.deepEqual(await page.evaluate(() => pending.preview.positions.map(({id, x, y}) => ({id, x, y}))),
      preview.positions.map(({id, x, y}) => ({id, x, y})));
    await page.click('#review-all'); await page.click('#review-apply');
    await page.waitForFunction(() => document.querySelector('#proposal-review').hidden && !wallBusy);
    const applied = await page.evaluate(() => Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y}])));
    for (const position of preview.positions) assert.deepEqual(applied[position.id], {x: position.x, y: position.y});
    assert.deepEqual(applied.existing, {x: 120, y: 120});
    const boxes = await page.evaluate(() => data.cards.map(card => {
      const element = wall.querySelector(`.card[data-id="${CSS.escape(card.id)}"]`);
      return {id: card.id, x: card.x, y: card.y, width: element.offsetWidth, height: element.offsetHeight};
    }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlap(boxes[i], boxes[j]), false, `${boxes[i].id}/${boxes[j].id}`);
    await page.evaluate(() => fitView(true));
    await page.screenshot({path: path.join(out, 'proposal-40-applied.png')});
    console.log('PASS 40-card proposal preview matches apply, leaves existing cards fixed, and has no overlaps');

    const fixture = messyWall();
    await setWallFixture(page, fixture);
    await page.screenshot({path: path.join(out, 'layout-messy-before.png')});
    const before = await page.evaluate(() => Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y, title: card.title, note: card.note}])));
    await page.click('#layout-wall');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('已保存'));
    const after = await page.evaluate(() => ({cards: Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y, title: card.title, note: card.note}])), notice: $('#wall-notice').textContent}));
    assert.ok(Object.values(after.cards).some((card, i) => card.x !== Object.values(before)[i].x || card.y !== Object.values(before)[i].y));
    assert.match(after.notice, /分層線/);
    assert.deepEqual(Object.fromEntries(Object.entries(after.cards).map(([id, card]) => [id, {title: card.title, note: card.note}])),
      Object.fromEntries(Object.entries(before).map(([id, card]) => [id, {title: card.title, note: card.note}])));
    await page.evaluate(() => fitView(true));
    await page.screenshot({path: path.join(out, 'layout-messy-after.png')});
    await page.click('#undo'); await page.waitForFunction(expected => JSON.stringify(data.cards.map(card => [card.id, card.x, card.y])) === JSON.stringify(expected),
      Object.entries(before).map(([id, card]) => [id, card.x, card.y]));
    console.log('PASS 整理版面 lays out the whole wall once, preserves contents, warns about bands, and undoes');

    await setWallFixture(page, fixture, ['messy-1', 'messy-2']);
    const selectedBefore = await page.evaluate(() => Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y}])));
    await page.click('#layout-wall');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('已保存'));
    const selectedAfter = await page.evaluate(() => Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y}])));
    for (const id of ['messy-0', 'messy-3', 'messy-4', 'messy-5', 'messy-6']) assert.deepEqual(selectedAfter[id], selectedBefore[id]);
    assert.ok(['messy-1', 'messy-2'].some(id => selectedAfter[id].x !== selectedBefore[id].x || selectedAfter[id].y !== selectedBefore[id].y));
    await page.click('#undo');
    await page.waitForFunction(expected => JSON.stringify(data.cards.map(card => [card.id, card.x, card.y])) === JSON.stringify(expected),
      Object.entries(selectedBefore).map(([id, point]) => [id, point.x, point.y]));
    console.log('PASS selected 整理版面 moves only picked cards and is one undoable change');
  } finally {
    await browser.close();
    await client.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
