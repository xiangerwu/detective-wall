const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready, reload, artifacts} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = artifacts('p19r2k');
const BODY = '第一行正文保持平面寬度。\n第二行正文確認翻角下方沒有文字。\n第三行正文提供足夠的底部內容。';
const failures = [];
const check = (condition, message) => {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
};

function fixture(ids) {
  return {
    bands: [], tags: [],
    cards: [
      {id: ids.flat, kind: 'note', x: 40, y: 70, title: '同一個標題', note: BODY, links: [], color: 'amber', w: 170, h: 170},
      {id: ids.curled, kind: 'note', x: 260, y: 70, title: '同一個標題', note: BODY, links: [], color: 'green', w: 170, h: 170},
      {id: 'p19r2k-index', kind: 'card', x: 480, y: 70, title: '索引卡', note: BODY, links: [], color: 'purple', w: 200, h: 170},
      {id: 'p19r2k-folded', kind: 'note', x: 740, y: 70, title: '折疊便利貼', note: BODY, links: [], color: 'red', w: 170, fold: true},
      {id: 'p19r2k-photo', kind: 'note', x: 980, y: 70, title: '照片卡', note: '', links: [], color: 'cream', image: 'p19r2k-photo'},
    ],
    edges: [],
  };
}

function screenshotFixture(ids) {
  const colours = ['amber', 'green', 'blue', 'red', 'purple', 'cream'];
  const cards = ids.notes.map((id, index) => ({
    id, kind: 'note', x: 40 + (index % 4) * 290, y: 55 + Math.floor(index / 4) * 215,
    title: `調查便條 ${index + 1}`, note: BODY, links: [], color: colours[index % colours.length], w: 220, h: 170,
  }));
  cards.push(...ids.indexCards.map((id, index) => ({
    id, kind: 'card', x: 40 + index * 290, y: 665, title: `索引卡 ${index + 1}`, note: BODY, links: [], color: colours[(index + 2) % colours.length], w: 220, h: 170,
  })));
  return {bands: [], tags: [], cards, edges: []};
}

async function helperInfo(page) {
  return page.evaluate(() => {
    const available = typeof shouldCurlNote === 'function';
    const probability = typeof CURL_PROBABILITY === 'number' ? CURL_PROBABILITY : null;
    if (!available) return {available, probability, count: 0, ids: null, onlyNotes: false};
    const pick = (prefix, wanted, extra = {}) => {
      for (let index = 0; index < 10000; index++) {
        const id = `${prefix}-${index}`;
        if (shouldCurlNote({id, kind: 'note', ...extra}) === wanted) return id;
      }
      return null;
    };
    const generated = Array.from({length: 300}, (_, index) => `p19r2k-sample-${index}`);
    const curled = pick('p19r2k-curled-note', true), flat = pick('p19r2k-flat-note', false);
    return {
      available,
      probability,
      count: generated.filter(id => shouldCurlNote({id, kind: 'note'})).length,
      ids: {curled, flat},
      onlyNotes: curled && !shouldCurlNote({id: curled, kind: 'card'})
        && !shouldCurlNote({id: curled, kind: 'note', fold: true})
        && !shouldCurlNote({id: curled, kind: 'note', image: 'photo'}),
    };
  });
}

async function setFixture(page, value) {
  await page.evaluate(async fixtureValue => {
    data = structuredClone(fixtureValue);
    lastJSON = JSON.stringify(data); past.length = future.length = 0;
    render(); view = {s: 1, x: 0, y: 0}; applyView(); await save(true);
  }, value);
  await page.waitForTimeout(220);
}

async function screenshotIds(page) {
  return page.evaluate(() => {
    const pick = (prefix, kind, wanted) => {
      for (let index = 0; index < 10000; index++) {
        const id = `${prefix}-${index}`;
        if (shouldCurlNote({id, kind}) === wanted) return id;
      }
      throw new Error(`could not find screenshot fixture id for ${prefix}`);
    };
    const notes = Array.from({length: 12}, (_, index) => pick(`p19r2k-shot-note-${index}`, 'note', index % 3 === 0));
    const indexCards = Array.from({length: 4}, (_, index) => pick(`p19r2k-shot-card-${index}`, 'card', false));
    return {notes, indexCards, curled: notes.find(id => shouldCurlNote({id, kind: 'note'}))};
  });
}

async function inspect(page, ids) {
  return page.evaluate(({ids}) => {
    const lines = element => {
      if (!element) return [];
      const range = document.createRange(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), rects = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        range.selectNodeContents(walker.currentNode);
        rects.push(...[...range.getClientRects()].map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom})));
      }
      return rects;
    };
    const card = id => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    const underFlap = (rect, box, width = .22, height = .22) => {
      const left = box.right - box.width * width, top = box.bottom - box.height * height;
      if (rect.bottom <= top || rect.top >= box.bottom || rect.right <= left || rect.left >= box.right) return false;
      const y = Math.max(top, Math.min(box.bottom, (rect.top + rect.bottom) / 2));
      const boundary = left + box.width * width * (1 - (y - top) / (box.height * height));
      return rect.left < boundary - 1 && rect.right > left + 1;
    };
    const read = id => {
      const element = card(id);
      if (!element) return {exists: false, hasCurl: false, titleLines: 0, bodyFirstWidth: 0, noTextUnderFlap: false};
      const box = element.getBoundingClientRect(), title = element.querySelector('h3'), body = element.querySelector('.card-body,.md,p');
      const after = getComputedStyle(element, '::after'), sheet = element.querySelector('.card-sheet'), spacer = element.querySelector('.curl-spacer');
      const titleRects = lines(title), bodyRects = lines(body);
      const flapWidth = Number.parseFloat(after.width) || 0, flapHeight = Number.parseFloat(after.height) || 0;
      const flap = {width: flapWidth, height: flapHeight, clip: after.clipPath, z: Number.parseInt(after.zIndex, 10) || 0};
      return {
        exists: true,
        hasCurl: element.classList.contains('curl'),
        box: {width: box.width, height: box.height, left: box.left, top: box.top, right: box.right, bottom: box.bottom},
        titleLines: titleRects.length,
        bodyFirstWidth: bodyRects[0] ? bodyRects[0].right - bodyRects[0].left : 0,
        noTextUnderFlap: element.classList.contains('curl') && bodyRects.every(rect => !underFlap(rect, box)),
        titleUnderFlap: titleRects.some(rect => underFlap(rect, box)),
        sheetClip: sheet ? getComputedStyle(sheet).clipPath : '',
        flap,
        spacerWidth: spacer?.getBoundingClientRect().width || 0,
        cutVisible: element.classList.contains('curl')
          && !document.elementFromPoint(box.left + box.width * .9, box.top + box.height * .95)?.closest('.card'),
      };
    };
    return {flat: read(ids.flat), curled: read(ids.curled), index: read('p19r2k-index'), folded: read('p19r2k-folded'), photo: read('p19r2k-photo')};
  }, {ids});
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);

    const info = await helperInfo(page);
    check(info.available, 'page exposes the deterministic note curl helper');
    check(info.probability === 1 / 3, `curl probability is one named 1/3 constant (${info.probability})`);
    check(info.count >= 75 && info.count <= 126, `300 note ids produce 25%–42% curls (${info.count}/300)`);
    check(info.onlyNotes, 'only unfilled, unfolded notes can get the curl');

    const ids = info.ids || {curled: 'p19r2k-curled-note-fallback', flat: 'p19r2k-flat-note-fallback'};
    await setFixture(page, fixture(ids));
    let result = await inspect(page, ids);
    check(result.curled.hasCurl && !result.flat.hasCurl, 'curl state follows note id and flat fixture is not curled');
    check(!result.index.hasCurl && !result.folded.hasCurl && !result.photo.hasCurl,
      'index cards, folded notes, and photo cards never get the curl');
    check(result.curled.hasCurl && result.curled.cutVisible, 'wall is visible through the 78% cut');
    check(result.curled.hasCurl && result.curled.sheetClip.includes('78%')
      && Math.abs(result.curled.flap.width / result.curled.box.width - .22) < .03
      && Math.abs(result.curled.flap.height / result.curled.box.height - .22) < .03
      && Math.abs(result.curled.spacerWidth / result.curled.box.width - .22) < .03
      && result.curled.flap.clip.includes('polygon') && result.curled.flap.z > 0,
    `curl geometry is 78% cut / 22% flap and spacer (${JSON.stringify(result.curled)})`);
    check(result.curled.hasCurl && result.curled.noTextUnderFlap && !result.curled.titleUnderFlap,
      '100% zoom keeps all text above the curl flap');
    check(result.curled.hasCurl && !result.curled.titleUnderFlap && result.curled.titleLines === result.flat.titleLines
      && result.curled.bodyFirstWidth >= result.flat.bodyFirstWidth - 2,
    `title and first body line keep flat width (${result.flat.bodyFirstWidth.toFixed(1)}/${result.curled.bodyFirstWidth.toFixed(1)}px)`);

    const beforeReload = {curled: result.curled.hasCurl, flat: result.flat.hasCurl};
    await reload(page);
    result = await inspect(page, ids);
    check(beforeReload.curled && !beforeReload.flat && result.curled.hasCurl && !result.flat.hasCurl,
      'note curl is stable across reload');

    await page.evaluate(() => { view = {s: .5, x: 0, y: 0}; applyView(); render(); });
    await page.waitForTimeout(220);
    result = await inspect(page, ids);
    check(result.curled.hasCurl && result.curled.noTextUnderFlap && !result.curled.titleUnderFlap,
      '50% zoom keeps all text above the curl flap');

    await page.evaluate(() => { view = {s: 1, x: 0, y: 0}; applyView(); render(); });
    await page.waitForTimeout(120);
    await page.evaluate(() => { setTheme('cork'); setCardStyle('paper', false); });
    const shots = await screenshotIds(page);
    await setFixture(page, screenshotFixture(shots));
    const shotCounts = await page.evaluate(() => ({
      notes: [...document.querySelectorAll('.card')].filter(card => card.dataset.id.startsWith('p19r2k-shot-note-')).length,
      indexCards: [...document.querySelectorAll('.card')].filter(card => card.dataset.id.startsWith('p19r2k-shot-card-')).length,
    }));
    check(shotCounts.notes === 12 && shotCounts.indexCards === 4, 'screenshots use about 12 notes and 4 index cards');
    await page.screenshot({path: `${OUT}/wall-cork-100.png`});
    await page.evaluate(() => { setTheme('moon'); });
    await page.screenshot({path: `${OUT}/wall-moon-100.png`});
    await page.evaluate(() => { setTheme('cork'); });
    const curled = page.locator(`.card[data-id="${shots.curled}"]`);
    if (await curled.count()) await curled.screenshot({path: `${OUT}/close-up-curled-note.png`});
    await page.close();
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'P19-R2k checks failed: ' + JSON.stringify(failures));
  console.log('PASS P19-R2k random note curl, removal, geometry, zoom, and screenshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
