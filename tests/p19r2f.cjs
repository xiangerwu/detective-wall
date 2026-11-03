const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.join(ROOT, 'test-results', 'p19r2f');
const NEW_SAMPLE = path.join(ROOT, 'test-results', 'p19r2f-notes', 'index.html');
const OLD_SAMPLE = path.join(ROOT, 'test-results', 'p19-note-samples', 'index.html');
const SAMPLE = fs.existsSync(NEW_SAMPLE) ? NEW_SAMPLE : OLD_SAMPLE;
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

async function sampleChecks(browser) {
  await fs.promises.access(SAMPLE);
  const page = await browser.newPage({viewport: {width: 1920, height: 1600}});
  await page.goto(pathToFileURL(SAMPLE).href); await settled(page);
  const info = await page.evaluate(() => {
    const variants = [...document.querySelectorAll('.variant')];
    const required = ['note', 'card'].flatMap(kind => ['normal', 'folded', 'curl'].map(state => `${kind}/${state}`));
    const matrix = section => required.every(key => {
      const [kind, state] = key.split('/');
      return section.querySelectorAll(`.sample-card[data-kind="${kind}"][data-state="${state}"][data-style="tech"]`).length === 2
        && section.querySelectorAll(`.sample-card[data-kind="${kind}"][data-state="${state}"][data-style="paper"]`).length === 2;
    });
    const normal = [...document.querySelectorAll('.sample-card[data-state=normal]')];
    return {
      ids: variants.map(item => item.dataset.variant),
      sceneCounts: variants.map(item => item.querySelectorAll('.scene[data-theme]').length),
      cardCounts: variants.map(item => item.querySelectorAll('.sample-card').length),
      matrices: variants.map(matrix),
      normalWidths: Object.fromEntries(['note', 'card'].map(kind => [kind,
        normal.filter(card => card.dataset.kind === kind).map(card => card.offsetWidth)])),
      normalAspect: normal.filter(card => card.dataset.kind === 'note').every(card => card.offsetHeight / card.offsetWidth >= .85 && card.offsetHeight / card.offsetWidth <= 1.25),
      themes: ['cork', 'moon'].every(theme => document.querySelectorAll(`.variant .scene[data-theme="${theme}"]`).length === 4),
      mounts: document.querySelectorAll('.sample-card[data-mount=pin]').length > 0 && document.querySelectorAll('.sample-card[data-mount=tape]').length > 0,
      colours: ['amber', 'red', 'green', 'purple', 'custom'].every(color => document.querySelectorAll(`.sample-card[data-color="${color}"]`).length > 0),
      selected: document.querySelectorAll('.sample-card.selected').length > 0,
      baseline: document.querySelectorAll('.baseline-card[data-style=tech][data-kind=note][data-state=normal]').length > 0
        && document.querySelectorAll('.baseline-card[data-style=tech][data-kind=card][data-state=curl]').length > 0
        && document.querySelectorAll('.baseline-card[data-style=paper][data-kind=note][data-state=folded]').length > 0
        && document.querySelectorAll('.baseline-card[data-style=paper][data-kind=card][data-state=normal]').length > 0,
      externalImages: [...document.images].filter(image => /^https?:/i.test(image.currentSrc || image.src)).length,
      externalStyles: [...document.querySelectorAll('link')].filter(link => /^https?:/i.test(link.href)).length,
      svgFilters: document.querySelectorAll('filter').length,
      cssFilter: [...document.querySelectorAll('.variant .sample-card')].some(card => getComputedStyle(card).filter !== 'none'),
    };
  });
  check(JSON.stringify(info.ids) === JSON.stringify(['N5', 'N6', 'N7', 'N8']), 'note samples expose four new, named approaches N5–N8');
  check(info.sceneCounts.length === 4 && info.sceneCounts.every(count => count === 2) && info.cardCounts.every(count => count === 24),
    'each variant has cork/moon scenes with 24 full-size cards');
  check(info.matrices.length === 4 && info.matrices.every(Boolean),
    'each variant defines normal/folded/curl for note and clue card in tech and paper');
  check(info.normalWidths.note?.length === 16 && info.normalWidths.note.every(width => width === 170)
    && info.normalWidths.card?.length === 16 && info.normalWidths.card.every(width => width === 200) && info.normalAspect,
  `sample cards keep product widths (note 170px/card 200px) and square note proportions (${JSON.stringify(info.normalWidths)})`);
  check(info.themes && info.mounts && info.colours && info.selected, 'samples show cork/moon, pin/tape, five colours including custom, and selected state');
  check(info.baseline, 'baseline includes both current tech/paper styles and normal/folded/curl for notes and clue cards');
  check(info.externalImages === 0 && info.externalStyles === 0 && info.svgFilters === 0 && !info.cssFilter,
    'note samples are local CSS-only scenes without SVG or per-card filters');

  fs.mkdirSync(path.dirname(NEW_SAMPLE), {recursive: true});
  await page.screenshot({path: path.join(path.dirname(NEW_SAMPLE), 'overview.png'), fullPage: true});
  for (const section of await page.locator('.variant').all()) {
    const id = await section.getAttribute('data-variant');
    await section.screenshot({path: path.join(path.dirname(NEW_SAMPLE), `${id}-close-up.png`)});
  }
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    await productChecks(browser);
    await sampleChecks(browser);
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2f checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2f K2 clipboard and N5–N8 note samples with screenshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
