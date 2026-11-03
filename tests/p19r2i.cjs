const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const playwright = require('playwright-core');
const {ready, reload, settled, artifacts} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = artifacts('p19r2i');
const SAMPLES = path.resolve(__dirname, '..', 'test-results', 'p19r2i-notes', 'index.html');
const LONG = '1'.repeat(200);
const failures = [];
const ok = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};

const fixture = {
  bands: [], tags: [{id: 'long-tag', name: LONG, color: 'red'}],
  anchorOrder: ['anchor-a', 'anchor-b', 'anchor-c'],
  cards: [
    {id: 'wrap-card', kind: 'card', x: 40, y: 40, title: LONG, note: LONG, tags: ['long-tag'], links: [{label: LONG, href: 'https://example.com/' + LONG}]},
    {id: 'wrap-note', kind: 'note', x: 360, y: 40, title: LONG, note: LONG, tags: ['long-tag'], links: [{label: LONG, href: 'https://example.com/' + LONG}]},
    {id: 'anchor-a', kind: 'card', x: 40, y: 420, title: '錨點 A', note: '', links: [], level: 'source'},
    {id: 'anchor-b', kind: 'card', x: 320, y: 420, title: '錨點 B', note: '', links: [], level: 'key'},
    {id: 'anchor-c', kind: 'note', x: 600, y: 420, title: '錨點 C', note: '', links: [], level: 'source'},
    {id: 'candidate', kind: 'card', x: 880, y: 420, title: '候選卡片', note: '', links: []},
    {id: 'target', kind: 'card', x: 1160, y: 420, title: '候選目標', note: '', links: []},
  ],
  edges: [{id: 'candidate-edge', from: 'candidate', to: 'target', type: 'uses'}],
};

async function waitPaint(page) { await page.waitForTimeout(180); }

async function setFixture(page) {
  await page.evaluate(async value => {
    data = structuredClone(value);
    lastJSON = JSON.stringify(data); past.length = future.length = 0; activeTags.clear(); anchorFilter = '';
    anchorNavOpen = true; clearPicked(); closePanel(); selectEdge(null); bandpop.hidden = true; cardMenu.hidden = true;
    render(); fitView(true); await save(true);
  }, fixture);
  await waitPaint(page);
}

async function overflowAudit(page, style) {
  await page.evaluate(styleName => { setCardStyle(styleName); render(); }, style);
  await page.evaluate(() => { view = {s: 1, x: 0, y: 0}; applyView(); });
  await waitPaint(page);
  const problems = await page.evaluate(() => {
    const selectors = ['h3', '.md', 'p', '.tags', '.tag-chip', '.links', '.links a'];
    const problems = [];
    for (const card of document.querySelectorAll('.card[data-id^="wrap-"]')) {
      card.style.transform = 'none';
      const cardRect = card.getBoundingClientRect(), css = getComputedStyle(card);
      const left = cardRect.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
      const right = cardRect.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
      for (const selector of selectors) for (const child of card.querySelectorAll(selector)) {
        const rect = child.getBoundingClientRect();
        if (rect.right > right + 1 || rect.left < left - 1) problems.push(`${card.dataset.id}:${selector}:${Math.round(rect.left - left)}:${Math.round(rect.right - right)}`);
      }
    }
    return problems;
  });
  return problems;
}

function ratio(foreground, background) {
  const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const luminance = value => value.map(channel => channel / 255).map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const [light, dark] = [luminance(rgb(foreground)), luminance(rgb(background))].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

async function tabGeometry(page, label) {
  const result = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#wall-tabs .wall-tab')];
    const add = document.querySelector('#add-wall')?.getBoundingClientRect();
    const bar = document.querySelector('#wall-tabs');
    const overflow = !!bar && bar.scrollWidth > bar.clientWidth + 1;
    const last = (overflow ? bar?.getBoundingClientRect() : tabs.at(-1)?.getBoundingClientRect());
    return {adjacent: !!last && !!add && Math.abs(add.left - last.right - 8) <= 4, visible: !!add && add.width > 0 && add.height > 0,
      lastRight: last?.right, addLeft: add?.left, overflow, order: tabs.map(tab => tab.dataset.id)};
  });
  ok(result.adjacent && result.visible, `+ button follows the last wall tab after ${label}`);
  return result;
}

async function addWall(page) {
  await page.click('#add-wall');
  await settled(page);
}

async function dragTab(page, fromIndex, toIndex) {
  const from = await page.locator('.wall-tab').nth(fromIndex).boundingBox();
  const target = await page.locator('.wall-tab').nth(toIndex).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps: 8});
  await page.mouse.up();
  await settled(page);
}

async function anchorOrder(page) {
  return page.locator('#rail-anchor-list [data-anchor-card]').evaluateAll(buttons => buttons.map(button => button.dataset.anchorCard));
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    fs.mkdirSync(OUT, {recursive: true});
    const sample = await browser.newPage({viewport: {width: 1500, height: 1800}});
    await sample.goto(pathToFileURL(SAMPLES).href); await sample.waitForTimeout(120);
    ok(await sample.locator('#observations li').count() >= 6, 'samples record the requested Traditional Chinese photo observations');
    ok(await sample.locator('.variant[data-variant="S1"], .variant[data-variant="S2"], .variant[data-variant="S3"], .variant[data-variant="S4"]').count() === 4,
      'samples include four sticky-note variants S1–S4');
    const sampleAudit = await sample.evaluate(() => ({
      states: [...document.querySelectorAll('.sample-card')].every(card => card.dataset.state && (card.dataset.state === 'normal' || card.classList.contains('is-' + card.dataset.state))),
      photos: [...document.querySelectorAll('.reference-grid img')].every(img => img.complete && img.naturalWidth > 0),
      pseudo: [...document.querySelectorAll('.sample-card')].every(card => ['::before', '::after'].filter(pseudo => getComputedStyle(card, pseudo).content !== 'none').length <= 2),
      noSvgFilter: !document.querySelector('svg [filter], svg filter'),
    }));
    ok(sampleAudit.states && sampleAudit.photos && sampleAudit.pseudo && sampleAudit.noSvgFilter,
      'samples cover normal/folded/curled states, local photo comparison, and the two-pseudo-element limit');
    await sample.screenshot({path: path.join(OUT, 'samples-comparison.png'), fullPage: true});
    await sample.close();

    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page); await setFixture(page);

    for (const style of ['tech', 'paper']) {
      const problems = await overflowAudit(page, style);
      ok(problems.length === 0, `${style}: 200-character titles, notes, tags, and links stay inside both card kinds`);
    }
    await page.screenshot({path: path.join(OUT, 'wrapping.png')});

    const currentId = await page.evaluate(() => currentWall.id);
    await page.click(`.wall-tab[data-id="${currentId}"]`, {button: 'right'});
    const customBefore = await page.locator('#tab-colors button[data-color="custom"]').count();
    ok(customBefore === 1 && await page.locator('#tab-custom-color').count() === 1, 'wall tab menu exposes one 自訂 swatch with a native colour input');
    const invalidApi = await page.evaluate(async () => {
      const response = await fetch('/api/meta/tabs', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({value: {order: [], colors: {bad: '#12345'}}})});
      return response.status;
    });
    ok(invalidApi >= 400, 'tabs API rejects a non-#rrggbb custom colour at the boundary');
    const validApi = await page.evaluate(async () => {
      const response = await fetch('/api/meta/tabs', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({value: {order: [], colors: {valid: '#abcd12'}}})});
      return response.status;
    });
    ok(validApi === 200, 'tabs API accepts a valid six-digit custom colour');
    if (await page.locator('#tab-colors button[data-color="custom"]').count()) {
      await page.locator('#tab-colors button[data-color="custom"]').click();
      await page.locator('#tab-custom-color').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true})); }, '#24364f');
      await waitPaint(page);
      const customTab = await page.evaluate(id => {
        const tab = document.querySelector(`.wall-tab[data-id="${CSS.escape(id)}"]`), style = getComputedStyle(tab);
        const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = value => value.map(channel => channel / 255).map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const [light, dark] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((a, b) => b - a);
        return {stored: tabMeta.colors[id], background: style.backgroundColor, color: style.color, contrast: (light + .05) / (dark + .05), className: tab.className};
      }, currentId);
      ok(customTab.stored === '#24364f' && customTab.className.includes('custom-color') && customTab.contrast >= 4.5,
        'custom tab colour stores as hex and keeps readable tab text contrast');
      await page.click(`.wall-tab[data-id="${currentId}"]`, {button: 'right'}); await waitPaint(page);
      const ring = await page.locator('#tab-colors button[data-color="custom"]').evaluate(button => ({pressed: button.getAttribute('aria-pressed'), outline: getComputedStyle(button).outlineStyle}));
      ok(ring.pressed === 'true' && ring.outline !== 'none', 'custom tab swatch shows its selected ring');
      await page.screenshot({path: path.join(OUT, 'tab-menu-custom.png')});
      await reload(page);
      ok(await page.evaluate(id => tabMeta.colors[id], currentId) === '#24364f', 'custom tab colour survives reload');
    }

    await tabGeometry(page, 'initial tabs');
    for (let i = 0; i < 9; i++) await addWall(page);
    const overflowing = await tabGeometry(page, 'adding walls and overflow');
    ok(overflowing.overflow, 'wall tabs overflow the available strip in the overflow fixture');
    const renameId = overflowing.order[1];
    await page.dblclick(`.wall-tab[data-id="${renameId}"]`);
    await page.fill('.wall-tab input', '這是一個重新命名後仍需留在分頁列末端的牆');
    await page.press('.wall-tab input', 'Enter'); await settled(page);
    await tabGeometry(page, 'rename');
    await dragTab(page, 1, 0);
    await tabGeometry(page, 'reorder');
    const removeId = (await page.locator('.wall-tab').last().getAttribute('data-id'));
    await page.locator(`.wall-tab[data-id="${removeId}"]`).click({button: 'right'});
    await page.click('#delete-wall'); await page.click('#delete-wall'); await settled(page);
    await tabGeometry(page, 'remove');

    await setFixture(page);
    await page.evaluate(() => { setRailState('full'); showActivity(null); anchorNavOpen = true; render(); });
    ok(await page.locator('.rail-anchor-suggestion-list, #rail-anchor-list h3').filter({hasText: '可能是源頭'}).count() === 0,
      'rail 分層／錨點 panel removes the 可能是源頭 section');
    ok(await page.locator('#rail-anchor-list [data-anchor-card]').count() === 3, 'rail keeps only the three explicitly marked anchors');
    await page.screenshot({path: path.join(OUT, 'anchor-panel.png')});

    const anchorButtons = page.locator('#rail-anchor-list [data-anchor-card]');
    const boxes = await anchorButtons.evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return {id: button.dataset.anchorCard, x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    }));
    const from = boxes[1], target = boxes[0];
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 2, {steps: 6});
    const indicator = await page.locator('#rail-anchor-list .drop-before, #rail-anchor-list .drop-after').count();
    ok(indicator > 0, 'pointer anchor drag shows a visible drop indicator');
    await page.mouse.up(); await settled(page);
    const draggedOrder = await anchorOrder(page);
    ok(JSON.stringify(draggedOrder) === JSON.stringify(['anchor-b', 'anchor-a', 'anchor-c']), 'pointer drag reorders the marked anchor list');
    await reload(page);
    await page.evaluate(() => { setRailState('full'); showActivity(null); anchorNavOpen = true; render(); });
    ok(JSON.stringify(await anchorOrder(page)) === JSON.stringify(['anchor-b', 'anchor-a', 'anchor-c']), 'pointer anchor order survives reload');

    await page.locator('#rail-anchor-list [data-anchor-card="anchor-c"]').focus();
    await page.keyboard.press('Alt+ArrowUp'); await settled(page);
    const keyboardOrder = await anchorOrder(page);
    ok(JSON.stringify(keyboardOrder) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a']), 'keyboard Alt+ArrowUp reorders anchors');
    await reload(page);
    await page.evaluate(() => { setRailState('full'); showActivity(null); anchorNavOpen = true; render(); });
    ok(JSON.stringify(await anchorOrder(page)) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a']), 'keyboard anchor order survives reload');

    const backup = await page.evaluate(async () => {
      await store.flushWrites(); await backupWall('P19-R2i anchor order');
      const row = (await store.listBackups(currentWall.id))[0];
      return {id: row.id, data: (await store.getBackup(row.id)).data};
    });
    await page.evaluate(async () => { data.anchorOrder = ['anchor-a', 'anchor-c', 'anchor-b']; render(); await save(true); });
    await page.evaluate(value => { openImporter('P19-R2i backup', value); pending.restore = true; }, backup.data);
    await page.click('#im-replace'); await page.click('#im-replace'); await settled(page);
    ok(JSON.stringify(await anchorOrder(page)) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a']), 'backup restore restores anchor order');

    const exportRoundTrip = await page.evaluate(() => {
      const canvas = toCanvas(structuredClone(data));
      const json = normalize({cards: structuredClone(data.cards), edges: structuredClone(data.edges), bands: structuredClone(data.bands), tags: structuredClone(data.tags), anchorOrder: structuredClone(data.anchorOrder)});
      const canvasData = fromCanvas(canvas);
      return {canvas: canvas.detective?.anchorOrder, json: json.anchorOrder, canvasData: canvasData.anchorOrder};
    });
    ok(JSON.stringify(exportRoundTrip.canvas) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a'])
      && JSON.stringify(exportRoundTrip.json) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a'])
      && JSON.stringify(exportRoundTrip.canvasData) === JSON.stringify(['anchor-b', 'anchor-c', 'anchor-a']),
    'JSON and Canvas export/import preserve anchor order');

    await page.evaluate(() => { selCard = 'anchor-a'; renderCards(); });
    await page.focus('#viewport'); await page.keyboard.press(']');
    ok(await page.evaluate(() => selCard) === 'anchor-b', 'next-anchor navigation follows the saved order');
    await page.keyboard.press('[');
    ok(await page.evaluate(() => selCard) === 'anchor-a', 'previous-anchor navigation follows the saved order');
    await page.screenshot({path: path.join(OUT, 'anchor-order.png')});
    const laterAnchor = await page.evaluate(async () => {
      data.cards.push({id: 'anchor-later', kind: 'card', x: 1440, y: 420, title: '後加入錨點', note: '', links: [], level: 'key'});
      ensureAnchorOrder(data); render(); await save(true); return data.anchorOrder.at(-1);
    });
    ok(laterAnchor === 'anchor-later', 'anchors added later append to the saved order');
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2i checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2i wrapping, custom tabs, tab strip, anchor ordering, and sample comparison');
})().catch(error => { console.error(error); process.exitCode = 1; });
