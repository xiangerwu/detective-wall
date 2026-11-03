const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.WALL_TEST_OUT || path.join(ROOT, 'test-results', 'p19r2e');
const SAMPLE = path.join(ROOT, 'test-results', 'p19r2e-clip', 'index.html');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const SIZES = [[1280, 720], [1400, 900]];
const RAILS = ['hidden', 'icon', 'full'];
const failures = [];
const check = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};

function hit(a, b) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

async function settled(page) { await page.waitForTimeout(700); }

async function sampleChecks(browser) {
  const page = await browser.newPage({viewport: {width: 1440, height: 2400}});
  await page.goto(pathToFileURL(SAMPLE).href); await settled(page);
  const info = await page.evaluate(() => ({
    variants: [...document.querySelectorAll('.variant')].map(section => ({
      id: section.dataset.variant,
      boards: [...section.querySelectorAll('.board')].map(board => Math.round(board.getBoundingClientRect().width)),
      closeups: section.querySelectorAll('.close-up').length,
    })),
    themes: [...document.querySelectorAll('.sample')].map(sample => sample.dataset.theme),
    externalImages: document.images.length,
    externalStyles: [...document.querySelectorAll('link, img')].filter(el => el.href && /^https?:/i.test(el.href)).length,
    svgCount: document.querySelectorAll('svg').length,
    filters: document.querySelectorAll('filter').length,
  }));
  check(info.variants.length === 5 && info.variants.every(item => item.boards.length === 2 && item.boards.every(width => width === 380) && item.closeups === 1),
    'K1–K5 samples each show two 380px open boards and one clip close-up');
  check(info.themes.filter(theme => theme === 'cork').length === 5 && info.themes.filter(theme => theme === 'moon').length === 5,
    'clip samples cover cork and moon for every variant');
  check(info.externalImages === 0 && info.externalStyles === 0 && info.svgCount >= 15 && info.filters === 0,
    'clip samples use only CSS and inline SVG without network images or SVG filters');
  await page.screenshot({path: path.join(path.dirname(SAMPLE), 'overview.png'), fullPage: true});
  for (const section of await page.locator('.variant').all()) {
    const id = await section.getAttribute('data-variant');
    await section.screenshot({path: path.join(path.dirname(SAMPLE), `${id}-cork-moon.png`)});
    await section.locator('.close-up').screenshot({path: path.join(path.dirname(SAMPLE), `${id}-close-up.png`)});
  }
  await page.close();
}

async function productState(page, theme, width, height, rail) {
  await page.setViewportSize({width, height});
  await page.evaluate(({theme, rail}) => {
    setTheme(theme); setRailState(rail, false); showActivity(null); showClipboard(false, false); closePanel();
    closeLayoutMenu();
  }, {theme, rail});
  await settled(page);
}

async function shellChecks(page, theme, width, height, rail) {
  const result = await page.evaluate(() => {
    const visible = selector => {
      const el = document.querySelector(selector); if (!el) return null;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0 ? null : {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      };
    };
    const topbar = visible('#topbar'), viewport = visible('#viewport'), islands = visible('#topbar #canvas-islands');
    const children = ['#wall-tabs', '#wall-search', '#undo', '#redo', '#wall-notice', '#save-state', '#canvas-islands']
      .map(selector => ({selector, rect: visible('#topbar ' + selector)})).filter(item => item.rect);
    const rows = children.map(item => item.rect.top);
    const topbarItems = children.filter(item => item.selector !== '#canvas-islands');
    const allRects = [...topbarItems.map(item => item.rect), ...(islands ? [islands] : [])];
    const pairOverlaps = [];
    for (let i = 0; i < allRects.length; i++) for (let j = i + 1; j < allRects.length; j++) {
      if (allRects[i].left < allRects[j].right - 1 && allRects[j].left < allRects[i].right - 1
        && allRects[i].top < allRects[j].bottom - 1 && allRects[j].top < allRects[i].bottom - 1) {
        pairOverlaps.push([children[i]?.selector, children[j]?.selector]);
      }
    }
    return {
      topbar, viewport, islands,
      islandInTopbar: !!document.querySelector('#canvas-islands')?.closest('#topbar'),
      islandInViewport: !!document.querySelector('#viewport #canvas-islands'),
      rowSpread: rows.length ? Math.max(...rows) - Math.min(...rows) : Infinity,
      insideTopbar: !!topbar && children.every(item => item.rect.left >= topbar.left - 1 && item.rect.right <= topbar.right + 1
        && item.rect.top >= topbar.top - 1 && item.rect.bottom <= topbar.bottom + 1),
      pairOverlaps,
      canvasTop: viewport && islands ? islands.bottom <= viewport.top + 1 : false,
    };
  });
  const label = `${theme}/${width}x${height}/${rail}`;
  check(result.islandInTopbar && !result.islandInViewport,
    `${label}: layout and zoom island moved from canvas into topbar`);
  check(result.islands && result.insideTopbar && result.rowSpread < 12 && result.pairOverlaps.length === 0,
    `${label}: topbar stays one row with no control overlap${result.pairOverlaps.length ? ' (' + JSON.stringify(result.pairOverlaps) + ')' : ''}`);
  check(result.canvasTop,
    `${label}: canvas has no floating island at its top centre`);
}

async function menuChecks(page, theme, width, height, rail) {
  await page.click('#layout-wall-arrow');
  await settled(page);
  const result = await page.evaluate(() => {
    const button = document.querySelector('#layout-wall-arrow')?.getBoundingClientRect();
    const menu = document.querySelector('#layout-wall-menu')?.getBoundingClientRect();
    const viewport = document.querySelector('#viewport')?.getBoundingClientRect();
    const topbar = document.querySelector('#topbar')?.getBoundingClientRect();
    return {
      menuInTopbar: !!document.querySelector('#layout-wall-menu')?.closest('#topbar'),
      belowButton: !!button && !!menu && menu.top >= button.bottom - 1,
      insideViewport: !!viewport && !!menu && menu.left >= viewport.left - 1 && menu.right <= viewport.right + 1
        && menu.top >= viewport.top - 1 && menu.bottom <= viewport.bottom + 1,
      belowTopbar: !!topbar && !!menu && menu.top >= topbar.bottom - 1,
      modes: document.querySelectorAll('#layout-wall-menu [role=menuitem][data-mode]').length,
      expanded: document.querySelector('#layout-wall-arrow')?.getAttribute('aria-expanded'),
    };
  });
  const label = `${theme}/${width}x${height}/${rail}`;
  check(result.menuInTopbar && result.belowButton && result.belowTopbar,
    `${label}: layout menu opens below its topbar button`);
  check(result.insideViewport && result.modes === 3 && result.expanded === 'true',
    `${label}: layout menu stays inside viewport with all three modes`);
  await page.keyboard.press('Escape');
  await settled(page);
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  await fs.promises.access(SAMPLE);
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    await sampleChecks(browser);
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);
    for (const theme of THEMES) for (const [width, height] of SIZES) for (const rail of RAILS) {
      await productState(page, theme, width, height, rail);
      await shellChecks(page, theme, width, height, rail);
      await menuChecks(page, theme, width, height, rail);
    }
    for (const theme of ['cork', 'moon']) for (const [width, height] of SIZES) {
      await productState(page, theme, width, height, 'icon');
      await page.click('#layout-wall-arrow'); await settled(page);
      await page.screenshot({path: path.join(OUT, `topbar-${theme}-${width}x${height}-menu.png`)});
      await page.keyboard.press('Escape');
    }
    await page.close();
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2e topbar checks failed: ' + JSON.stringify(failures.slice(0, 16)));
  console.log('PASS P19-R2e topbar islands, menu placement, clip samples, and screenshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
