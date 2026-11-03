const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

// The floating AI clipboard keeps its tabs readable, attached to the active sheet, and reachable above the docked peek.
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'test-results', 'p19r2g');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const RAILS = ['hidden', 'icon', 'full'];
const SIZES = [[1400, 900], [1280, 720]];
const TAB_NAMES = ['chat', 'proposals', 'audit', 'model'];
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const waitPaint = page => page.waitForTimeout(700);

async function setState(page, theme, rail, open, width, height) {
  await page.setViewportSize({width, height});
  await page.evaluate(({theme, rail, open}) => {
    setTheme(theme);
    setRailState(rail, false);
    showAiTab('chat');
    showClipboard(open, false);
  }, {theme, rail, open});
  await waitPaint(page);
}

(async () => {
  fs.mkdirSync(SCREENSHOTS, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(process.env.WALL_TEST_URL); await ready(page);

    for (const theme of THEMES) for (const rail of RAILS) for (const [width, height] of SIZES) for (const open of [false, true]) {
      await setState(page, theme, rail, open, width, height);
      const problems = await page.evaluate(() => {
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const shown = el => {
          if (!el) return false;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && r.width > 2 && r.height > 2;
        };
        const tabs = [...document.querySelectorAll('.case-folder-tab')].filter(shown);
        const board = document.querySelector('#case-folder')?.getBoundingClientRect();
        const sheet = document.querySelector('#case-folder .case-pane:not([hidden])');
        const sheetRect = sheet?.getBoundingClientRect();
        const active = document.querySelector('.case-folder-tab[aria-selected=true]');
        const out = [];
        if (tabs.length !== 4) out.push(`expected four visible tabs, got ${tabs.length}`);
        if (!board || !sheetRect || !active) out.push('clipboard board, active tab, or sheet is missing');
        const rects = tabs.map(tab => ({tab, rect: tab.getBoundingClientRect(), style: getComputedStyle(tab)}));
        rects.forEach(({tab, rect, style}, index) => {
          if (rect.width < 40 || rect.height < 40) out.push(`tab ${tab.textContent.trim()} hit area is ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          if (style.writingMode !== 'horizontal-tb' || /rotate\(/.test(style.transform)) out.push(`tab ${tab.textContent.trim()} label is not horizontal`);
          if (tab.scrollWidth > tab.clientWidth + 1) out.push(`tab ${tab.textContent.trim()} is clipped`);
          if (index && rect.top <= rects[index - 1].rect.top) out.push('tabs are not stacked top to bottom');
          if (board && Math.abs(rect.right - board.left) > 2) out.push(`tab ${tab.textContent.trim()} is not attached to board left edge`);
          if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) out.push(`tab ${tab.textContent.trim()} falls outside the viewport`);
          const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!target || !tab.contains(target)) out.push(`tab ${tab.textContent.trim()} is not hit at its centre`);
        });
        rects.forEach(({rect: a}, i) => rects.slice(i + 1).forEach(({rect: b}) => { if (hit(a, b)) out.push(`tabs overlap at ${i}/${i + 1}`); }));
        if (active && sheetRect) {
          const activeStyle = getComputedStyle(active), sheetStyle = getComputedStyle(sheet);
          const activeRect = active.getBoundingClientRect();
          if (activeStyle.backgroundColor !== sheetStyle.backgroundColor) out.push('active tab and sheet use different paper colours');
          if (activeStyle.borderRightWidth !== '0px' || sheetStyle.borderLeftWidth !== '0px') out.push('a line remains between active tab and sheet');
          if (Math.abs(activeRect.right - sheetRect.left) > 2 || Math.abs(activeRect.top - sheetRect.top) > 2) out.push('active tab does not touch the sheet');
          const inactiveColours = tabs.filter(tab => tab !== active).map(tab => getComputedStyle(tab).backgroundColor);
          if (inactiveColours.some(colour => colour === activeStyle.backgroundColor)) out.push('inactive tab is not a step darker than the active tab');
          for (const el of document.querySelectorAll('#case-folder-header h1, #case-folder-header h2, #case-folder-header p, #case-folder-header span'))
            if (shown(el) && el.textContent.trim() && hit(sheetRect, el.getBoundingClientRect())) out.push(`sheet covers header text 「${el.textContent.trim().slice(0, 12)}」`);
        }
        const clip = document.querySelector('.clipboard-clip');
        if (clip && shown(clip)) {
          const c = clip.getBoundingClientRect();
          const texts = [...document.querySelectorAll('#case-folder-header *, .case-folder-tab')].filter(el => shown(el) && el.textContent.trim() && !el.closest('.clipboard-clip'));
          for (const el of texts) if (hit(c, el.getBoundingClientRect())) out.push(`clip covers 「${el.textContent.trim().slice(0, 12)}」`);
          const art = clip.querySelector('svg.clipboard-clip-art');
          const parts = new Set([...clip.querySelectorAll('[data-part]')].map(el => el.dataset.part));
          if (!art || !parts.has('front-plate') || !parts.has('rolled-hinge') || !parts.has('flat-lever') || parts.size < 4) out.push('clip is not the K2 Penco brass lever structure');
          if (c.width < 180 || c.width > 220 || c.height < 55 || c.height > 95) out.push(`K2 clip size is ${Math.round(c.width)}x${Math.round(c.height)}, expected a wide brass plate`);
          if (clip.querySelector('filter,[filter]')) out.push('clip uses an SVG filter');
        }
        const blockers = ['#case-folder-header', '#clipboard-close', '.clipboard-clip', '.clipboard-peek-clip', '#rail', '#rail-panel', '#topbar', '#tabmenu', '#layout-wall-menu', '#search-results', '#card-menu', '#edgepop', '#bandpop', '#tagpop', '#f-tag-list'];
        for (const {tab, rect} of rects) for (const selector of blockers) {
          const blocker = document.querySelector(selector);
          if (shown(blocker) && hit(rect, blocker.getBoundingClientRect())) out.push(`tab ${tab.textContent.trim()} intersects ${selector}`);
        }
        return out;
      });
      ok(problems.length === 0, `${theme}/${rail}/${width}x${height}/${open ? 'open' : 'docked'}: left vertical tabs are reachable and attached${problems.length ? ' (' + problems.join('; ') + ')' : ''}`);

      if (rail === 'icon' && (theme === 'cork' || theme === 'moon')) {
        await page.screenshot({path: path.join(SCREENSHOTS, `clipboard-${open ? 'open' : 'docked'}-${theme}-${width}x${height}.png`)});
      }
    }

    await setState(page, 'cork', 'icon', true, 1400, 900);
    await page.locator('#case-folder-tabs').screenshot({path: path.join(SCREENSHOTS, 'tabs-close-up.png')});

    for (const name of TAB_NAMES.slice(1)) {
      await setState(page, 'cork', 'icon', false, 1400, 900);
      await page.click(`#ai-tab-${name}`);
      await waitPaint(page);
      const result = await page.evaluate(expected => ({
        open: document.querySelector('#sidebar')?.getAttribute('aria-expanded') === 'true',
        selected: document.querySelector('.case-folder-tab[aria-selected=true]')?.dataset.aiTab,
        paneVisible: !document.querySelector(`[data-ai-pane="${expected}"]`)?.hidden,
      }), name);
      ok(result.open && result.selected === name && result.paneVisible, `docked tab click opens the board on ${name}`);
    }

    await setState(page, 'cork', 'icon', true, 1400, 900);
    await page.focus('#ai-tab-chat');
    for (const [key, expected] of [['ArrowDown', 'proposals'], ['ArrowUp', 'chat'], ['ArrowRight', 'proposals'], ['ArrowLeft', 'chat']]) {
      await page.keyboard.press(key);
      const result = await page.evaluate(() => ({
        selected: document.querySelector('.case-folder-tab[aria-selected=true]')?.dataset.aiTab,
        focused: document.activeElement?.dataset.aiTab,
      }));
      ok(result.selected === expected && result.focused === expected, `${key} moves AI sheet focus and selection to ${expected}`);
    }

    await setState(page, 'cork', 'icon', true, 1400, 900);
    const clipProblems = await page.evaluate(() => {
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const shown = el => {
        if (!el) return false;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 2 && r.height > 2;
      };
      const clip = document.querySelector('.clipboard-clip');
      const out = [];
      if (clip && shown(clip)) {
        const c = clip.getBoundingClientRect();
        const texts = [...document.querySelectorAll('#case-folder-header *, .case-folder-tab')].filter(el => shown(el) && el.textContent.trim() && !el.closest('.clipboard-clip'));
        for (const el of texts) if (hit(c, el.getBoundingClientRect())) out.push(`clip covers 「${el.textContent.trim().slice(0, 12)}」`);
        const art = clip.querySelector('svg.clipboard-clip-art');
        const parts = new Set([...clip.querySelectorAll('[data-part]')].map(el => el.dataset.part));
        if (!art || !parts.has('front-plate') || !parts.has('rolled-hinge') || !parts.has('flat-lever') || parts.size < 4) out.push('clip is not the K2 Penco brass lever structure');
        if (c.width < 180 || c.width > 220 || c.height < 55 || c.height > 95) out.push(`K2 clip size is ${Math.round(c.width)}x${Math.round(c.height)}, expected a wide brass plate`);
        if (clip.querySelector('filter,[filter]')) out.push('clip uses an SVG filter');
      } else out.push('visible K2 clip is missing');
      return out;
    });
    ok(clipProblems.length === 0, `cork 1400x900: K2 clip stays off header and tab text${clipProblems.length ? ' (' + clipProblems.join('; ') + ')' : ''}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
