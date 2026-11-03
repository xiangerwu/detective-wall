const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'p19r2h');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const STYLES = ['tech', 'paper'];
const KINDS = ['note', 'card'];
const STATES = ['normal', 'folded', 'curled'];
const MOUNTS = ['pin', 'tape'];
const PRESET_COLORS = {note: {normal: 'amber', folded: 'red', curled: 'custom'}, card: {normal: 'green', folded: 'purple', curled: 'red'}};
const CUSTOM_COLOR = '#cfe9f6';
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

function cardId(kind, state, mount, ids = {}) { return ids[`${kind}-${state}-${mount}`] || `p19r2h-${kind}-${state}-${mount}`; }

function matrixCards(ids) {
  const cards = [];
  let index = 0;
  for (const kind of KINDS) for (const state of STATES) for (const mount of MOUNTS) {
    const row = Math.floor(index / 6), column = index % 6;
    const id = cardId(kind, state, mount, ids);
    const color = PRESET_COLORS[kind][state];
    cards.push({
      id, kind, x: 30 + column * 230, y: 40 + row * 220,
      title: `${kind === 'note' ? '疑問便利貼' : '線索卡'} ${state} ${mount}`,
      note: '第一行正文，確認 curl 不會蓋住文字。\n第二行正文，確認固定高度下仍保留可讀區域。\n第三行正文，讓目前的右下角缺陷確實可見。\n第四行正文。\n第五行正文。',
      links: [], level: kind === 'note' ? 'key' : 'source',
      ...(state === 'folded' ? {fold: true} : {}),
      ...(mount === 'tape' ? {mount: 'tape'} : {}),
      color: color === 'custom' ? CUSTOM_COLOR : color,
      w: kind === 'note' ? 170 : 200,
      // Folded cards keep their auto height, the case where the folded flap once covered the title.
      ...(state === 'folded' ? {} : {h: kind === 'note' ? 170 : 120}),
    });
    index++;
  }
  return cards;
}

function screenshotCards(style, ids) {
  return [
    {id: ids.noteNormal, kind: 'note', x: 40, y: 58, title: '疑問便利貼', note: '正文保留在紙面上，固定件只負責把它留在牆上。', links: [], color: 'amber'},
    {id: ids.noteFolded, kind: 'note', x: 280, y: 58, title: '折起的問題', note: '標題留下，內容在折起的下半部後方。', links: [], fold: true, mount: 'tape', color: 'red'},
    {id: ids.noteCurled, kind: 'note', x: 520, y: 58, title: '被掀起的答案', note: '紙背與牆面之間留出一條真正的空隙。', links: [], color: CUSTOM_COLOR},
    {id: ids.cardNormal, kind: 'card', x: 40, y: 360, title: '門禁紀錄 23:14', note: '正文保留在紙面上，固定件只負責把它留在牆上。', links: [], color: 'green'},
    {id: ids.cardFolded, kind: 'card', x: 280, y: 360, title: '收起的線索', note: '標題留下，內容在折起的下半部後方。', links: [], fold: true, mount: 'tape', color: 'purple'},
    {id: ids.cardCurled, kind: 'card', x: 520, y: 360, title: '底緣留下的證物', note: '紙背與牆面之間留出一條真正的空隙。', links: [], color: 'red'},
  ].map((card, index) => ({...card, level: index % 2 ? 'source' : 'key'}));
}

async function inspectMatrix(page, theme, style, ids) {
  await page.evaluate(({theme, style}) => {
    setTheme(theme);
    setCardStyle(style, false);
    selCard = window.__p19r2hNoteCurled;
    data = {bands: [], tags: [], cards: window.__p19r2hCards, edges: []};
    render();
    // Geometry checks should test the card treatment itself, not the existing per-id tilt.
    document.querySelectorAll('.card').forEach(card => card.style.setProperty('--tilt', '0deg'));
  }, {theme, style});
  await page.waitForTimeout(300);
  const result = await page.evaluate(({theme, style}) => {
    const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const visible = el => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const parseColour = value => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const values = match[1].split(',').map(part => Number.parseFloat(part.trim()));
      return values.length >= 3 ? values.slice(0, 3) : null;
    };
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrast = (a, b) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + .05) / (dark + .05);
    };
    const pseudo = (card, name) => {
      const computed = getComputedStyle(card, name);
      const content = computed.content;
      return {content, width: Number.parseFloat(computed.width) || 0, height: Number.parseFloat(computed.height) || 0,
        clipPath: computed.clipPath, zIndex: Number.parseInt(computed.zIndex, 10) || 0, filter: computed.filter};
    };
    const lineRects = element => {
      const range = document.createRange(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), rects = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        range.selectNodeContents(walker.currentNode);
        rects.push(...[...range.getClientRects()]);
      }
      return rects;
    };
    const lineHitsFlap = (rect, box) => {
      const left = box.left + box.width * .78, top = box.top + box.height * .78;
      const width = box.width * .22, height = box.height * .22;
      if (rect.bottom <= top || rect.top >= box.bottom || rect.right <= left || rect.left >= box.right) return false;
      const y = Math.max(top, Math.min(box.bottom, (rect.top + rect.bottom) / 2));
      const boundary = left + width * (1 - (y - top) / height);
      return rect.left < boundary - 1 && rect.right > left + 1;
    };
    const cards = [...document.querySelectorAll('.card')];
    const byId = id => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    const details = cards.map(card => {
      const id = card.dataset.id;
      const state = id.split('-')[2], mount = id.split('-')[3];
      const after = pseudo(card, '::after'), before = pseudo(card, '::before');
      const box = card.getBoundingClientRect();
      const surface = card.querySelector('.card-sheet,.folded-title-zone');
      const curlPseudo = after.content !== 'none' && after.clipPath !== 'none';
      const curlExists = curlPseudo && after.width > 1 && after.height > 1;
      const corner = {left: box.right - after.width, top: box.bottom - after.height, right: box.right, bottom: box.bottom};
      const text = [...card.querySelectorAll('h3,.md,.md *,p,.tags,.links,.anchor-badge')]
        .filter(node => node.textContent.trim() && visible(node));
      const textOverlaps = state === 'curled' && curlPseudo
        ? text.filter(node => lineRects(node).some(line => lineHitsFlap(line, box)))
          .map(node => `${node.tagName.toLowerCase()}.${String(node.className || '').replace(/\s+/g, '.')}\u003a${node.textContent.trim().slice(0, 32)}`) : [];
      const body = card.querySelector('.md,p');
      const background = parseColour(getComputedStyle(surface || card).backgroundColor)
        || parseColour(getComputedStyle(card).getPropertyValue('--c-bg'))
        || parseColour(getComputedStyle(card).getPropertyValue('--paper-bg'));
      const title = card.querySelector('h3');
      const titleColour = parseColour(getComputedStyle(title).color);
      const bodyColour = body ? parseColour(getComputedStyle(body).color) : titleColour;
      const anchor = card.querySelector('.anchor-badge');
      const fold = card.querySelector('.fold');
      const tapeBox = mount === 'tape' ? {
        left: box.left + (box.width - before.width) / 2, right: box.left + (box.width + before.width) / 2,
        top: box.top - 8, bottom: box.top - 8 + before.height,
      } : null;
      const pseudoCount = ['::before', '::after'].filter(name => pseudo(card, name).content !== 'none').length;
      return {
        id, state, mount, curlExists, curlClip: after.clipPath, curlWidth: after.width, curlHeight: after.height,
        textOverlaps, noTitleBar: getComputedStyle(card).backgroundImage === 'none'
          && (!surface || getComputedStyle(surface).backgroundImage === 'none'),
        bodyHidden: !body || !visible(body), titleVisible: visible(title),
        flapTop: state === 'folded' ? card.querySelector('.folded-flap')?.getBoundingClientRect().top || 0
          : box.bottom - parseFloat(getComputedStyle(card, '::after').bottom) - after.height - box.width * Math.tan(3 * Math.PI / 180) / 2,
        titleBottom: title.getBoundingClientRect().bottom,
        anchorCoveredByCurl: Boolean(anchor && curlPseudo && hit(anchor.getBoundingClientRect(), corner)),
        foldCoveredByCurl: Boolean(fold && curlPseudo && hit(fold.getBoundingClientRect(), corner)),
        anchorCoveredByTape: Boolean(anchor && tapeBox && hit(anchor.getBoundingClientRect(), tapeBox)),
        foldCoveredByTape: Boolean(fold && tapeBox && hit(fold.getBoundingClientRect(), tapeBox)),
        tapeExists: before.content !== 'none',
        selected: card.classList.contains('sel'),
        shadow: getComputedStyle(card).boxShadow,
        background, titleColour, bodyColour,
        titleContrast: background && titleColour ? contrast(background, titleColour) : 0,
        bodyContrast: background && bodyColour ? contrast(background, bodyColour) : 0,
        pseudoCount, cssFilter: getComputedStyle(card).filter, pseudoFilter: after.filter,
      };
    });
    const selected = byId(window.__p19r2hNoteCurled);
    const unselected = byId(window.__p19r2hNoteNormal);
    return {
      theme, style, cards: details,
      selectedRing: Boolean(selected?.classList.contains('sel') && unselected
        && getComputedStyle(selected).boxShadow !== getComputedStyle(unselected).boxShadow),
      svgFilters: document.querySelectorAll('filter,[filter]').length,
      cssFilters: details.filter(card => card.cssFilter !== 'none' || card.pseudoFilter !== 'none').map(card => card.id),
    };
  }, {theme, style});

  const expected = new Map();
  for (const kind of KINDS) for (const state of STATES) for (const mount of MOUNTS) expected.set(cardId(kind, state, mount, ids), {kind, state, mount});
  check(result.cards.length === expected.size && result.cards.every(card => expected.has(card.id)),
    `${theme}/${style}: renders every kind/state/mount matrix entry`, 'matrix');
  for (const card of result.cards) {
    const wanted = expected.get(card.id);
    const wantsCurl = wanted?.kind === 'note' && wanted.state === 'curled';
    check(wanted && card.curlExists === wantsCurl,
      `${theme}/${style}/${wanted?.kind}/${wanted?.state}/${wanted?.mount}: only an unfilled note gets the deterministic curl`, 'curl corner');
    if (wantsCurl) {
      check(card.textOverlaps.length === 0,
        `${theme}/${style}/${wanted.kind}/${wanted.mount}: curled corner leaves text visible (${card.textOverlaps.join(' | ')})`, 'curl text overlap');
      check(!card.anchorCoveredByCurl && !card.foldCoveredByCurl,
        `${theme}/${style}/${wanted.kind}/${wanted.mount}: anchor badge and fold control clear the curl`, 'curl chrome overlap');
    }
    if (wanted?.state === 'folded') {
      check(card.noTitleBar && card.titleVisible && card.bodyHidden && card.flapTop >= card.titleBottom - 1,
        `${theme}/${style}/${wanted.kind}/${wanted.mount}: folded card has no title bar and hides body, flap below title (flap ${card.flapTop.toFixed(1)}, title ${card.titleBottom.toFixed(1)})`, 'folded content');
    }
    if (wanted?.mount === 'tape') {
      check(card.tapeExists && !card.anchorCoveredByTape && !card.foldCoveredByTape,
        `${theme}/${style}/${wanted.kind}/${wanted.state}: tape mount stays behind anchor and fold control`, 'mount overlap');
    } else {
      check(!card.tapeExists, `${theme}/${style}/${wanted.kind}/${wanted.state}: pin mount has no tape pseudo-element`, 'mount presence');
    }
    check(card.titleContrast >= 4.5 && card.bodyContrast >= 4.5,
      `${theme}/${style}/${wanted?.kind}/${wanted?.state}/${wanted?.mount}: title/body contrast >= 4.5 (${card.titleContrast.toFixed(2)}/${card.bodyContrast.toFixed(2)})`, 'contrast');
    check(card.pseudoCount <= 2, `${theme}/${style}/${wanted?.kind}/${wanted?.state}/${wanted?.mount}: card uses at most two paper-effect pseudo-elements (${card.pseudoCount})`, 'pseudo count');
  }
  check(result.selectedRing, `${theme}/${style}: selected card has a visible ring after transitions`, 'selected ring');
  check(result.svgFilters === 0 && result.cssFilters.length === 0,
    `${theme}/${style}: card treatment has no SVG or CSS filters`, 'filters');
  return result;
}

async function captureWall(page, theme, style, closeUp = false) {
  await page.evaluate(({theme, style}) => {
    setTheme(theme);
    setCardStyle(style, false);
    selCard = window.__p19r2hShotNoteCurled;
    data = {bands: [], tags: [], cards: window.__p19r2hShotCards, edges: []};
    render();
    view = {s: 1, x: 0, y: 0};
    applyView();
  }, {theme, style});
  await page.waitForTimeout(350);
  const file = path.join(OUT, `wall-${theme}-${style}-100.png`);
  await page.locator('#viewport').screenshot({path: file});
  if (closeUp) {
    const clip = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.card')].map(card => card.getBoundingClientRect());
      const box = boxes.reduce((all, next) => all ? {
        left: Math.min(all.left, next.left), top: Math.min(all.top, next.top),
        right: Math.max(all.right, next.right), bottom: Math.max(all.bottom, next.bottom),
      } : {left: next.left, top: next.top, right: next.right, bottom: next.bottom}, null);
      if (!box) return null;
      return {x: Math.max(0, box.left - 28), y: Math.max(0, box.top - 28),
        width: Math.min(innerWidth, box.right - box.left + 56), height: Math.min(innerHeight, box.bottom - box.top + 56)};
    });
    if (clip) await page.screenshot({path: path.join(OUT, `close-up-${theme}-${style}.png`), clip});
  }
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
      const matrix = {};
      for (const kind of ['note', 'card']) for (const state of ['normal', 'folded', 'curled']) for (const mount of ['pin', 'tape']) {
        const wanted = kind === 'note' && state === 'curled';
        matrix[`${kind}-${state}-${mount}`] = find(`p19r2h-${kind}-${state}-${mount}`, kind, wanted, {fold: state === 'folded'});
      }
      const shot = {
        noteNormal: find('shot-note-normal', 'note', false),
        noteFolded: find('shot-note-folded', 'note', false, {fold: true}),
        noteCurled: find('shot-note-curled', 'note', true),
        cardNormal: find('shot-card-normal', 'card', false),
        cardFolded: find('shot-card-folded', 'card', false, {fold: true}),
        cardCurled: find('shot-card-curled', 'card', false),
      };
      return {matrix, shot};
    });
    await page.evaluate(({cards, matrix, shot}) => {
      window.__p19r2hCards = cards;
      window.__p19r2hNoteCurled = matrix['note-curled-pin'];
      window.__p19r2hNoteNormal = matrix['note-normal-pin'];
      window.__p19r2hShotNoteCurled = shot.noteCurled;
    }, {cards: matrixCards(ids.matrix), matrix: ids.matrix, shot: ids.shot});
    for (const theme of THEMES) for (const style of STYLES) await inspectMatrix(page, theme, style, ids.matrix);
    await page.evaluate(({cards}) => { window.__p19r2hShotCards = cards; }, {cards: screenshotCards('tech', ids.shot)});
    for (const theme of ['cork', 'moon']) {
      await captureWall(page, theme, 'tech', theme === 'cork');
      await page.evaluate(({cards}) => { window.__p19r2hShotCards = cards; }, {cards: screenshotCards('paper', ids.shot)});
      await captureWall(page, theme, 'paper', theme === 'moon');
    }
    await page.close();
  } finally {
    await browser.close();
  }
  console.log('P19R2H_FAILURES ' + JSON.stringify(Object.fromEntries(failedByCheck)));
  assert.deepEqual(failures, [], 'P19-R2h checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2h N5 card treatment matrix and screenshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
