const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = path.resolve(__dirname, '..', 'test-results', 'p19r2b');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
fs.mkdirSync(OUT, {recursive: true});

const failures = [];
function ok(condition, message) {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
}

function contrast(page, selector) {
  return page.evaluate(selector => {
    const numbers = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const element = document.querySelector(selector);
    if (!element) return 0;
    const foreground = numbers(getComputedStyle(element).color);
    const background = numbers(getComputedStyle(element).backgroundColor);
    if (foreground.length !== 3 || background.length !== 3) return 0;
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (light + .05) / (dark + .05);
  }, selector);
}

async function waitPaint(page) {
  await page.waitForTimeout(300);
}

async function setFixture(page, cards, edges = []) {
  await page.evaluate(async ({cards, edges}) => {
    data = {bands: [], tags: [], cards, edges};
    lastJSON = JSON.stringify(data); past.length = future.length = 0;
    activeTags.clear(); anchorFilter = ''; selCard = selEdge = drag = tempLine = null;
    clearPicked(); closePanel(); selectEdge(null); bandpop.hidden = true; cardMenu.hidden = true;
    showActivity(null); render(); fitView(true); await save(true);
  }, {cards, edges});
  await waitPaint(page);
}

async function dragPin(page, from, to) {
  const source = await page.locator(`.card[data-id="${from}"] .pin`).boundingBox();
  const target = await page.locator(`.card[data-id="${to}"]`).boundingBox();
  if (!source || !target) throw new Error(`pin/card not visible: ${from} -> ${to}`);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps: 6});
  await page.mouse.up();
}

async function screenshot(page, name, clip) {
  await waitPaint(page);
  await page.screenshot({path: path.join(OUT, name), ...(clip ? {clip} : {})});
}

function clipAround(rects, viewport) {
  const box = rects.reduce((all, rect) => ({
    left: Math.min(all.left, rect.left), top: Math.min(all.top, rect.top),
    right: Math.max(all.right, rect.right), bottom: Math.max(all.bottom, rect.bottom),
  }), {left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity});
  const x = Math.max(viewport.x, box.left - 44), y = Math.max(viewport.y, box.top - 44);
  return {x, y, width: Math.min(viewport.right, box.right + 44) - x, height: Math.min(viewport.bottom, box.bottom + 44) - y};
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);

    // Badge shape and visibility: both levels must be complete shapes (no clip-path cutting a corner) inside the card box.
    for (const style of ['tech', 'paper']) for (const theme of THEMES) {
      await page.evaluate(({theme, style}) => { setTheme(theme); setCardStyle(style); }, {theme, style});
      await setFixture(page, [
        {id: 'badge-source', kind: 'card', x: 120, y: 180, title: '源頭標記', note: '來源', links: [], level: 'source'},
        {id: 'badge-key', kind: 'card', x: 520, y: 260, title: '重點標記', note: '重點', links: [], level: 'key'},
      ]);
      const badges = await page.evaluate(() => [...document.querySelectorAll('.anchor-badge')].map(badge => {
        const card = badge.closest('.card'), box = badge.getBoundingClientRect(), parent = card.getBoundingClientRect();
        return {level: badge.closest('.card').dataset.level, clip: getComputedStyle(badge).clipPath,
          visible: box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom};
      }));
      ok(badges.length === 2 && badges.every(badge => badge.clip === 'none' && badge.visible), `${theme}/${style}: both level badges are complete shapes with visible boxes`);
    }

    // Rail and last-used type behaviour. The type controls must only appear after a string exists.
    await page.evaluate(() => localStorage.setItem('thesis-detective-wall-last-type', 'question'));
    await page.reload(); await ready(page);
    await page.evaluate(() => { setRailState('full', false); showSidebar(false); });
    await setFixture(page, [
      {id: 'draw-source', kind: 'card', x: 160, y: 220, title: '來源', note: '', links: []},
      {id: 'draw-target', kind: 'card', x: 560, y: 220, title: '目標', note: '', links: []},
    ]);
    ok(await page.locator('#rail #types').count() === 0 && await page.locator('#rail [data-type]').count() === 0,
      'rail removes all new-string type controls');
    await page.waitForFunction(() => document.querySelector('.card[data-id="draw-source"] .pin') && document.querySelector('.card[data-id="draw-target"]'));
    await dragPin(page, 'draw-source', 'draw-target');
    const drawn = await page.evaluate(() => data.edges.at(-1)?.type);
    ok(drawn === 'question', `drawing a string uses the last-used type (got ${drawn})`);
    const edgeId = await page.evaluate(() => data.edges.at(-1).id);
    await page.evaluate(id => selectEdge(id, {x: 320, y: 300}), edgeId);
    await page.click('#edgepop [data-type="uses"]');
    ok(await page.evaluate(id => data.edges.find(edge => edge.id === id)?.type === 'uses', edgeId)
      && await page.evaluate(() => localStorage.getItem('thesis-detective-wall-last-type') === 'uses'),
    'changing the type in the string popup updates the edge and last-used type');

    // Clipboard: sheet structure, active z-order, click and keyboard tab semantics, and paper contrast.
    await page.evaluate(() => { setTheme('cork'); setCardStyle('paper'); setRailState('icon', false); showSidebar(true); showAiTab('chat'); });
    await waitPaint(page);
    const clipboard = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#case-folder-tabs [role=tab]')];
      const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
      const z = tab => Number(getComputedStyle(tab).zIndex) || 0;
      const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = value => value.map(c => c / 255).map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => { const [light, dark] = [lum(a), lum(b)].sort((x, y) => y - x); return (light + .05) / (dark + .05); };
      return {sheets: tabs.length, names: tabs.map(tab => tab.textContent.trim()), clip: !!document.querySelector('.clipboard-clip'), activeTop: !!active && z(active) > Math.max(...tabs.filter(tab => tab !== active).map(z)),
        contrast: tabs.map(tab => ratio(rgb(getComputedStyle(tab).color), rgb(getComputedStyle(tab).backgroundColor)))};
    });
    ok(clipboard.sheets === 4 && JSON.stringify(clipboard.names) === JSON.stringify(['對話', '提案', '紀錄', '模型'])
      && clipboard.clip && clipboard.activeTop && clipboard.contrast.every(value => value >= 4.5),
    `clipboard has four readable sheets with the active sheet on top (${clipboard.contrast.map(value => value.toFixed(2)).join(', ')})`);
    await page.click('#ai-tab-proposals');
    ok(await page.getAttribute('#ai-tab-proposals', 'aria-selected') === 'true' && await page.locator('#case-pane-proposals').isVisible(), 'clipboard switches sheets by click');
    await page.focus('#ai-tab-chat'); await page.keyboard.press('ArrowRight');
    ok(await page.getAttribute('#ai-tab-proposals', 'aria-selected') === 'true', 'clipboard switches sheets with keyboard arrows');

    // Editor placement and reset-button contrast.
    await page.setViewportSize({width: 1400, height: 900});
    await page.evaluate(() => { showSidebar(false); setRailState('hidden', false); });
    await setFixture(page, [{id: 'editor-card', kind: 'card', x: 20, y: 20, title: '正在編輯的卡片', note: '不可被編輯器蓋住', links: []}]);
    await page.evaluate(() => { view = {s: 1, x: 0, y: 0}; applyView(); });
    await page.evaluate(() => openPanel('editor-card'));
    await waitPaint(page);
    const editorCheck = await page.evaluate(() => {
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const card = document.querySelector('.card[data-id="editor-card"]').getBoundingClientRect();
      const editor = document.querySelector('#panel').getBoundingClientRect();
      const reset = document.querySelector('#f-size-reset'), style = getComputedStyle(reset);
      const rgb = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = value => value.map(c => c / 255).map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const [light, dark] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((a, b) => b - a);
      return {overlap: hit(card, editor), resetContrast: (light + .05) / (dark + .05)};
    });
    ok(!editorCheck.overlap && editorCheck.resetContrast >= 4.5,
      `editor stays beside its card and 重設尺寸 remains readable (${editorCheck.resetContrast.toFixed(2)})`);

    // Required P19-R2b screenshots. Every measurement happens after the transition settles.
    for (const theme of THEMES) {
      await page.setViewportSize({width: 1400, height: 900});
      await page.evaluate(async ({theme}) => {
        setTheme(theme); setCardStyle('paper'); data = structuredClone(SEED); render(); fitView(true);
        setRailState('icon', false); showSidebar(true); showActivity(null); closePanel(); showAiTab('chat');
      }, {theme});
      await screenshot(page, `clipboard-chat-${theme}-1400x900.png`);
      await page.click('#ai-tab-proposals');
      await screenshot(page, `clipboard-proposals-${theme}-1400x900.png`);
      await screenshot(page, `top-islands-${theme}-1400x900.png`);

      await setFixture(page, [
        {id: 'badge-source-shot', kind: 'card', x: 260, y: 170, title: '源頭：藍雨衣', note: '來源卡片', links: [], level: 'source'},
        {id: 'badge-key-shot', kind: 'card', x: 540, y: 330, title: '重點：鞋印', note: '待核對', links: [], level: 'key'},
      ]);
      const badgeRects = await page.locator('.anchor-badge').evaluateAll(elements => elements.map(element => {
        const rect = element.closest('.card').getBoundingClientRect(); return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
      }));
      const viewport = await page.locator('#viewport').boundingBox();
      await screenshot(page, `badges-close-up-${theme}.png`, clipAround(badgeRects, {x: viewport.x, y: viewport.y, right: viewport.x + viewport.width, bottom: viewport.y + viewport.height}));

      await setFixture(page, [{id: 'editor-shot', kind: 'card', x: 300, y: 210, title: '小林的口供', note: '黃色壁燈，沒有看清臉。', links: []}]);
      await page.evaluate(() => openPanel('editor-shot'));
      await screenshot(page, `editor-next-to-card-${theme}.png`);

      await page.setViewportSize({width: 1280, height: 720});
      await page.evaluate(() => { closePanel(); showSidebar(true); showAiTab('chat'); setRailState('icon', false); });
      await screenshot(page, `clipboard-chat-${theme}-1280x720.png`);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2b checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2b clipboard, materials, badges, rail type flow, editor placement, and screenshots in ' + OUT);
})().catch(error => { console.error(error); process.exitCode = 1; });
