const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.join(ROOT, 'test-results', 'p19r2f');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const failures = [];
const check = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};
const settled = page => page.waitForTimeout(700);

function hit(a, b) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

async function measureProductDefaults(page) {
  const values = {};
  for (const style of ['tech', 'paper']) {
    await page.evaluate(style => {
      setTheme('cork');
      setCardStyle(style, false);
      showClipboard(false, false);
      data = {bands: [], tags: [], cards: [
        {id: 'measure-note', kind: 'note', x: 40, y: 40, title: '疑問便利貼', note: '正文', links: []},
        {id: 'measure-card', kind: 'card', x: 280, y: 40, title: '線索卡', note: '正文', links: []},
      ], edges: []};
      render();
    }, style);
    await settled(page);
    values[style] = await page.evaluate(() => Object.fromEntries(['note', 'card'].map(kind => {
      const card = kind === 'note' ? document.querySelector('.card.note') : document.querySelector('.card:not(.note)');
      return [kind, {width: card?.offsetWidth || 0, height: card?.offsetHeight || 0}];
    })));
  }
  console.log('PRODUCT_DEFAULTS ' + JSON.stringify(values));
  return values;
}

async function productChecks(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  await page.goto(PAGE); await ready(page);
  const defaults = await measureProductDefaults(page);
  check(defaults.tech.note.width === 170 && defaults.tech.card.width === 200,
    `index.html default tech widths are note 170px/card 200px (${JSON.stringify(defaults.tech)})`);
  check(defaults.paper.note.width === 170 && defaults.paper.card.width === 200 && defaults.paper.note.height >= 170,
    `index.html default paper note is a square-sized 170px pad (${JSON.stringify(defaults.paper)})`);
  check(await page.evaluate(() => {
    if (typeof shouldCurlNote !== 'function' || CURL_PROBABILITY !== 1 / 3) return false;
    for (let index = 0; index < 10000; index++) {
      const id = `p19r2f-note-${index}`;
      if (shouldCurlNote({id, kind: 'note'})) return !shouldCurlNote({id, kind: 'card'});
    }
    return false;
  }),
  'product note samples use the id-based curl rule and never curl index cards');

  for (const theme of THEMES) {
    await page.evaluate(theme => { setTheme(theme); setCardStyle('paper', false); showClipboard(true, false); }, theme);
    await settled(page);
    const open = await page.evaluate(() => {
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const clip = document.querySelector('.clipboard-clip'), board = document.querySelector('#case-folder');
      const rect = clip?.getBoundingClientRect(), boardRect = board?.getBoundingClientRect();
      const parts = new Set([...document.querySelectorAll('.clipboard-clip [data-part]')].map(el => el.dataset.part));
      const textNodes = [...document.querySelectorAll('#case-folder-header *, .case-folder-tab')]
        .filter(el => el.textContent.trim() && getComputedStyle(el).display !== 'none');
      return {
        rect: rect && {left: rect.left, top: rect.top, width: rect.width, height: rect.height},
        centerDelta: rect && boardRect ? Math.abs(rect.left + rect.width / 2 - (boardRect.left + boardRect.width / 2)) : Infinity,
        parts: [...parts],
        svg: !!clip?.querySelector('svg.clipboard-clip-art'),
        rivets: clip?.querySelectorAll('[data-part=rivet]').length || 0,
        filters: clip?.querySelectorAll('filter,[filter]').length || 0,
        textOverlap: rect ? textNodes.filter(el => hit(rect, el.getBoundingClientRect())).map(el => el.textContent.trim()) : ['missing clip'],
      };
    });
    check(open.svg && open.rivets >= 2 && open.parts.includes('front-plate') && open.parts.includes('rolled-hinge') && open.parts.includes('flat-lever')
      && open.rect && open.rect.width >= 180 && open.rect.width <= 220 && open.rect.height >= 55 && open.rect.height <= 95,
    `${theme} open board uses the wide K2 Penco brass plate, hinge, lever and rivets`);
    check(open.centerDelta <= 4 && open.textOverlap.length === 0 && open.filters === 0,
      `${theme} open board keeps K2 centred, off header text, and free of SVG filters`);
    if (theme === 'cork' || theme === 'moon') await page.screenshot({path: path.join(OUT, `clipboard-open-${theme}-1400x900.png`)});

    await page.evaluate(() => showClipboard(false, false));
    await settled(page);
    const docked = await page.evaluate(() => {
      const clip = document.querySelector('.clipboard-clip'), board = document.querySelector('#case-folder');
      const rect = clip?.getBoundingClientRect(), boardRect = board?.getBoundingClientRect();
      return {width: rect?.width || 0, height: rect?.height || 0,
        centerDelta: rect && boardRect ? Math.abs(rect.left + rect.width / 2 - (boardRect.left + boardRect.width / 2)) : Infinity,
        design: clip?.dataset.clipDesign || ''};
    });
    check(docked.design === 'K2' && docked.width >= 130 && docked.height >= 55 && docked.centerDelta <= 4,
      `${theme} docked peek keeps the same centred K2 clip geometry`);
  }
  await page.evaluate(() => showClipboard(true, false));
  await settled(page);
  const clipBox = await page.locator('#case-folder .clipboard-clip').boundingBox();
  if (clipBox) {
    await page.screenshot({path: path.join(OUT, 'clipboard-clip-close-up.png'), clip: {
      x: Math.max(0, clipBox.x - 2), y: Math.max(0, clipBox.y - 2),
      width: clipBox.width + 4, height: clipBox.height + 4,
    }});
  }
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    await productChecks(browser);
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2f checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2f K2 clipboard and product notes');
})().catch(error => { console.error(error); process.exitCode = 1; });
