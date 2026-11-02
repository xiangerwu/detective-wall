const {ready, reload, artifacts} = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');

const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('p14b1');
const ok = (condition, message) => { console.log((condition ? 'PASS ' : 'FAIL ') + message); if (!condition) process.exitCode = 1; };
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(PAGE); await ready(page);
    await page.click('#toggle-sidebar');
    await page.click('#zoom-fit');

    const resetFixture = async () => page.evaluate(async () => {
      data = {bands: [], tags: [], cards: [
        {id: 'source', kind: 'card', x: 100, y: 220, title: '來源卡', note: '固定尺寸測試', links: []},
        {id: 'target-a', kind: 'card', x: 520, y: 100, title: '目標 A', note: '', links: []},
        {id: 'target-b', kind: 'card', x: 520, y: 230, title: '目標 B', note: '', links: []},
        {id: 'target-c', kind: 'card', x: 520, y: 360, title: '目標 C', note: '', links: []},
        {id: 'free', kind: 'note', x: 900, y: 230, title: '未連線疑問', note: '', links: []},
      ], edges: [
        {id: 'edge-a', from: 'source', to: 'target-a', type: 'builds'},
        {id: 'edge-b', from: 'source', to: 'target-b', type: 'uses'},
        {id: 'edge-c', from: 'source', to: 'target-c', type: 'question'},
      ]};
      selCard = selEdge = drag = tempLine = null;
      render(); fitView(true); await save(true);
    });

    await resetFixture();
    const source = page.locator('.card[data-id="source"]');
    const initial = await page.evaluate(() => ({w: document.querySelector('.card[data-id="source"]').offsetWidth,
      h: document.querySelector('.card[data-id="source"]').offsetHeight}));
    const handle = await page.locator('.card[data-id="source"] .resize-handle').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + 120, handle.y + 90, {steps: 8}); await page.mouse.up();
    const resized = await page.evaluate(() => {
      const card = byId('source'), el = document.querySelector('.card[data-id="source"]');
      return {w: card.w, h: card.h, width: el.offsetWidth, height: el.offsetHeight, fixed: el.classList.contains('fixed-size')};
    });
    ok(Number.isInteger(resized.w) && Number.isInteger(resized.h) && resized.w >= 120 && resized.w <= 600
      && resized.h >= 60 && resized.h <= 1200 && resized.width === resized.w && resized.height === resized.h && resized.fixed,
      `resize handle stores integer w/h (${initial.w}×${initial.h} → ${resized.w}×${resized.h})`);
    const visibleResize = await page.locator('.card[data-id="source"] .resize-handle').boundingBox();
    await page.mouse.move(visibleResize.x + visibleResize.width / 2, visibleResize.y + visibleResize.height / 2);
    await page.screenshot({path: path.join(OUT, 'resize-handle.png')});

    await page.keyboard.press('Control+z');
    ok(await page.evaluate(() => !('w' in byId('source')) && !('h' in byId('source'))), 'one resize drag is one undo step');
    const handleAgain = await page.locator('.card[data-id="source"] .resize-handle').boundingBox();
    await page.mouse.move(handleAgain.x + handleAgain.width / 2, handleAgain.y + handleAgain.height / 2);
    await page.mouse.down(); await page.mouse.move(handleAgain.x + 90, handleAgain.y + 60, {steps: 6}); await page.mouse.up();
    const fixedSize = await page.evaluate(() => ({w: byId('source').w, h: byId('source').h}));
    await page.locator('.card[data-id="source"] .resize-handle').dblclick();
    const cleared = await page.evaluate(() => ({card: structuredClone(byId('source')), handle: !!document.querySelector('.card[data-id="source"] .resize-handle')}));
    ok(!('h' in cleared.card) && cleared.card.w === fixedSize.w, 'double-clicking the resize handle restores content height');

    await source.click({position: {x: 24, y: 28}});
    await page.click('#f-size-reset');
    ok(await page.evaluate(() => !('w' in byId('source')) && !('h' in byId('source'))), 'editor reset removes both custom dimensions');
    ok(await page.evaluate(() => {
      const c = byId('source'), previous = structuredClone(c);
      c.note = Array.from({length: 30}, (_, i) => `內容 ${i + 1}`).join('\n'); c.h = 140; render(); jumpToCard(c.id);
      const el = document.querySelector('.card[data-id="source"]'), note = el.querySelector(':scope > .md, :scope > p');
      const grip = el.querySelector('.resize-handle').getBoundingClientRect(), pin = el.querySelector('.pin').getBoundingClientRect();
      // Only the note scrolls: the card itself must not clip its pin or cover its resize grip with a scrollbar.
      const result = el.classList.contains('fixed-size') && el.offsetHeight === 140 && getComputedStyle(el).overflowY === 'visible'
        && note.scrollHeight > note.clientHeight && getComputedStyle(note).overflowY === 'auto'
        && document.elementFromPoint(grip.x + grip.width / 2, grip.y + grip.height / 2)?.closest('.resize-handle')
        && document.elementFromPoint(pin.x + pin.width / 2, pin.y + 2)?.closest('.pin');
      data.cards[data.cards.findIndex(card => card.id === c.id)] = previous; render();
      return result;
    }), 'fixed height scrolls only the note, leaving the pin and resize grip whole');
    ok(await page.evaluate(() => {
      const normalized = normalize({cards: [
        {id: 'legacy-note', kind: 'note', size: 'xl'},
        {id: 'legacy-card', kind: 'card', size: 's'},
        {id: 'bad', w: 9999, h: 1, pin: 'se'},
      ], edges: [{from: 'legacy-note', to: 'legacy-card', type: 'builds', fromAt: {side: 'q', t: .5}, toAt: {side: 's', t: .25}}]});
      return normalized.cards[0].w === 306 && normalized.cards[1].w === 160 && !('size' in normalized.cards[0]) && !('pin' in normalized.cards[2])
        && normalized.cards[2].w === 600 && normalized.cards[2].h === 60 && !('fromAt' in normalized.edges[0]) && normalized.edges[0].toAt.side === 's';
    }), 'normalize converts legacy size once, validates w/h, and drops pin');

    await resetFixture();
    const autoSides = await page.evaluate(() => {
      const auto = autoEndpointMap();
      return data.edges.map(edge => [edgeEndpoint(edge, 'from', auto).at.side, edgeEndpoint(edge, 'to', auto).at.side]);
    });
    const autoPoints = await page.evaluate(() => data.edges.map(edge => edgeEndpoint(edge, 'from', autoEndpointMap()).point));
    ok(new Set(autoPoints.map(point => `${Math.round(point.x)},${Math.round(point.y)}`)).size === 3, 'three automatic endpoints on one edge are spread apart');
    ok(JSON.stringify(autoSides) === JSON.stringify([['e', 's'], ['e', 'w'], ['e', 'w']]), 'automatic endpoints face the other card');
    const mid = await page.locator('.hit[data-id="edge-b"]').evaluate(el => {
      const p = el.getPointAtLength(el.getTotalLength() / 2).matrixTransform(el.getScreenCTM());
      return {x: p.x, y: p.y};
    });
    await page.mouse.move(mid.x, mid.y);
    await page.waitForFunction(() => document.querySelectorAll('.edge-handle[data-edge-id="edge-b"]').length === 2);
    ok(await page.evaluate(() => selEdge === null), 'hovering an unselected edge shows its two end handles without selecting it');
    const hoverHandle = await page.locator('.edge-handle[data-edge-id="edge-b"][data-end="to"]').boundingBox();
    await page.mouse.move(hoverHandle.x + hoverHandle.width / 2, hoverHandle.y + hoverHandle.height / 2, {steps: 4});
    await page.mouse.down(); await page.mouse.move(hoverHandle.x + hoverHandle.width / 2, hoverHandle.y + hoverHandle.height / 2 + 14, {steps: 6}); await page.mouse.up();
    ok(await page.evaluate(() => Boolean(data.edges.find(edge => edge.id === 'edge-b').toAt)), 'a hover handle can be dragged straight away');
    await page.evaluate(() => { delete data.edges.find(edge => edge.id === 'edge-b').toAt; renderStrings(); });
    await page.mouse.move(5, 5); await page.waitForFunction(() => !document.querySelector('.edge-handle'));
    await page.evaluate(() => selectEdge('edge-a', {x: 350, y: 300}));
    ok(await page.locator('.edge-handle').count() === 2 && await page.locator('#edgepop').getByRole('button', {name: '端點改回自動'}).count() === 1,
      'selected edge shows two square endpoint handles and reset control');
    await page.evaluate(() => { panel.hidden = true; pop.hidden = true; });
    await page.screenshot({path: path.join(OUT, 'multiple-edges-selected.png')});
    await page.evaluate(() => { pop.hidden = false; });

    const fromHandle = () => page.locator('.edge-handle[data-end="from"]');
    let box = await fromHandle().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    const corner = await page.evaluate(() => { const r = wall.getBoundingClientRect(), c = byId('source'); return {x: r.left + c.x * view.s, y: r.top + c.y * view.s}; });
    await page.mouse.move(corner.x + 2, corner.y + 2, {steps: 6});
    await page.mouse.up();
    const snapped = await page.evaluate(() => data.edges.find(edge => edge.id === 'edge-a').fromAt);
    ok(snapped?.side === 'n' && snapped.t === 0, 'endpoint drag snaps to a corner');

    const toHandle = () => page.locator('.edge-handle[data-end="to"]');
    box = await toHandle().boundingBox();
    const targetBox = await page.locator('.card[data-id="target-a"]').boundingBox();
    await page.keyboard.down('Shift'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width - 1, targetBox.y + targetBox.height * .35, {steps: 7}); await page.mouse.up(); await page.keyboard.up('Shift');
    const shifted = await page.evaluate(() => data.edges.find(edge => edge.id === 'edge-a').toAt);
    ok(shifted.side === 'e' && shifted.t > .05 && shifted.t < .95 && ![0, .5, 1].includes(shifted.t), 'Shift endpoint drag keeps a free non-grid position');

    box = await fromHandle().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(30, 100, {steps: 6}); await page.mouse.up();
    ok(await page.evaluate(() => data.edges.find(edge => edge.id === 'edge-a').fromAt.t === 0), 'endpoint released on blank space returns to its card');
    const unchanged = await page.evaluate(() => structuredClone(data.edges.find(edge => edge.id === 'edge-a').fromAt));
    box = await fromHandle().boundingBox();
    const targetBCard = await page.locator('.card[data-id="target-b"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(targetBCard.x + targetBCard.width / 2, targetBCard.y + targetBCard.height / 2, {steps: 6}); await page.mouse.up();
    ok(await page.evaluate(old => JSON.stringify(data.edges.find(edge => edge.id === 'edge-a').fromAt) === JSON.stringify(old), unchanged), 'endpoint released on another card returns to its own card');

    ok(await page.evaluate(() => {
      const edge = data.edges.find(value => value.id === 'edge-a');
      const canvas = toCanvas(structuredClone(data)), roundTrip = fromCanvas(canvas);
      const restored = roundTrip.edges.find(value => value.from === edge.from && value.to === edge.to);
      return canvas.edges.find(value => value.fromNode === edge.from && value.toNode === edge.to).fromSide === 'top'
        && restored.fromAt.side === 'top' ? false : restored.fromAt.side === 'n' && restored.fromAt.t === .5;
    }), 'Canvas round trip keeps endpoint side and imports it as a manual midpoint');
    await page.locator('#edgepop').getByRole('button', {name: '端點改回自動'}).click();
    ok(await page.evaluate(() => !('fromAt' in data.edges.find(edge => edge.id === 'edge-a'))
      && !('toAt' in data.edges.find(edge => edge.id === 'edge-a'))), 'reset endpoint control restores both ends to automatic');
    await page.evaluate(() => selectEdge('edge-b', {x: 350, y: 300}));
    const edgeBHandle = await page.locator('.edge-handle[data-end="from"]').boundingBox();
    const sourceNow = await source.boundingBox();
    await page.mouse.move(edgeBHandle.x + 6, edgeBHandle.y + 6); await page.mouse.down(); await page.mouse.move(sourceNow.x + 4, sourceNow.y + 4, {steps: 5}); await page.mouse.up();
    await reload(page);
    ok(await page.evaluate(() => data.edges.find(edge => edge.id === 'edge-b').fromAt?.side === 'n'), 'manual endpoint survives reload');

    await page.evaluate(async () => { selectEdge(null); const c = byId('source'); c.mount = 'tape'; render(); await save(true); });
    await page.click('#zoom-fit');
    ok(await page.evaluate(() => !document.querySelector('.card[data-id="free"]').classList.contains('mount-tape')
      && document.querySelector('.card[data-id="source"]').classList.contains('mount-tape')
      && getComputedStyle(document.querySelector('.card[data-id="source"]'), '::before').content !== 'none'), 'tape mode adds the mount tape only when selected');
    const tapePin = await page.locator('.card[data-id="source"] .pin').boundingBox();
    const free = await page.locator('.card[data-id="free"]').boundingBox();
    const beforeEdges = await page.evaluate(() => data.edges.length);
    await page.mouse.move(tapePin.x + tapePin.width / 2, tapePin.y + tapePin.height / 2); await page.mouse.down();
    await page.mouse.move(free.x + free.width / 2, free.y + free.height / 2, {steps: 7}); await page.mouse.up();
    ok(await page.evaluate(before => data.edges.length === before + 1 && !('fromAt' in data.edges.at(-1)) && !('toAt' in data.edges.at(-1)), beforeEdges),
      'tape mount still exposes a working new-line handle with automatic ends');
    await page.evaluate(() => selectEdge(null));
    await page.click('.card[data-id="source"]');
    await page.click('#f-mount [data-mount=""]');
    ok(await page.evaluate(() => !('mount' in byId('source')) && getComputedStyle(document.querySelector('.card[data-id="source"]'), '::before').content === 'none'), 'switching back to pin removes tape');
    await page.evaluate(async () => { byId('source').mount = 'tape'; byId('free').mount = undefined; setCardStyle('tech'); render(); fitView(true); await save(true); });
    await page.click('#f-close');
    await page.screenshot({path: path.join(OUT, 'mount-tech.png')});
    await page.evaluate(() => { setCardStyle('paper'); render(); fitView(true); });
    await page.screenshot({path: path.join(OUT, 'mount-paper.png')});
    await reload(page);
    ok(await page.evaluate(() => byId('source').mount === 'tape' && document.querySelector('.card[data-id="source"]').classList.contains('mount-tape')), 'mount choice survives reload');
    ok(errors.length === 0, 'no page errors ' + errors.join('; '));
    console.log('Artifacts: ' + OUT);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
