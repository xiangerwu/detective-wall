const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'p19r2d');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const SIZES = [[1400, 900], [1280, 720]];
const RAILS = ['hidden', 'icon', 'full'];
const failures = [];
const check = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};

const fixture = {
  bands: [], tags: [],
  cards: [
    {id: 'r2d-source', kind: 'card', x: 180, y: 150, title: '來源卡片', note: 'popup fixture', links: []},
    {id: 'r2d-target', kind: 'card', x: 720, y: 360, title: '目標卡片', note: '', links: []},
    {id: 'r2d-colour', kind: 'card', x: 420, y: 180, title: '自訂色卡', note: '顏色列 fixture', links: []},
  ],
  edges: [{id: 'r2d-edge', from: 'r2d-source', to: 'r2d-target', type: 'builds', label: '待確認'}],
};

async function waitPaint(page) { await page.waitForTimeout(700); }

async function setFixture(page) {
  await page.evaluate(async value => {
    data = structuredClone(value); lastJSON = JSON.stringify(data); past.length = future.length = 0;
    activeTags.clear(); anchorFilter = ''; clearPicked(); closePanel(); selectEdge(null);
    showActivity(null); render(); fitView(true); await save(true);
  }, fixture);
  await waitPaint(page);
}

async function setClipboard(page, open) {
  await page.evaluate(value => showClipboard(value, false), open);
  await waitPaint(page);
}

async function setCustomColour(page, value) {
  await page.evaluate(color => {
    const input = document.querySelector('#f-custom-color');
    if (!input) return;
    input.value = color;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
  await waitPaint(page);
}

function hit(a, b) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {

    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page); await setFixture(page);

    const shellWidths = {};
    for (const [width, height] of SIZES) {
      await page.setViewportSize({width, height});
      for (const theme of THEMES) for (const rail of RAILS) for (const open of [false, true]) {
        await page.evaluate(({theme, rail}) => {
          setTheme(theme); setCardStyle('tech'); setRailState(rail, false); showActivity(null); closePanel();
          showMascotBubble('');
        }, {theme, rail});
        await setClipboard(page, open);
        const result = await page.evaluate(() => {
          const visible = selector => {
            const el = document.querySelector(selector); if (!el) return null;
            const style = getComputedStyle(el), r = el.getBoundingClientRect();
            return style.display === 'none' || style.visibility === 'hidden' || r.width <= 0 || r.height <= 0 ? null : {
              left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
            };
          };
          const shell = [
            ['rail', '#rail'], ['rail-panel', '#rail-panel'], ['rail-resize', '#rail-resize'],
            ['wall-tabs', '#wall-tabs'], ['islands', '#topbar #canvas-islands'], ['clipboard', '#sidebar'],
          ].map(([name, selector]) => ({name, rect: visible(selector)})).filter(row => row.rect);
          const vpRect = visible('#viewport');
          const board = document.querySelector('#sidebar');
          return {
            shell, viewport: vpRect, boardClass: board?.classList.contains('clipboard-window'),
            expanded: board?.getAttribute('aria-expanded'),
            bodyOpen: document.body.classList.contains('clipboard-open'),
          };
        });
        check(result.boardClass && result.expanded === String(open) && result.bodyOpen === open,
          `${theme}/${width}x${height}/${rail}/${open ? 'open' : 'docked'}: clipboard state is floating and explicit`);
        const board = result.shell.find(row => row.name === 'clipboard')?.rect;
        const vp = result.viewport;
        const boardInViewport = open
          ? !!board && board.left >= -2 && board.right <= width + 2 && board.bottom <= height + 2 && board.top >= 48
          : !!board && board.left < width && board.right > width - 54 && board.bottom <= height + 2 && board.top >= 48;
        check(boardInViewport,
          `${theme}/${width}x${height}/${rail}/${open ? 'open' : 'docked'}: board or its peek stays in the viewport`);
        const overlaps = [];
        for (let i = 0; i < result.shell.length; i++) for (let j = i + 1; j < result.shell.length; j++) {
          const a = result.shell[i], b = result.shell[j];
          if (a.name === 'clipboard' || b.name === 'clipboard') {
            const other = a.name === 'clipboard' ? b.name : a;
            if (other.name === 'rail' || other.name === 'rail-panel' || other.name === 'rail-resize' || other.name === 'wall-tabs' || other.name === 'islands') {
              if (hit(a.rect, b.rect)) overlaps.push(`${a.name}/${b.name}`);
            }
          }
        }
        check(overlaps.length === 0, `${theme}/${width}x${height}/${rail}/${open ? 'open' : 'docked'}: clipboard avoids rail, wall tabs and islands${overlaps.length ? ' (' + overlaps.join(', ') + ')' : ''}`);
        if (theme === 'cork' && rail === 'icon') {
          shellWidths[open ? 'open' : 'docked'] = vp?.width;
          await page.screenshot({path: path.join(OUT, `clipboard-${open ? 'open' : 'docked'}-cork-${width}x${height}.png`)});
        }
        if (theme === 'moon' && rail === 'icon') {
          await page.screenshot({path: path.join(OUT, `clipboard-${open ? 'open' : 'docked'}-moon-${width}x${height}.png`)});
        }
      }
    }
    check(Number.isFinite(shellWidths.open) && Math.abs(shellWidths.open - shellWidths.docked) <= 1,
      'docked and open clipboard leave the wall at the same full width');

    await page.setViewportSize({width: 1400, height: 900});
    await page.evaluate(() => { setTheme('cork'); setRailState('icon', false); showActivity(null); });
    await setClipboard(page, false);
    const peek = page.locator('#clipboard-peek');
    check(await peek.count() === 1 && await peek.getAttribute('aria-label') === '開啟 AI 案件夾', 'docked clipboard exposes a focusable peek');
    const beforeOpenMascot = await page.evaluate(() => ({
      mascot: document.querySelector('#mascot')?.getBoundingClientRect(),
      board: document.querySelector('#sidebar')?.getBoundingClientRect(),
    }));
    if (await peek.count()) {
      await peek.focus(); await page.keyboard.press('Enter'); await waitPaint(page);
      const openedFocus = await page.evaluate(() => ({
        open: document.querySelector('#sidebar')?.getAttribute('aria-expanded') === 'true',
        inside: document.querySelector('#sidebar')?.contains(document.activeElement),
      }));
      check(openedFocus.open && openedFocus.inside, 'Enter on the peek opens the board and moves focus inside it');
      const afterOpenMascot = await page.evaluate(() => ({
        mascot: document.querySelector('#mascot')?.getBoundingClientRect(),
        board: document.querySelector('#sidebar')?.getBoundingClientRect(),
      }));
      const mascotMove = afterOpenMascot.mascot.left - beforeOpenMascot.mascot.left;
      const boardMove = afterOpenMascot.board.left - beforeOpenMascot.board.left;
      check(Math.abs(mascotMove - boardMove) <= 2
        && Math.abs(afterOpenMascot.mascot.bottom - beforeOpenMascot.mascot.bottom) <= 2,
        'opening the board moves the mascot with the board and keeps its feet aligned');
      await page.mouse.click(420, 470); await waitPaint(page);
      check(await page.getAttribute('#sidebar', 'aria-expanded') === 'false' && await page.evaluate(() => document.activeElement?.id === 'clipboard-peek'),
        'clicking outside docks the board and returns focus to the peek');
      await page.keyboard.press('Alt+Shift+A'); await waitPaint(page);
      check(await page.getAttribute('#sidebar', 'aria-expanded') === 'true' && await page.locator('#sidebar').evaluate(el => el.contains(document.activeElement)),
        'Alt+Shift+A opens the board and focuses its active sheet');
      await page.click('#clipboard-close'); await waitPaint(page);
      check(await page.getAttribute('#sidebar', 'aria-expanded') === 'false', 'the close control docks the board');
      await page.keyboard.press('Alt+Shift+A'); await waitPaint(page);
      await reload(page);
      check(await page.getAttribute('#sidebar', 'aria-expanded') === 'true', 'open clipboard state survives reload');
      await page.keyboard.press('Escape'); await waitPaint(page);
      await reload(page);
      check(await page.getAttribute('#sidebar', 'aria-expanded') === 'false', 'docked clipboard state survives reload');
    } else {
      for (const message of ['Enter on the peek opens the board and moves focus inside it', 'opening the board moves the mascot with the board and keeps its feet aligned', 'clicking outside docks the board and returns focus to the peek', 'Alt+Shift+A opens the board and focuses its active sheet', 'the close control docks the board', 'open clipboard state survives reload', 'docked clipboard state survives reload']) check(false, message);
    }

    await setClipboard(page, true);
    const clip = await page.evaluate(() => {
      const board = document.querySelector('#case-folder')?.getBoundingClientRect();
      const metal = document.querySelector('#case-folder .clipboard-clip')?.getBoundingClientRect();
      return {delta: board && metal ? Math.abs((metal.left + metal.width / 2) - (board.left + board.width / 2)) : Infinity};
    });
    check(clip.delta <= 4 && await page.locator('#sidebar').evaluate(el => el.classList.contains('clipboard-window')),
      `metal clip is centred on the floating board (delta ${Number.isFinite(clip.delta) ? clip.delta.toFixed(1) : 'missing'}px)`);

    await page.evaluate(() => { view = {s: 1, x: 0, y: 0}; applyView(); selectEdge('r2d-edge', {x: 1200, y: 1000}); });
    await waitPaint(page);
    const popup = await page.evaluate(() => {
      const root = document.querySelector('#edgepop'), viewport = document.querySelector('#viewport')?.getBoundingClientRect();
      const groups = [...document.querySelectorAll('#edgepop .edge-group')].map(group => {
        const buttons = [...group.querySelectorAll('button')].map(button => button.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        return {gap: parseFloat(getComputedStyle(group).columnGap || getComputedStyle(group).gap) || 0, buttons};
      });
      const groupRects = [...document.querySelectorAll('#edgepop .edge-group')].map(group => group.getBoundingClientRect());
      const buttonGaps = groups.flatMap(group => group.buttons.slice(1).map((rect, index) => rect.left - group.buttons[index].right));
      const groupGaps = groupRects.slice(1).map((rect, index) => rect.top - groupRects[index].bottom);
      const box = root?.getBoundingClientRect();
      return {title: !!root?.querySelector('.edge-popup-title'), close: !!root?.querySelector('.edge-close'), groups: groups.length,
        buttonGap: buttonGaps.length ? Math.min(...buttonGaps) : 0, groupGap: groupGaps.length ? Math.min(...groupGaps) : 0,
        inside: !!box && !!viewport && box.left >= viewport.left - 1 && box.top >= viewport.top - 1 && box.right <= viewport.right + 1 && box.bottom <= viewport.bottom + 1};
    });
    check(popup.title && popup.close && popup.groups >= 3, 'edge popup has a title, close control, and separated groups');
    check(popup.buttonGap >= 6 && popup.groupGap >= 10, `edge popup button gaps are >=6px and group gaps are larger (buttons ${popup.buttonGap.toFixed(1)}px, groups ${popup.groupGap.toFixed(1)}px)`);
    check(popup.inside, 'edge popup stays inside the viewport near the selected string');
    const typeButtons = await page.evaluate(() => [...document.querySelectorAll('#edgepop [data-type]')].map(button => ({
      label: button.textContent.trim(), expected: TYPES[button.dataset.type].label,
      iconBg: getComputedStyle(button.querySelector('svg')).backgroundColor, top: Math.round(button.getBoundingClientRect().top)})));
    check(typeButtons.length === 3 && typeButtons.every(b => b.label === b.expected && b.iconBg === 'rgba(0, 0, 0, 0)') && new Set(typeButtons.map(b => b.top)).size === 1,
      `edge type buttons show their names on one row, without a dark icon box (${JSON.stringify(typeButtons)})`);
    await page.locator('#edgepop').screenshot({path: path.join(OUT, 'edge-popup.png')});

    await page.evaluate(() => { selectEdge(null); openPanel('r2d-colour'); });
    await waitPaint(page);
    const colors = ['#fffbe6', '#121212', '#abcdef'];
    for (const color of colors) await setCustomColour(page, color);
    const colourRow = await page.evaluate(() => {
      const row = document.querySelector('#f-color'), custom = row?.querySelector('button[data-color="custom"]');
      const swatches = row ? [...row.querySelectorAll('button.swatch')] : [];
      return {count: swatches.length, expected: Object.keys(COLORS).length + 1, history: row?.querySelectorAll('[data-history-color]').length || 0,
        customOn: custom?.classList.contains('on'), customBg: custom ? getComputedStyle(custom).backgroundImage + getComputedStyle(custom).backgroundColor : ''};
    });
    check(colourRow.count === colourRow.expected && colourRow.history === 0,
      `colour row stays at presets + one 自訂 swatch (${colourRow.count}/${colourRow.expected})`);
    check(colourRow.customOn && !colourRow.customBg.includes('conic-gradient'), 'the single 自訂 swatch shows the card colour with a selection ring');
    await page.locator('#f-color').screenshot({path: path.join(OUT, 'colour-row-custom.png')});
    const presetWheel = await page.evaluate(() => {
      setCardColor(Object.keys(COLORS)[0]);
      return getComputedStyle(document.querySelector('#f-color button[data-color="custom"]')).backgroundImage;
    });
    check(presetWheel.includes('conic-gradient'), 'with a preset colour the 自訂 swatch is a colour wheel, not a lookalike preset');
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2d checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2d floating clipboard, file tabs, edge popup, and single custom swatch');
})().catch(error => { console.error(error); process.exitCode = 1; });
