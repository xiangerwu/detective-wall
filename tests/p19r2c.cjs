const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const playwright = require('playwright-core');
const {ready, reload} = require('./wall-ready.cjs');
const {normalizeProposalOps} = require('../server/db.js');

const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'p19r2c');
const SAMPLES = path.resolve(__dirname, '..', 'test-results', 'p19r2c-samples', 'index.html');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const failures = [];
const ok = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};

const fixture = {
  bands: [], tags: [],
  cards: [
    {id: 'custom-card', kind: 'card', x: 120, y: 120, title: '自訂色卡', note: '確認標題與筆記對比。', links: []},
    {id: 'paste-card', kind: 'note', x: 520, y: 120, title: '貼上目標', note: '', links: []},
  ],
  edges: [],
};

async function waitPaint(page) { await page.waitForTimeout(350); }

async function setFixture(page) {
  await page.evaluate(async value => {
    data = structuredClone(value);
    lastJSON = JSON.stringify(data); past.length = future.length = 0;
    activeTags.clear(); anchorFilter = ''; clearPicked(); closePanel(); selectEdge(null);
    bandpop.hidden = true; cardMenu.hidden = true; showActivity(null); render(); fitView(true); await save(true);
  }, fixture);
  await waitPaint(page);
}

async function setPickedColor(page, color) {
  const button = page.locator('#f-color button[data-color="custom"]');
  if (!(await button.count())) return false;
  await button.click();
  const input = page.locator('#f-custom-color');
  if (!(await input.count())) return false;
  await input.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }, color);
  await waitPaint(page);
  return true;
}

function ratio(foreground, background) {
  const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = value => value.map(channel => channel / 255).map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const [light, dark] = [lum(rgb(foreground)), lum(rgb(background))].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

async function cardContrast(page, id) {
  return page.evaluate(id => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    const text = card?.querySelector('h3'), body = card?.querySelector('.md, p');
    const background = card && getComputedStyle(card).backgroundColor;
    const values = element => element && [getComputedStyle(element).color, background];
    return {card: values(card), title: values(text), body: values(body)};
  }, id);
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    // Part A artifacts are standalone samples; no product selectors are changed for them.
    const sample = await browser.newPage({viewport: {width: 1440, height: 1800}});
    await sample.goto(pathToFileURL(SAMPLES).href);
    await sample.waitForTimeout(100);
    await sample.locator('h2').nth(0).screenshot({path: path.join(OUT, 'tabs-heading.png')});
    await sample.locator('.variant-grid').nth(0).screenshot({path: path.join(path.dirname(SAMPLES), 'tabs-cork-moon.png')});
    await sample.locator('.variant-grid').nth(1).screenshot({path: path.join(path.dirname(SAMPLES), 'edgepop-cork-moon.png')});
    await sample.screenshot({path: path.join(path.dirname(SAMPLES), 'overview.png'), fullPage: true});
    ok(await sample.locator('.variant').count() === 8, 'samples compare T1–T4 and E1–E4');
    ok(await sample.locator('.clipboard.cork').count() === 4 && await sample.locator('.clipboard.moon').count() === 4,
      'tab samples show cork and moon at both sidebar widths');
    ok(await sample.locator('.edge-scene.cork').count() === 4 && await sample.locator('.edge-scene.moon').count() === 4,
      'edge popup samples show all four variants in cork and moon');
    await sample.close();

    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page); await setFixture(page);

    // These are deliberately structural: the existing editor order fails before R2c.
    await page.evaluate(() => openPanel('custom-card'));
    await waitPaint(page);
    const editor = await page.evaluate(() => {
      const body = document.querySelector('#panel-body');
      const all = [...body.querySelectorAll('*')];
      const index = selector => all.indexOf(document.querySelector(selector));
      const parent = selector => document.querySelector(selector)?.closest('.editor-pair-row, .editor-options-row');
      return {
        order: ['#f-mount', '#f-note', '#f-links', '#f-tags', '#f-level', '#f-color', '#f-size-reset', '#f-fold', '#f-curl', '#f-del'].map(index),
        pair: parent('#f-tags') && parent('#f-tags') === parent('#f-level'),
        options: ['#f-color', '#f-size-reset', '#f-fold', '#f-curl', '#f-del'].every(selector => parent(selector)?.classList.contains('editor-options-row')),
        custom: document.querySelector('#f-color button[data-color="custom"]') !== null,
        native: document.querySelector('#f-custom-color')?.type === 'color',
      };
    });
    ok(editor.order.every((value, index, all) => value >= 0 && (index === 0 || value > all[index - 1])),
      'editor fields follow fixed, note, source, tags/level, then color/size/toggles/delete order');
    ok(editor.pair && editor.options, 'editor uses the required two rows for tags/level and final options');
    ok(editor.custom && editor.native, 'editor exposes a 自訂 swatch backed by a native colour input');

    const picked = await setPickedColor(page, '#fffbe6');
    ok(picked && await page.evaluate(() => data.cards.find(card => card.id === 'custom-card')?.color) === '#fffbe6',
      'picking a custom colour stores the hex on the card');
    await page.evaluate(() => save(true));
    await reload(page);
    ok(await page.evaluate(() => data.cards.find(card => card.id === 'custom-card')?.color) === '#fffbe6',
      'custom colour survives reload');
    await page.evaluate(() => openPanel('custom-card'));
    await waitPaint(page);

    // Pick a second value, then prove the same save path participates in undo/redo.
    const pickedDark = await setPickedColor(page, '#121212');
    await page.evaluate(() => undo());
    ok(pickedDark && await page.evaluate(() => data.cards.find(card => card.id === 'custom-card')?.color) === '#fffbe6',
      'undo restores the previous custom colour');
    await page.evaluate(() => redo());
    ok(await page.evaluate(() => data.cards.find(card => card.id === 'custom-card')?.color) === '#121212',
      'redo reapplies the custom colour');

    // Paste uses normalize(), so the custom value must survive the clipboard path.
    await page.evaluate(async () => {
      const source = structuredClone(byId('custom-card'));
      await pasteCards({casegraph: 'cards/v1', cards: [source], edges: [], tags: [], images: {}}, {x: 780, y: 120});
    });
    ok(await page.evaluate(() => data.cards.filter(card => card.color === '#121212').length >= 2),
      'copy/paste preserves a custom colour');

    const canvas = await page.evaluate(() => toCanvas(structuredClone(data)));
    const canvasColor = canvas.nodes.find(node => node.id === 'custom-card')?.color;
    ok(canvasColor === '#121212', 'JSON Canvas export carries a custom hex colour');
    const roundTrip = await page.evaluate(value => normalize(fromCanvas(value)).cards.find(card => card.id === 'custom-card')?.color, canvas);
    ok(roundTrip === '#121212', 'JSON Canvas import restores a custom hex colour');

    const normalized = await page.evaluate(() => normalize({cards: [
      {id: 'valid-hex', kind: 'card', x: 0, y: 0, title: '', note: '', links: [], color: '#AABBCC'},
      {id: 'invalid-hex', kind: 'card', x: 0, y: 0, title: '', note: '', links: [], color: 'blue'},
      {id: 'preset', kind: 'card', x: 0, y: 0, title: '', note: '', links: [], color: 'red'},
    ], edges: []}).cards);
    ok(normalized.find(card => card.id === 'valid-hex')?.color === '#aabbcc'
      && !Object.hasOwn(normalized.find(card => card.id === 'invalid-hex'), 'color')
      && normalized.find(card => card.id === 'preset')?.color === 'red',
    'normalize accepts only #rrggbb or known preset keys');

    // Import diff must display the old/new colour instead of treating custom values as an unknown preset.
    const incoming = await page.evaluate(() => {
      const value = structuredClone(data);
      value.cards.find(card => card.id === 'custom-card').color = '#abcdef';
      return value;
    });
    const importFile = path.join(OUT, 'custom-colour-diff.json');
    fs.writeFileSync(importFile, JSON.stringify(incoming));
    await page.setInputFiles('#import-file', importFile); await page.waitForSelector('#importer[open]');
    const rows = await page.locator('#im-list .im-row').allTextContents();
    ok(rows.some(row => row.includes('#abcdef')), 'import diff shows a changed custom colour');
    await page.click('#im-cancel');

    const proposalText = await page.evaluate(color => {
      const detail = document.createElement('div');
      appendReviewDetail(detail, {op: {type: 'update_card', cardId: 'custom-card', color}}, id => id);
      return detail.textContent;
    }, '#fedcba');
    ok(proposalText.includes('#fedcba'), 'AI proposal review shows a proposed custom colour');

    const proposalOps = normalizeProposalOps([
      {op: 'add_card', tempId: 'custom-add', kind: 'card', title: 'AI 色卡', note: '', tags: [], links: [], color: '#ABCDEF'},
      {op: 'update_card', cardId: 'custom-card', color: 'purple'},
    ]);
    ok(proposalOps[0].color === '#abcdef' && proposalOps[1].color === 'purple',
      'AI proposal normalization carries preset and custom card colours');

    for (const color of ['#fffbe6', '#121212']) {
      await page.evaluate(value => { const card = byId('custom-card'); card.color = value; card.note = '對比測試'; render(); }, color);
      for (const style of ['tech', 'paper']) for (const theme of THEMES) {
        await page.evaluate(({style, theme}) => { setTheme(theme); setCardStyle(style); render(); }, {style, theme});
        await waitPaint(page);
        const values = await cardContrast(page, 'custom-card');
        const ratios = [values.title, values.body].filter(Boolean).map(([foreground, background]) => ratio(foreground, background));
        ok(ratios.length === 2 && ratios.every(value => value >= 4.5),
          `${color}/${style}/${theme}: custom title and note contrast is at least 4.5 (${ratios.map(value => value.toFixed(2)).join(', ')})`);
      }
    }
    await page.setViewportSize({width: 1280, height: 720});
    await page.evaluate(() => openPanel('custom-card'));
    await waitPaint(page);
    const editorFit = await page.evaluate(() => {
      const panel = document.querySelector('#panel').getBoundingClientRect();
      const body = document.querySelector('#panel-body').getBoundingClientRect();
      const options = document.querySelector('.editor-options-row').getBoundingClientRect();
      return {inside: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
        rowFits: options.left >= body.left && options.right <= body.right + 1};
    });
    ok(editorFit.inside && editorFit.rowFits, 'editor remains inside 1280×720 and its final row fits the panel');
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2c checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2c custom colours, editor order, proposal flow, and design samples');
})().catch(error => { console.error(error); process.exitCode = 1; });
