const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const SIZES = [[1400, 900], [1280, 720]];
const STATES = ['hidden', 'icon', 'full'];
const CLIPBOARD_STATES = [false, true];

const fixture = {
  bands: [
    {id: 'overlap-base', title: '基底演算法', y: 0},
    {id: 'overlap-applications', title: '應用先例', y: 390},
  ],
  tags: [],
  cards: [
    {id: 'overlap-source', kind: 'card', x: 320, y: 80, title: '源頭卡片', note: '來源', links: [], level: 'source'},
    {id: 'overlap-key', kind: 'card', x: 600, y: 180, title: '重點卡片', note: '重點', links: [], level: 'key'},
    {id: 'overlap-suggestion', kind: 'card', x: 220, y: 450, title: '可能是源頭', note: '候選', links: []},
    {id: 'overlap-target', kind: 'card', x: 760, y: 470, title: '待驗證', note: '目標', links: []},
  ],
  edges: [
    {id: 'overlap-edge-1', from: 'overlap-source', to: 'overlap-key', type: 'builds'},
    {id: 'overlap-edge-2', from: 'overlap-suggestion', to: 'overlap-target', type: 'uses'},
  ],
};

function intersects(a, b) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

function allowedOverlap(a, b, context = {}) {
  const names = new Set([a.name, b.name]);
  if (names.has('mascot') && names.has('mascot-bubble')) return '桌寵泡泡屬於桌寵本體的附屬狀態';
  if (names.has('mascot') && names.has('clipboard')) return '桌寵永遠在案件夾上方，允許它蓋在案件夾上';
  if (names.has('rail') && (names.has('mascot') || names.has('mascot-bubble'))) return '桌寵位置由使用者保留，允許它蓋在 rail 上';
  if (names.has('navigation') && (names.has('mascot') || names.has('mascot-bubble'))) return '桌寵位置由使用者保留，允許它蓋在 navigation 上';
  if (names.has('clipboard') && names.has('clipboard-tabs')) return '分頁收在案件夾板子裡，本來就在板子範圍內';
  if (names.has('clipboard') && names.has('panel')) return '浮動案件夾與編輯器可在右側暫時相交，編輯器保持較高互動層';
  if (names.has('clipboard-tabs') && names.has('panel')) return '案件夾分頁與編輯器可在右側暫時相交，編輯器保持較高互動層';
  if (context.clipboardOpen && names.has('clipboard') && names.has('marquee')) return '開啟案件夾可暫時覆蓋畫布選取框';
  if (names.has('clipboard-tabs') && names.has('marquee')) return '案件夾分頁可暫時覆蓋畫布選取框，分頁仍保持可點擊';
  if (names.has('rail') && names.has('navigation')) return '完整分層／錨點區是左欄 rail 內的內容';
  if (names.has('rail-panel') && names.has('navigation')) return '圖示 rail 的分層／錨點區是 rail flyout 內的內容';
  if ([...names].some(name => name.startsWith('menu:')) && !names.has('rail') && !names.has('rail-panel') && !names.has('case-folder') && !names.has('top-tabs') && !names.has('clipboard-tabs')) {
    return '選單是暫時浮在畫布 chrome 上的互動層';
  }
  if (names.has('panel') && ([...names].some(name => name.startsWith('band-label')) || names.has('marquee') || names.has('mascot'))) {
    return '卡片編輯器可暫時覆蓋畫布內容，但不得覆蓋 shell chrome';
  }
  return null;
}

async function prepare(page, theme, state, scenario, clipboardOpen) {
  await page.evaluate(({theme, state, scenario, clipboardOpen, fixture}) => {
    setTheme(theme);
    setCardStyle('tech');
    showClipboard(clipboardOpen, false);
    closePanel();
    showActivity(null);
    for (const id of ['tabmenu', 'layout-wall-menu', 'search-results', 'card-menu']) document.getElementById(id).hidden = true;
    data = structuredClone(fixture);
    anchorFilter = '';
    anchorNavOpen = true;
    selCard = selEdge = drag = tempLine = null;
    view = {s: 1, x: 0, y: 0};
    setRailState(state, false);
    if (scenario === 'files' && state !== 'hidden') showActivity('files');
    if (scenario === 'navigation' && state === 'icon') showActivity('navigation');
    render();
    applyView();
    const showEditor = scenario === 'files' || scenario === 'navigation';
    const showBubble = scenario === 'base' || scenario === 'menus';
    showMascotBubble(showBubble ? '完成了' : '');
    const marquee = document.getElementById('marquee');
    marquee.hidden = false;
    marquee.style.left = '42%'; marquee.style.top = '24%'; marquee.style.width = '96px'; marquee.style.height = '72px';
    const viewport = document.getElementById('viewport').getBoundingClientRect();
    if (showEditor) {
      openPanel('overlap-source');
      panel.style.left = Math.max(viewport.left + 8, viewport.right - panel.offsetWidth - 8) + 'px';
      panel.style.top = viewport.top + 8 + 'px';
    }
    const pick = document.getElementById('pick-toolbar');
    const viewportBox = document.getElementById('viewport').getBoundingClientRect();
    pick.hidden = scenario !== 'menus'; pick.style.left = (viewportBox.left + 300) + 'px'; pick.style.top = Math.round(viewportBox.height * .7) + 'px';
    const mascotBox = document.getElementById('mascot').getBoundingClientRect();
    setMascotPosition(viewport.left + 16, viewport.bottom - mascotBox.height - 16);
    if (scenario === 'menus') {
      const menu = document.getElementById('tabmenu');
      menu.hidden = false; menu.style.left = '300px'; menu.style.top = '48px';
    }
  }, {theme, state, scenario, clipboardOpen, fixture});
  await page.waitForTimeout(300);
}

async function collect(page) {
  return page.evaluate(() => {
    const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const intersects = overlaps;
    const visible = el => {
      if (!el) return false;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0 && !el.closest('[hidden], [inert]');
    };
    const rows = [];
    const add = (name, selector) => {
      const el = document.querySelector(selector);
      if (visible(el)) {
        const rect = el.getBoundingClientRect();
        rows.push({name, selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom});
      }
    };
    add('rail', '#rail');
    add('rail-panel', '#rail-panel');
    add('top-tabs', '#wall-tabs');
    add('clipboard', '#sidebar');
    add('clipboard-tabs', '#case-folder-tabs');
    add('topbar-islands', '#topbar #canvas-islands');
    for (const [name, selector] of [
      ['top-search', '#topbar #wall-search'],
      ['top-undo', '#topbar #undo'],
      ['top-redo', '#topbar #redo'],
      ['top-save', '#topbar #save-state'],
    ]) add(name, selector);
    add('navigation', '#rail-navigation');
    add('navigation-overlay', '#band-nav');
    for (const [index, el] of [...document.querySelectorAll('.band-label')].entries()) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      rows.push({name: `band-label:${index}`, selector: '.band-label', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom});
    }
    add('mascot', '#mascot');
    add('mascot-bubble', '#mascot-bubble');
    add('marquee', '#marquee');
    add('pick-toolbar', '#pick-toolbar');
    add('panel', '#panel');
    for (const id of ['tabmenu', 'layout-wall-menu', 'search-results', 'card-menu', 'edgepop', 'bandpop', 'tagpop', 'f-tag-list']) add(`menu:${id}`, `#${id}`);
    const tabProblems = [];
    const tabs = [...document.querySelectorAll('.case-folder-tab')].filter(visible);
    const tabBlockers = ['#case-folder-header', '#clipboard-close', '.clipboard-clip', '#rail', '#rail-panel', '#topbar', '#tabmenu', '#layout-wall-menu', '#search-results', '#card-menu', '#edgepop', '#bandpop', '#tagpop', '#f-tag-list'];
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) tabProblems.push(`${tab.textContent.trim()} escapes viewport`);
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const panel = document.querySelector('#panel');
      const panelOwnsCentre = visible(panel) && intersects(rect, panel.getBoundingClientRect());
      if ((!target || !tab.contains(target)) && !panelOwnsCentre) tabProblems.push(`${tab.textContent.trim()} centre is covered`);
      for (const selector of tabBlockers) {
        const blocker = document.querySelector(selector);
        if (visible(blocker) && intersects(rect, blocker.getBoundingClientRect())) tabProblems.push(`${tab.textContent.trim()} intersects ${selector}`);
      }
    }
    const topbar = document.querySelector('#topbar')?.getBoundingClientRect();
    const topbarItems = rows.filter(row => row.name === 'top-tabs' || row.name.startsWith('top-'));
    const topbarProblems = [];
    if (!rows.some(row => row.name === 'topbar-islands')) topbarProblems.push('layout/zoom islands are not inside #topbar');
    if (topbar && topbarItems.some(row => row.left < topbar.left - 1 || row.right > topbar.right + 1 || row.top < topbar.top - 1 || row.bottom > topbar.bottom + 1)) {
      topbarProblems.push('topbar item escapes the topbar');
    }
    if (topbarItems.length && Math.max(...topbarItems.map(row => row.top)) - Math.min(...topbarItems.map(row => row.top)) >= 12) {
      topbarProblems.push('topbar items wrap onto more than one row');
    }
    for (let i = 0; i < topbarItems.length; i++) for (let j = i + 1; j < topbarItems.length; j++) {
      if (overlaps(topbarItems[i], topbarItems[j])) topbarProblems.push(`${topbarItems[i].name}/${topbarItems[j].name} overlap`);
    }
    return {rows, topbarProblems, tabProblems};
  });
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  const failures = [];
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);
    for (const theme of THEMES) for (const [width, height] of SIZES) for (const clipboardOpen of CLIPBOARD_STATES) {
      await page.setViewportSize({width, height});
      for (const state of STATES) for (const scenario of ['base', 'files', 'navigation', 'menus']) {
        if (scenario === 'files' && state === 'hidden') continue;
        if (scenario === 'navigation' && state !== 'icon') continue;
        await prepare(page, theme, state, scenario, clipboardOpen);
        const result = await collect(page);
        for (const problem of result.topbarProblems) failures.push({theme, width, height, state, scenario, problem});
        for (const problem of result.tabProblems) failures.push({theme, width, height, state, scenario, problem});
        const rows = result.rows;
        if (state === 'full' && scenario === 'base' && !rows.some(row => row.name === 'navigation')) {
          failures.push({theme, width, height, state, scenario, problem: 'full rail has no visible 分層／錨點 section'});
        }
        if (state === 'icon' && scenario === 'navigation' && !rows.some(row => row.name === 'navigation' && row.selector === '#rail-navigation')) {
          failures.push({theme, width, height, state, scenario, problem: 'icon rail navigation flyout is not visible'});
        }
        if (state === 'hidden' && rows.some(row => row.name === 'navigation' || row.name === 'navigation-overlay')) {
          failures.push({theme, width, height, state, scenario, problem: 'hidden rail still exposes canvas navigation'});
        }
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
          if (!intersects(rows[i], rows[j])) continue;
          const reason = allowedOverlap(rows[i], rows[j], {clipboardOpen, state, scenario});
          if (!reason) failures.push({theme, width, height, state, scenario, pair: [rows[i].name, rows[j].name]});
        }
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19 shell overlaps or missing navigation: ' + JSON.stringify(failures.slice(0, 12)));
  console.log('PASS P19 shell chrome has no unexpected intersections in six themes, three rail states, and two sizes');
})().catch(error => { console.error(error); process.exitCode = 1; });
