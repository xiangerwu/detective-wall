const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { ready, reload, settled, openActivity, artifacts, renameWall } = require('./wall-ready.cjs');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('round-09');
const errors = [], dialogs = [];
const pass = message => console.log('PASS ' + message);
const upload = (page, value, name = 'fixture.canvas') => page.setInputFiles('#import-file', {
  name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});
const open = async (page, value, name) => {
  await openActivity(page, 'files');
  await upload(page, value, name);
  await page.waitForSelector('#importer[open]');
};
const apply = async (page, replace = false) => {
  await page.click(replace ? '#im-replace' : '#im-apply');
  if (replace) {
    assert.ok(await page.isVisible('#importer'), 'first replace click only arms the button');
    await page.click('#im-replace');
  }
  await settled(page);
};
const download = async (page, format, filename) => {
  await openActivity(page, 'files');
  const waiting = page.waitForEvent('download');
  await page.click(format === 'canvas' ? '#export-canvas' : '#export');
  const result = await waiting;
  const target = path.join(OUT, filename);
  await result.saveAs(target);
  return {name: result.suggestedFilename(), value: JSON.parse(fs.readFileSync(target, 'utf8'))};
};
const rendered = page => page.waitForFunction(() => {
  const img = document.querySelector('.card img');
  return img?.complete && img.naturalWidth > 0;
});
const edgeValues = edges => edges.map(({from, to, type, label}) => ({from, to, type, label}));
const node = (id, type, extra = {}) => ({id, type, x: 10, y: 20, width: 200, height: 120, ...extra});

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const newPage = async () => {
      const context = await browser.newContext({viewport: {width: 1400, height: 900}});
      // Optional offline copies must match the page's SRI, so these are the real libraries, not stubs.
      if (process.env.WALL_TEST_ASSETS) for (const [, url, integrity] of fs.readFileSync(PAGE, 'utf8').matchAll(/<script src="([^"]+)" integrity="([^"]+)"/g)) {
        const body = fs.readFileSync(path.join(process.env.WALL_TEST_ASSETS, path.basename(new URL(url).pathname)));
        assert.equal('sha384-' + require('crypto').createHash('sha384').update(body).digest('base64'), integrity);
        await context.route(url, route => route.fulfill({body, contentType: 'application/javascript', headers: {'access-control-allow-origin': '*'}}));
      }
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
      await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
      return page;
    };
    const page = await newPage();
    assert.match(await page.getAttribute('#import-file', 'accept'), /\.json.*\.canvas/);
    assert.match(await page.textContent('.hint'), /\.canvas.*Obsidian/);
    const colors = ['red', 'amber', 'cream', 'green', 'slate', 'purple'];
    const fixture = {
      cards: colors.map((color, i) => ({id: color, kind: i % 2 ? 'note' : 'card', title: '線索 ' + color,
        note: '**筆記**\n\n- evidence ' + i, links: [{label: '來源', href: 'https://example.com/' + color}],
        x: -100.4 + i * 220.3, y: 60.2 + i * 100.4, color, tags: ['tag'], custom: {keep: i}})),
      bands: [{id: 'red', title: '第一層', y: -20}, {id: 'lower', title: '第二層', y: 350}],
      tags: [{id: 'tag', name: '重要線索', color: 'purple'}],
      edges: ['builds', 'uses', 'question'].map((type, i) => ({id: 'edge' + i, from: colors[i], to: colors[i + 1], type, label: '關係 ' + type})),
    };
    await open(page, fixture, 'source.json'); await apply(page, true);
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(40, 20);
      canvas.getContext('2d').fillRect(0, 0, 40, 20);
      const blob = await canvas.convertToBlob({type: 'image/png'});
      for (const id of ['image', 'unused']) await store.putImage({id, blob, type: blob.type, width: 40, height: 20});
      data.cards[0].image = data.cards[1].image = 'image';
      data.edges[0].id = 'red'; // Deliberately collide with a card and a band.
      render(); await save(true);
    });
    await rendered(page);
    await renameWall(page, 'Canvas 往返');
    const original = await page.evaluate(() => structuredClone(data));
    const sizes = await page.locator('.card').evaluateAll(els => Object.fromEntries(els.map(el => [el.dataset.id, [el.offsetWidth, el.offsetHeight]])));
    const exported = await download(page, 'canvas', 'round-09-export.canvas');
    const canvas = exported.value;
    assert.equal(exported.name, 'Canvas 往返.canvas');
    assert.deepEqual(await page.evaluate(() => data), original, 'export must not mutate the wall');
    const allIds = [...canvas.nodes, ...canvas.edges].map(item => item.id);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.ok(allIds.every(id => typeof id === 'string' && id.length));
    const cards = canvas.nodes.filter(n => n.type === 'text'), groups = canvas.nodes.filter(n => n.type === 'group');
    assert.equal(cards.length, original.cards.length); assert.equal(groups.length, original.bands.length);
    assert.ok(canvas.nodes.every(n => ['text', 'group'].includes(n.type)
      && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(n[key])) && n.width > 0 && n.height > 0));
    assert.deepEqual(canvas.nodes.slice(0, groups.length), groups, 'groups are behind cards');
    for (const [i, card] of cards.entries()) {
      const source = original.cards[i];
      assert.equal(card.color, String(i + 1));
      assert.deepEqual([card.x, card.y], [Math.round(source.x), Math.round(source.y)]);
      assert.deepEqual([card.width, card.height], sizes[source.id]);
      assert.equal(card.text, `## ${source.title}\n\n${source.note}\n\n- [來源](https://example.com/${source.color})`);
      assert.deepEqual(card.detective, source);
    }
    const left = Math.min(...cards.map(c => c.x)), right = Math.max(...cards.map(c => c.x + c.width));
    for (const [i, group] of groups.entries()) {
      assert.equal(group.x, left - 40); assert.equal(group.width, right - left + 80);
      assert.equal(group.y, original.bands[i].y); assert.equal(group.label, original.bands[i].title);
      assert.deepEqual(group.detective, {band: true, id: original.bands[i].id});
    }
    assert.equal(groups[0].height, groups[1].y - groups[0].y);
    assert.equal(groups[1].y + groups[1].height, Math.max(...cards.map(c => c.y + c.height)) + 40);
    assert.deepEqual(canvas.edges.map(e => e.color), ['1', '5', '3']);
    canvas.edges.forEach((edge, i) => {
      assert.equal(edge.fromSide, 'top'); assert.equal(edge.toSide, 'top'); assert.equal(edge.toEnd, 'arrow');
      assert.equal(edge.fromNode, original.edges[i].from); assert.equal(edge.toNode, original.edges[i].to);
      assert.equal(edge.label, original.edges[i].label); assert.equal(edge.detective.type, original.edges[i].type);
    });
    assert.equal(canvas.detective.version, 1); assert.deepEqual(canvas.detective.tags, original.tags);
    assert.deepEqual(Object.keys(canvas.detective.images), ['image']);
    assert.match(canvas.detective.images.image, /^data:image\/png;base64,/);
    const json = await download(page, 'json', 'round-09-export.json');
    assert.deepEqual(json.value.images, canvas.detective.images);
    assert.deepEqual(json.value.cards, original.cards);
    pass('Canvas download: unique IDs, integer rendered geometry, Markdown, all colors, groups, labeled top-pin edges and referenced images; JSON remains compatible');

    const fresh = await newPage();
    await fresh.click('#add-wall'); await settled(fresh);
    const empty = await fresh.evaluate(() => structuredClone(data));
    assert.ok(await fresh.evaluate(async () => !!await store.getImage('image')));
    await open(fresh, canvas); assert.deepEqual(await fresh.evaluate(() => data), empty);
    await apply(fresh, true); await rendered(fresh);
    const restored = await fresh.evaluate(() => structuredClone(data));
    assert.deepEqual(restored.cards, original.cards.map(c => ({...c, x: Math.round(c.x), y: Math.round(c.y)})));
    assert.deepEqual(restored.bands, original.bands); assert.deepEqual(restored.tags, original.tags);
    assert.deepEqual(edgeValues(restored.edges), edgeValues(original.edges));
    const restoredImage = await fresh.evaluate(async () => {
      const image = await store.getImage('image');
      return {size: [image.width, image.height], type: image.type, bytes: [...new Uint8Array(await image.blob.arrayBuffer())]};
    });
    assert.deepEqual(restoredImage, {size: [40, 20], type: 'image/png', bytes: [...Buffer.from(canvas.detective.images.image.split(',')[1], 'base64')]});
    const backups = await fresh.evaluate(() => store.listBackups(currentWall.id));
    assert.equal(backups.length, 1); assert.equal(backups[0].reason, '整份取代前');
    assert.deepEqual(await fresh.evaluate(async id => (await store.getBackup(id)).data, backups[0].id), empty);
    await fresh.click('#undo'); assert.deepEqual(await fresh.evaluate(() => data), empty);
    await fresh.click('#redo'); assert.deepEqual(await fresh.evaluate(() => data), restored);
    await reload(fresh); await rendered(fresh);
    pass('fresh-database round trip preserves card fields, tags, image bytes, bands and labeled edge types; replace backs up and supports undo/redo/reload');

    const moved = structuredClone(canvas);
    const movedCard = moved.nodes.find(n => n.id === 'purple');
    movedCard.id = 'moved-purple'; movedCard.x = 1234; movedCard.y = -567;
    await open(fresh, moved, 'renamed.json');
    assert.deepEqual(await fresh.evaluate(() => {
      const c = pending.cards.find(c => c.id === 'moved-purple'); return [c.title, c.x, c.y];
    }), ['線索 purple', 1234, -567]);
    await fresh.click('#im-cancel');
    pass('Canvas node IDs and moved positions override the original detective card');

    const plain = {nodes: [
      node('text', 'text', {text: '### 外部標題\n\n**外部筆記**', color: '1'}),
      node('file', 'file', {file: '資料/來源.pdf', subpath: '#page=3', color: '2'}),
      node('link', 'link', {url: 'https://example.org/paper?a=1', color: '4'}),
      node('hex', 'text', {text: 'a'.repeat(70) + '\n rest ', color: '#AABBCC'}),
      node('group', 'group', {label: '外部分層', y: -40}),
      node('untitled', 'group', {y: 900}),
    ], edges: [
      {id: 'a', fromNode: 'text', toNode: 'file', color: '1', label: '建立'},
      {id: 'b', fromNode: 'file', toNode: 'link', color: '5', label: '使用'},
      {id: 'c', fromNode: 'link', toNode: 'hex', color: '3', label: '問題'},
      {id: 'd', fromNode: 'hex', toNode: 'text', color: '#123456'},
      {id: 'e', fromNode: 'group', toNode: 'text'}, {id: 'f', fromNode: 'text', toNode: 'group'},
    ]};
    const external = await newPage();
    const before = await external.evaluate(() => structuredClone(data));
    await open(external, plain);
    assert.deepEqual(await external.evaluate(() => data), before);
    const preview = await external.evaluate(() => ({cards: pending.cards, bands: pending.bands, edges: pending.edges}));
    assert.deepEqual(preview.cards.map(c => [c.title, c.note, c.color]), [
      ['外部標題', '**外部筆記**', 'red'], ['來源.pdf', '', 'amber'], ['example.org', '', 'green'], ['a'.repeat(60), 'rest', 'slate'],
    ]);
    assert.deepEqual(preview.cards[1].links, [{label: '來源.pdf', href: '資料/來源.pdf#page=3'}]);
    assert.deepEqual(preview.cards[2].links, [{label: 'https://example.org/paper?a=1', href: 'https://example.org/paper?a=1'}]);
    assert.deepEqual(preview.bands, [{id: 'group', title: '外部分層', y: -40}, {id: 'untitled', title: '分層', y: 900}]);
    assert.deepEqual(preview.edges.map(e => [e.type, e.label]), [['builds', '建立'], ['uses', '使用'], ['question', '問題'], ['uses', '']]);
    await external.screenshot({path: path.join(OUT, 'round-09-preview.png')});
    await external.locator('.im-row').filter({hasText: 'a'.repeat(60)}).first().locator('input').uncheck();
    await apply(external);
    assert.equal(await external.evaluate(() => !!byId('hex')), false);
    assert.equal(await external.evaluate(() => data.edges.length), before.edges.length + 2);
    assert.ok((await external.evaluate(() => store.listBackups(currentWall.id)))[0].reason.includes('fixture.canvas'));
    await external.click('#undo'); assert.deepEqual(await external.evaluate(() => data), before);
    await open(external, plain); await apply(external, true);
    assert.deepEqual(await external.evaluate(() => data.cards), preview.cards);
    pass('plain Obsidian canvas maps headings, files/subpaths, URL hostnames, groups, presets/hex and edge labels through preview; selection, backup and undo work');

    await open(external, {nodes: colors.map((color, i) => node(color, 'text', {text: color, color: String(i + 1)})), edges: [
      {id: 'extension', fromNode: 'red', toNode: 'amber', color: '3', detective: {type: 'builds'}},
      {id: 'default', fromNode: 'amber', toNode: 'cream'},
    ]});
    assert.deepEqual(await external.evaluate(() => pending.cards.map(c => c.color)), colors);
    assert.deepEqual(await external.evaluate(() => pending.edges.map(e => e.type)), ['builds', 'uses']);
    await external.click('#im-cancel');
    pass('all six reverse presets map correctly; detective edge type takes precedence and missing color defaults to uses');

    assert.ok(await external.evaluate(() => !!window.marked && !!window.DOMPurify), 'real CDN libraries required to test sanitization');
    const malicious = {nodes: [node('evil', 'text', {text: '# <img src=x onerror=alert(1)>\n\n**safe**\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))'})], edges: []};
    await open(external, malicious);
    assert.equal(await external.locator('#im-list img, #im-list script').count(), 0);
    await apply(external, true);
    assert.equal(await external.locator('.card h3').textContent(), '<img src=x onerror=alert(1)>');
    assert.equal(await external.locator('.card .md strong').textContent(), 'safe');
    assert.equal(await external.locator('.card img, .card script').count(), 0);
    assert.ok(await external.locator('.card').evaluate(el => [...el.querySelectorAll('*')].every(n =>
      [...n.attributes].every(a => !/^on/i.test(a.name) && !/^javascript:/i.test(a.value.trim())))));
    pass('malicious Canvas title stays text; Markdown renders through real DOMPurify without scripts, images, event handlers or javascript links');

    const malformed = {nodes: [null, 3, {}, node(5, 'text', {text: 'bad'}), node('', 'text', {text: 'bad'}),
      node('bad-x', 'text', {text: 'bad', x: '10'}), node('bad-y', 'text', {text: 'bad', y: null}),
      node('bad-text', 'text', {text: {}}), node('bad-file', 'file', {file: 7}), node('bad-link', 'link', {url: 'not a URL'}),
      node('bad-type', 'other'), node('ok', 'text', {text: '# Valid\nNote', detective: {kind: 'card', title: {}, links: 2}}),
      node('ok', 'group'), node('other', 'text', {text: 'Other'}),
    ], edges: [null, {}, {id: 'bad-end', fromNode: {}, toNode: 'ok'}, {id: 'missing', fromNode: 'ok', toNode: 'missing'},
      {fromNode: 'ok', toNode: 'other'}, {id: 'self', fromNode: 'ok', toNode: 'ok'},
      {id: 'valid', fromNode: 'ok', toNode: 'other', detective: {type: 'constructor'}, color: '3', label: {}},
      {id: 'valid', fromNode: 'other', toNode: 'ok'},
    ], detective: {tags: [{id: 7, name: 'bad'}], images: {bad: 'data:text/html;base64,PHNjcmlwdD4='}}};
    await open(external, malformed);
    assert.deepEqual(await external.evaluate(() => pending.cards.map(c => c.id)), ['ok', 'other']);
    assert.deepEqual(await external.evaluate(() => [pending.edges.length, pending.edges[0].type, pending.edges[0].label, pending.tags, pending.images]), [1, 'question', '', [], {}]);
    await apply(external, true);
    assert.deepEqual(await external.evaluate(() => data.cards.map(c => c.title)), ['Valid', 'Other']);
    const unchanged = await external.evaluate(() => structuredClone(data));
    for (const value of [{nodes: [], edges: []}, {nodes: [node('too-long', 'group', {label: 'x'.repeat(61)})]},
      {nodes: [null, node('bad', 'text', {x: null})]}, {nodes: {}}, null, '{bad JSON',
      '{"nodes":[{"id":"infinite","type":"text","x":1e999,"y":0,"text":"bad"}]}']) {
      await upload(external, value);
      await external.waitForFunction(() => document.querySelector('#import').textContent === '不是案件圖譜或 Canvas 檔');
      assert.equal(await external.isVisible('#importer'), false);
      assert.deepEqual(await external.evaluate(() => data), unchanged);
    }
    await open(external, {nodes: [node('only', 'text', {text: 'No edges'})], edges: {bad: true}});
    assert.deepEqual(await external.evaluate(() => pending.edges), []);
    await external.click('#im-cancel');
    pass('malformed nodes, duplicate IDs, invalid edges/extensions and non-finite positions are skipped; empty/invalid canvases flash without mutation');

    await page.evaluate(() => { window.getImageBeforeFailure = store.getImage; store.getImage = async () => { throw new Error('read failed'); }; });
    for (const selector of ['#export', '#export-canvas']) {
      await page.click(selector);
      await page.waitForFunction(selector => document.querySelector(selector).textContent === '無法匯出圖片', selector);
    }
    await page.evaluate(() => { store.getImage = getImageBeforeFailure; });
    pass('JSON and Canvas use the same image export error path');
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    pass('no page errors or dialogs');
    fs.writeFileSync(path.join(OUT, 'round-09-result.json'), JSON.stringify({passed: true, browser: browser.browserType().name(), errors, dialogs}, null, 2) + '\n');
    console.log('Artifacts retained: ' + OUT);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
