const { ready, reload, settled: waitSettled, openActivity, artifacts, profile } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
// Keep test artifacts in the authorized task directory; retain them for review.
const OUT = artifacts('round-01');
const PROF = profile();
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const ctx = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launchPersistentContext(PROF, { viewport: { width: 1400, height: 900 }, downloadsPath: OUT });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
    const seed = await page.evaluate(() => structuredClone(data));
    const text = '#strings text[data-id="e1"]', input = '#edge-label';
    const edge = () => page.evaluate(() => structuredClone(data.edges.find(e => e.id === 'e1')));
    const openEdge = async () => {
      const p = await page.locator('.hit[data-id="e1"]').evaluate(el => {
        const p = el.getPointAtLength(el.getTotalLength() / 2).matrixTransform(el.getScreenCTM());
        return { x: p.x, y: p.y };
      });
      await page.mouse.click(p.x, p.y);
    };
    const midpoint = () => page.evaluate(() => {
      const label = document.querySelector('#strings text[data-id="e1"]');
      const values = document.querySelector('.hit[data-id="e1"]').getAttribute('d').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
      const [ax, ay, cx, cy, bx, by] = values;
      const x = Number(label.getAttribute('x')), y = Number(label.getAttribute('y'));
      return { x, y, matches: Math.abs(x - (ax / 4 + cx / 2 + bx / 4)) < 1e-6 && Math.abs(y - (ay / 4 + cy / 2 + by / 4)) < 1e-6 };
    });

    await openEdge();
    ok(await page.isVisible('#edgepop') && await page.inputValue(input) === '', 'unlabelled edge opens with empty input');
    await page.fill(input, '共享基礎');
    ok((await edge()).label === '共享基礎' && await page.textContent(text) === '共享基礎', 'popup edits data and SVG text live');
    ok((await midpoint()).matches, 'label is at quadratic t = 0.5');
    await reload(page);
    ok((await edge()).label === '共享基礎' && await page.textContent(text) === '共享基礎', 'label persists after reload');
    await page.click(text);
    ok(await page.isVisible('#edgepop') && await page.inputValue(input) === '共享基礎' && await page.evaluate(() => selEdge) === 'e1', 'clicking label selects edge and fills input');

    const lineWidth = () => page.locator('.hit[data-id="e1"]').evaluate(el => Number(el.previousElementSibling.getAttribute('stroke-width')));
    ok(await page.locator('#edgepop [data-weight="normal"]').evaluate(el => el.classList.contains('on')) && await lineWidth() === 3, 'edge starts at normal weight (selected draws one step heavier)');
    await page.click('#edgepop [data-weight="heavy"]');
    ok((await edge()).weight === 'heavy' && await lineWidth() === 6 && await page.locator('#edgepop [data-weight="heavy"]').evaluate(el => el.classList.contains('on')), 'choosing 特粗 stores the weight and thickens the line');
    await page.keyboard.press('Escape');
    ok(await lineWidth() === 5, 'unselected heavy line keeps its own width');
    await page.evaluate(() => undo());
    ok(!(await edge()).weight, 'undo restores the previous weight');
    await page.evaluate(() => redo());
    ok((await edge()).weight === 'heavy', 'redo reapplies the weight');
    await page.evaluate(() => save(true));
    await reload(page);
    ok((await edge()).weight === 'heavy' && await lineWidth() === 5, 'line weight persists after reload');
    await page.click(text);
    await page.click('#edgepop [data-weight="normal"]');
    ok(!('weight' in await edge()) && await lineWidth() === 3, 'choosing 標準 removes the stored weight');

    await page.fill(input, 'ABC');
    await page.press(input, 'Home'); await page.press(input, 'Delete');
    ok(await page.inputValue(input) === 'BC' && (await edge()).label === 'BC' && await page.evaluate(() => data.edges.length) === seed.edges.length, 'Delete edits text without deleting edge');
    await page.press(input, 'End'); await page.press(input, 'Backspace');
    ok(await page.inputValue(input) === 'B' && (await edge()).label === 'B' && await page.evaluate(() => data.edges.length) === seed.edges.length, 'Backspace edits text without deleting edge');
    await page.fill(input, '共享基礎');
    await page.press(input, 'Escape');
    ok(!(await page.isVisible('#edgepop')) && await page.evaluate(() => selEdge) === null, 'Escape closes popup while input is focused');

    const before = await midpoint();
    const card = await page.locator('.card[data-id="shoup"]').boundingBox();
    await page.mouse.move(card.x + 50, card.y + 30); await page.mouse.down();
    await page.mouse.move(card.x + 170, card.y + 90, { steps: 6 });
    const moving = await midpoint();
    ok(Math.abs(moving.x - before.x) > 40 && moving.y !== before.y && moving.matches, 'label follows card during drag at curve midpoint');
    await page.mouse.up();
    await page.waitForFunction(() => !Object.keys(spring).length);
    const settled = await midpoint();
    ok(settled.matches && Math.abs(settled.y - moving.y) > 0.1, 'label follows spring sag through settling');

    const incoming = await page.evaluate(() => structuredClone(data));
    incoming.edges.find(e => e.id === 'e1').label = '  更新標籤  ';
    const file = path.join(OUT, 'label-only.json'); fs.writeFileSync(file, JSON.stringify(incoming));
    await page.setInputFiles('#import-file', file); await page.waitForSelector('#importer[open]');
    const summary = await page.textContent('#im-summary');
    ok(summary.includes(`新卡片 0｜有變更的卡片 0｜新連線 0｜有變更的連線 1｜${seed.cards.length + seed.edges.length - 1} 項與目前相同`) && await page.locator('#im-list .im-row').count() === 1, 'label-only import has exactly one changed string: ' + summary);
    const row = await page.textContent('#im-list .im-row');
    ok(row.includes('共享基礎') && row.includes('更新標籤') && (await edge()).label === '共享基礎', 'preview shows old and new labels without changing data');
    await page.click('#im-apply'); await waitSettled(page);
    ok((await edge()).label === '更新標籤' && await page.textContent(text) === '更新標籤', 'applying import updates and trims label');
    await reload(page);
    ok((await edge()).label === '更新標籤', 'imported label persists');
    await page.setInputFiles('#import-file', file); await page.waitForSelector('#importer[open]');
    ok(await page.isDisabled('#im-apply') && (await page.textContent('#im-summary')).includes(`${seed.cards.length + seed.edges.length} 項與目前相同`), 'equal type, direction and label count as identical (including missing labels)');
    await page.click('#im-cancel');
    ok(await page.evaluate(() => {
      const labels = [undefined, '', '   ', '  ' + '字'.repeat(210) + '  ', 42];
      const normalized = labels.map(label => normalize({ cards: [], edges: [{ from: 'shoup', to: 'dt', type: 'builds', label }] }).edges[0].label);
      return JSON.stringify(normalized) === JSON.stringify(['', '', '', '字'.repeat(200), '42']);
    }), 'normalize keeps trimmed strings of at most 200 characters');

    await page.click(text);
    const payload = '<img src=x onerror=alert(1)>';
    await page.fill(input, payload);
    const visiblePayload = [...payload].slice(0, 11).join('') + '…';
    ok(await page.textContent(text) === visiblePayload && await page.locator('img:not(#sidebar img)').count() === 0 && dialogs.length === 0, 'HTML-like label renders truncated text only');
    await page.press(input, 'Escape');
    await openActivity(page, 'theme');
    for (const theme of ['moon', 'whiteboard', 'wood', 'paper', 'cyber']) {
      await page.selectOption('#theme', theme);
      ok(await page.locator(text).evaluate(el => {
        const edgeEl = document.querySelector('.hit[data-id="e1"]').previousElementSibling;
        const style = getComputedStyle(edgeEl);
        const edge = style;
        const label = getComputedStyle(el), paper = getComputedStyle(el.previousElementSibling);
        return style.stroke === edge.stroke && label.fill === edge.stroke && paper.fill !== 'none';
      }), theme + ': line and label use the edge colour with a paper label background');
    }

    await openActivity(page, 'files');
    const download = page.waitForEvent('download');
    await page.click('#export');
    const exported = path.join(OUT, 'labels-export.json'); await (await download).saveAs(exported);
    ok(JSON.parse(fs.readFileSync(exported, 'utf8')).edges.find(e => e.id === 'e1').label === payload, 'existing export includes label');

    // Put a card over the label to exercise the actual pointer target, not just CSS z-index.
    await page.evaluate(() => {
      const label = document.querySelector('#strings text[data-id="e1"]'), c = byId('q2');
      c.x = Number(label.getAttribute('x')) - 85; c.y = Number(label.getAttribute('y')) - 30;
      render();
    });
    const labelBox = await page.locator(text).boundingBox();
    await page.mouse.click(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    ok(await page.isVisible('#panel') && await page.evaluate(() => selCard) === 'q2', 'label does not block a card overlapping it');
    await page.click('#f-close');
    await page.screenshot({ path: path.join(OUT, 'round-01.png') });
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
    console.log('Artifacts: ' + OUT);
  } finally {
    await ctx.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
