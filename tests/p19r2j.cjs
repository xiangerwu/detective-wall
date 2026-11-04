const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.join(ROOT, 'test-results', 'p19r2j');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const STYLES = ['paper', 'tech'];
const BODY = '上段正文保持完整寬度。\n第二行正文確認翻角不會蓋住文字。\n第三行正文讓右下角留出真正的翻面空間。\n第四行正文。';
const LONG_TITLE = 'FoldedCardLongTitleThatMustGrowPastTheFrontFlapWithoutOverlap';
const failures = [];
const failedByCheck = new Map();
const check = (condition, message, category) => {
  if (condition) console.log('PASS ' + message);
  else {
    console.log('FAIL ' + message);
    failures.push(message);
    failedByCheck.set(category, (failedByCheck.get(category) || 0) + 1);
  }
};

function cards(ids) {
  return [
    {id: ids.flatNote, kind: 'note', x: 40, y: 55, title: 'HCL Software', note: BODY, links: [], color: 'amber', w: 170, h: 170},
    {id: ids.curledNote, kind: 'note', x: 260, y: 55, title: 'HCL Software', note: BODY, links: [], color: '#9fd3c7', w: 170, h: 170},
    {id: ids.foldedNote, kind: 'note', x: 480, y: 55, title: '折疊便利貼', note: BODY, links: [], color: 'red', w: 170, fold: true},
    {id: ids.flatCard, kind: 'card', x: 40, y: 330, title: '門禁紀錄 23:14', note: BODY, links: [], color: 'green', w: 200, h: 170, mount: 'tape'},
    {id: ids.curledCard, kind: 'card', x: 300, y: 330, title: '底緣留下的證物', note: BODY, links: [], color: 'purple', w: 200, h: 170, mount: 'tape'},
    {id: ids.foldedCard, kind: 'card', x: 560, y: 330, title: LONG_TITLE, note: BODY, links: [], color: 'cream', w: 200, mount: 'tape', fold: true},
    {id: ids.shortFoldedCard, kind: 'card', x: 820, y: 330, title: '短標題', note: BODY, links: [], color: 'green', w: 200, mount: 'tape', fold: true},
  ];
}

async function renderFixture(page, theme, style, ids) {
  await page.evaluate(({theme, style, fixture}) => {
    setTheme(theme);
    setCardStyle(style, false);
    showClipboard(false, false);
    data = {bands: [], tags: [], cards: structuredClone(fixture), edges: []};
    selCard = null;
    render();
    view = {s: 1, x: 0, y: 0};
    applyView();
    document.querySelectorAll('.card').forEach(card => card.style.setProperty('--tilt', '0deg'));
  }, {theme, style, fixture: cards(ids)});
  await page.waitForTimeout(180);
}

async function inspect(page, ids) {
  return page.evaluate(ids => {
    const parse = value => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = value => value.map(channel => channel / 255).map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrast = (a, b) => {
      const [light, dark] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (light + .05) / (dark + .05);
    };
    const lines = element => {
      const range = document.createRange();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const rects = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim()) continue;
        range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom})));
      }
      return rects;
    };
    const pseudo = (card, name) => {
      const style = getComputedStyle(card, name);
      return {content: style.content, width: parseFloat(style.width) || 0, height: parseFloat(style.height) || 0,
        top: parseFloat(style.top) || 0, bottom: parseFloat(style.bottom) || 0, clip: style.clipPath, z: parseInt(style.zIndex, 10) || 0,
        filter: style.filter};
    };
    const cardOf = id => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    const triangleHit = (rect, cardRect) => {
      const left = cardRect.left + cardRect.width * .78;
      const top = cardRect.top + cardRect.height * .78;
      const width = cardRect.width * .22;
      const height = cardRect.height * .22;
      if (rect.bottom <= top || rect.top >= top + height || rect.right <= left || rect.left >= left + width) return false;
      const y = Math.max(top, Math.min(top + height, (rect.top + rect.bottom) / 2));
      const boundary = left + width * (1 - (y - top) / height);
      return rect.left < boundary - 1 && rect.right > left + 1;
    };
    const all = [...document.querySelectorAll('.card[data-id]')];
    const details = all.map(card => {
      const id = card.dataset.id;
      const state = id.includes('flat-') ? 'flat' : id.includes('curled-') ? 'curled' : 'folded';
      const rect = card.getBoundingClientRect();
      const sheet = card.querySelector('.card-sheet,.folded-title-zone');
      const title = card.querySelector('h3');
      const body = card.querySelector('.md,p') || card.querySelector('.card-body');
      const before = pseudo(card, '::before');
      const after = pseudo(card, '::after');
      const titleLines = title ? lines(title) : [];
      const bodyLines = body ? lines(body) : [];
      const pin = card.querySelector('.pin');
      const hasCurl = card.classList.contains('curl');
      const flapTop = hasCurl ? rect.bottom - after.bottom - after.height : 0;
      const cutPoint = {x: rect.left + rect.width * .9, y: rect.top + rect.height * .94};
      const cutHit = document.elementFromPoint(cutPoint.x, cutPoint.y);
      const foldedFlap = card.querySelector('.folded-flap');
      const foldedTitleZone = card.querySelector('.folded-title-zone');
      const pseudoCount = ['::before', '::after'].filter(name => pseudo(card, name).content !== 'none').length;
      const bg = getComputedStyle(sheet || card).backgroundColor;
      const titleColor = title ? getComputedStyle(title).color : '';
      const bodyColor = body ? getComputedStyle(body).color : titleColor;
      const tape = id.includes('-tape');
      const tapeBottom = tape ? rect.top + before.top + before.height + 2 : 0;
      return {
        id, state, rect: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height}, layoutWidth: card.offsetWidth,
        sheet: sheet && {clip: getComputedStyle(sheet).clipPath, radius: getComputedStyle(sheet).borderRadius, border: getComputedStyle(sheet).borderWidth,
          backgroundImage: getComputedStyle(sheet).backgroundImage, background: bg},
        titleLines: titleLines.map(line => ({top: line.top, bottom: line.bottom, left: line.left, right: line.right})),
        bodyLines, titleTop: title?.getBoundingClientRect().top ?? 0, titleBottom: title?.getBoundingClientRect().bottom ?? 0,
        titleContrast: bg && titleColor ? contrast(bg, titleColor) : 0, bodyContrast: bg && bodyColor ? contrast(bg, bodyColor) : 0,
        pinAboveTitle: !!pin && !!title && pin.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1,
        tapeBelowTitle: !tape || !title || tapeBottom <= title.getBoundingClientRect().top + 1,
        shadow: getComputedStyle(card).boxShadow,
        adhesive: !!card.querySelector('.adhesive-highlight') && getComputedStyle(card.querySelector('.adhesive-highlight')).display !== 'none',
        hasCurl,
        noTextUnderFlap: !hasCurl || bodyLines.every(line => !triangleHit(line, rect)),
        noCardAtCut: !hasCurl || !cutHit?.closest('.card'),
        flap: !hasCurl ? null : {content: after.content, width: after.width, height: after.height, clip: after.clip, z: after.z, top: flapTop, filter: after.filter},
        folded: foldedFlap && foldedTitleZone ? {titleBottom: title?.getBoundingClientRect().bottom, flapTop: foldedFlap.getBoundingClientRect().top,
          flapHeight: foldedFlap.getBoundingClientRect().height, cardHeight: rect.height, titleZoneHeight: foldedTitleZone.getBoundingClientRect().height,
          flapVisible: getComputedStyle(foldedFlap).display !== 'none'} : null,
        hasFold: !!card.querySelector('.fold'), hasResize: !!card.querySelector('.resize-handle'),
        backgroundImage: getComputedStyle(card).backgroundImage, pseudoCount, cssFilter: getComputedStyle(card).filter || 'none',
        pseudoFilter: after.filter, tape, cutPoint,
      };
    });
    const flat = cardOf(ids.flatNote), curled = cardOf(ids.curledNote);
    const flatTitleLines = flat ? lines(flat.querySelector('h3')).length : 0;
    const curledTitleLines = curled ? lines(curled.querySelector('h3')).length : 0;
    const longFold = cardOf(ids.foldedCard), shortFold = cardOf(ids.shortFoldedCard);
    // The first body line sits well above the flap, so curling must not narrow it.
    const firstLineWidth = card => { const rects = card ? lines(card.querySelector('.md,p') || card) : []; return rects.length ? rects[0].right - rects[0].left : 0; };
    const flatFirstLine = firstLineWidth(flat), curledFirstLine = firstLineWidth(curled);
    return {details, flatTitleLines, curledTitleLines, flatFirstLine, curledFirstLine, longFoldHeight: longFold?.offsetHeight || 0, shortFoldHeight: shortFold?.offsetHeight || 0,
      svgFilters: document.querySelectorAll('.card filter,[filter]').length};
  }, ids);
}

async function checkFixture(page, theme, style, ids) {
  await renderFixture(page, theme, style, ids);
  const result = await inspect(page, ids);
  const byId = id => result.details.find(card => card.id === id);
  const expected = [ids.flatNote, ids.curledNote, ids.foldedNote, ids.flatCard, ids.curledCard, ids.foldedCard, ids.shortFoldedCard];
  check(result.details.length === 7, `${theme}/${style}: renders sticky/index flat-curled-folded matrix`, 'matrix');
  check(result.flatTitleLines >= 1 && result.curledTitleLines <= result.flatTitleLines,
    `${theme}/${style}: curled title keeps flat width (${result.flatTitleLines}/${result.curledTitleLines} lines)`, 'title width');
  check(result.flatFirstLine > 0 && result.curledFirstLine >= result.flatFirstLine - 2,
    `${theme}/${style}: curled note's first body line keeps flat width (${result.flatFirstLine.toFixed(1)}/${result.curledFirstLine.toFixed(1)}px)`, 'body width');
  check(result.longFoldHeight > result.shortFoldHeight,
    `${theme}/${style}: folded card grows for long title (${result.longFoldHeight}/${result.shortFoldHeight}px)`, 'fold growth');
  check(result.svgFilters === 0, `${theme}/${style}: no SVG filters in card treatment`, 'filters');
  for (const id of expected) {
    const card = byId(id);
    check(!!card, `${theme}/${style}/${id}: card exists`, 'matrix');
    if (!card) continue;
    check(card.layoutWidth === (id.includes('note') ? 170 : 200), `${theme}/${style}/${id}: width stays product size`, 'size');
    check(card.backgroundImage === 'none' && card.sheet?.backgroundImage === 'none', `${theme}/${style}/${id}: no grey title bar or ruled background`, 'no title bar');
    check(card.sheet?.radius === '0px' && card.sheet?.border.includes('1px'), `${theme}/${style}/${id}: square edges use a hairline edge`, 'edge');
    check(card.shadow !== 'none', `${theme}/${style}/${id}: keeps soft card shadow`, 'shadow');
    check(card.titleContrast >= 4.5 && card.bodyContrast >= 4.5,
      `${theme}/${style}/${id}: title/body contrast >= 4.5 (${card.titleContrast.toFixed(2)}/${card.bodyContrast.toFixed(2)})`, 'contrast');
    check(card.pseudoCount <= 2 && card.cssFilter === 'none' && card.pseudoFilter === 'none',
      `${theme}/${style}/${id}: at most two card pseudo-elements and no CSS filter`, 'effects');
    check(card.pinAboveTitle && card.tapeBelowTitle, `${theme}/${style}/${id}: pin/tape never overlaps title`, 'mount');
    if (card.state === 'flat' || card.state === 'curled') check(card.adhesive, `${theme}/${style}/${id}: adhesive highlight band exists`, 'adhesive');
    const wanted = card.state === 'curled' && id.includes('note');
    check(card.hasCurl === wanted, `${theme}/${style}/${id}: only an unfilled note may be curled`, 'curl kind');
    if (wanted) {
      check(card.sheet?.clip.includes('78%') && card.noCardAtCut, `${theme}/${style}/${id}: wall is visible through the 78% curl cut`, 'curl cut');
      check(Math.abs(card.flap.width / card.rect.width - .22) < .03 && Math.abs(card.flap.height / card.rect.height - .22) < .03
        && /polygon\(0(?:px|%) 0(?:px|%), 100% 0(?:px|%), 0(?:px|%) 100%\)/.test(card.flap.clip.replace(/\s+/g, ' '))
        && card.flap.z > 0 && card.flap.filter === 'none',
      `${theme}/${style}/${id}: up-left 22% flap is on top without a filter`, 'curl flap');
      check(card.noTextUnderFlap, `${theme}/${style}/${id}: no text line intersects the curl flap`, 'curl text');
    }
    if (card.state === 'folded') {
      check(card.folded?.flapVisible && card.folded.titleBottom <= card.folded.flapTop + 1
        && card.folded.flapHeight >= 40 && card.folded.flapHeight <= 70 && card.hasFold && card.hasResize,
      `${theme}/${style}/${id}: title stays above a visible fixed-height folded flap with controls (flap ${card.folded?.flapHeight}px)`, 'fold geometry');
    }
  }
  return result;
}

async function captureWall(page, theme, style, ids) {
  await renderFixture(page, theme, style, ids);
  await page.locator('#viewport').screenshot({path: path.join(OUT, `wall-${theme}-${style}-100.png`)});
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);
    const ids = await page.evaluate(() => {
      const find = (prefix, kind, wanted, extra = {}) => {
        for (let index = 0; index < 10000; index++) {
          const id = `${prefix}-${index}`;
          if (shouldCurlNote({id, kind, ...extra}) === wanted) return id;
        }
        throw new Error('could not find deterministic curl fixture id');
      };
      return {
        flatNote: find('flat-note-pin', 'note', false),
        curledNote: find('curled-note-pin', 'note', true),
        foldedNote: find('folded-note-pin', 'note', false, {fold: true}),
        flatCard: find('flat-card-tape', 'card', false),
        curledCard: find('curled-card-tape', 'card', false),
        foldedCard: find('folded-card-tape', 'card', false, {fold: true}),
        shortFoldedCard: find('folded-card-short', 'card', false, {fold: true}),
      };
    });
    for (const theme of THEMES) for (const style of STYLES) await checkFixture(page, theme, style, ids);
    // The curl spacer is measured during render; a zoomed wall must not shift it.
    for (const style of STYLES) {
      await renderFixture(page, 'cork', style, ids);
      await page.evaluate(() => { view = {s: .5, x: 0, y: 0}; applyView(); render(); });
      await page.waitForTimeout(180);
      const zoomed = (await inspect(page, ids)).details.filter(card => card.hasCurl);
      check(zoomed.length > 0 && zoomed.every(card => card.noTextUnderFlap), `cork/${style}: at 50% zoom no text line intersects the curl flap`, 'curl zoom');
    }
    for (const theme of ['cork', 'moon']) for (const style of STYLES) await captureWall(page, theme, style, ids);
    await page.close();
  } finally {
    await browser.close();
  }
  console.log('P19R2J_FAILURES ' + JSON.stringify(Object.fromEntries(failedByCheck)));
  assert.deepEqual(failures, [], 'P19-R2j checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2j V1 card geometry, text flow, mounts, contrast, effects, and screenshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
