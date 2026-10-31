const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { ready, reload, settled, openActivity, restoreBackup, artifacts, chooseWall } = require('./wall-ready.cjs');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('round-08');
const errors = [], dialogs = [];
const pass = message => console.log('PASS ' + message);
const imageCard = page => page.evaluate(() => data.cards.filter(c => typeof c.image === 'string').at(-1));
const rendered = (page, id) => page.waitForFunction(id => {
  const img = document.querySelector(`.card[data-id="${id}"] img`);
  return img?.complete && img.naturalWidth > 0;
}, id);
const open = async (page, value) => {
  await openActivity(page, 'files');
  await page.setInputFiles('#import-file', {name: 'images.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value))});
  await page.waitForSelector('#importer[open]');
};
const apply = async (page, replace = false) => {
  const button = replace ? '#im-replace' : '#im-apply';
  await page.click(button);
  if (replace) await page.click(button);
  await settled(page);
};
// Real encoded files and browser events exercise the clipboard/drop boundary.
const transfer = async (page, options = {}) => {
  const result = await page.evaluate(async options => {
    const dt = new DataTransfer();
    for (const spec of options.files || [{}]) {
      const {width = 80, height = 40, name = 'evidence.png', type = 'image/png', oversize = false} = spec;
      let blob;
      if (oversize) blob = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], {type});
      else if (!type.startsWith('image/')) blob = new Blob(['plain text'], {type});
      else {
        const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#3ad1ff'; ctx.fillRect(0, 0, width, height);
        blob = await canvas.convertToBlob({type: 'image/png'});
      }
      dt.items.add(new File([blob], name, {type}));
    }
    const before = data.cards.length;
    // Firefox empties clipboardData on synthetic ClipboardEvents and headless Firefox has no system clipboard,
    // so paste is a plain event carrying the DataTransfer (real Ctrl+V was checked by hand in headed Firefox).
    const ev = options.drop
      ? new DragEvent('drop', {dataTransfer: dt, clientX: options.x, clientY: options.y, bubbles: true, cancelable: true})
      : Object.defineProperty(new Event('paste', {bubbles: true, cancelable: true}), 'clipboardData', {value: dt});
    const point = options.drop ? toWall(ev) : visibleCenter();
    (options.drop ? vp : document.activeElement).dispatchEvent(ev);
    return {before, point, prevented: ev.defaultPrevented};
  }, options);
  await settled(page);
  return result;
};

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const newPage = async init => {
      const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
      if (init) await page.addInitScript(init);
      await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
      return page;
    };
    const page = await newPage();
    const pasted = await transfer(page);
    const first = await imageCard(page);
    assert.ok(pasted.prevented);
    assert.equal(first.title, 'evidence');
    assert.deepEqual({x: first.x, y: first.y}, pasted.point);
    assert.equal(first.kind, 'card'); assert.equal(first.note, ''); assert.deepEqual(first.links, []);
    await rendered(page, first.id);
    assert.equal(await page.evaluate(() => data.cards.length), pasted.before + 1);
    const style = await page.locator(`.card[data-id="${first.id}"] img`).evaluate(img => ({
      alt: img.alt, draggable: img.draggable, fit: getComputedStyle(img).objectFit,
      max: getComputedStyle(img).maxHeight, width: img.offsetWidth, content: img.closest('.card').clientWidth - 28,
    }));
    assert.deepEqual(style, {alt: 'evidence', draggable: false, fit: 'contain', max: '220px', width: style.content, content: style.content});
    pass('paste creates a centered image card with the required rendering attributes');

    await page.click('#undo');
    assert.equal(await page.evaluate(id => !!byId(id), first.id), false);
    assert.ok(await page.evaluate(async id => !!(await store.getImage(id)), first.image));
    await page.click('#redo'); await rendered(page, first.id);
    pass('creation is one undo step; redo restores the retained image');

    await transfer(page, {files: [{width: 3000, height: 1000, name: 'wide.png'}]});
    const large = await imageCard(page);
    const dimensions = await page.evaluate(async id => {
      const record = await store.getImage(id), bitmap = await createImageBitmap(record.blob);
      const result = {width: record.width, height: record.height, actual: [bitmap.width, bitmap.height], type: record.type};
      bitmap.close(); return result;
    }, large.image);
    assert.deepEqual(dimensions, {width: 1600, height: 533, actual: [1600, 533], type: 'image/webp'});
    pass('3000 × 1000 image is actually encoded at 1600 × 533');

    await page.evaluate(id => openPanel(id), first.id);
    await page.focus('#f-note');
    const inNote = await transfer(page);
    assert.equal(inNote.prevented, false);
    assert.equal(await page.evaluate(() => data.cards.length), inNote.before);
    await page.click('#f-close');
    pass('pasting into the note textarea does not create a card');

    await page.evaluate(() => { view = {s: 1.5, x: -123, y: 45}; applyView(); });
    const bounds = await page.locator('#viewport').boundingBox();
    const dropped = await transfer(page, {drop: true, x: bounds.x + 330, y: bounds.y + 210});
    const dropCard = await imageCard(page);
    assert.ok(dropped.prevented);
    assert.deepEqual({x: dropCard.x, y: dropCard.y}, dropped.point);
    await rendered(page, dropCard.id);
    assert.deepEqual(await page.evaluate(() => ['image/png', 'text/plain'].map(type => {
      const dt = new DataTransfer(); dt.items.add(new File(['x'], 'test', {type}));
      const ev = new DragEvent('dragover', {dataTransfer: dt, cancelable: true}); vp.dispatchEvent(ev);
      return ev.defaultPrevented;
    })), [true, false]);
    pass('drop uses wall coordinates at a zoomed/panned point; only image dragover is intercepted');

    for (const spec of [{type: 'text/plain', name: 'readme.txt'}, {oversize: true}]) {
      const rejected = await transfer(page, {drop: true, x: 300, y: 300, files: [spec]});
      assert.equal(await page.evaluate(() => data.cards.length), rejected.before);
      assert.equal(rejected.prevented, !!spec.oversize);
      assert.match(await page.textContent('#import'), spec.oversize ? /20 MB/ : /只能加入圖片/);
    }
    pass('non-images and files over 20 MB flash a rejection without alerts');

    const multi = await transfer(page, {files: [{name: ''}, {name: 'second.png'}]});
    const pair = await page.evaluate(() => data.cards.slice(-2));
    assert.equal(pair[0].title, '貼上的圖片');
    assert.deepEqual(pair.map(c => [c.x, c.y]), [[multi.point.x, multi.point.y], [multi.point.x + 24, multi.point.y + 24]]);
    await page.click('#undo'); assert.equal(await page.evaluate(() => data.cards.length), multi.before + 1);
    await page.click('#redo'); await rendered(page, pair[1].id);
    pass('multiple clipboard images offset by 24 px and each gets its own undo step');

    await page.evaluate(() => {
      window.realToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        if (type === 'image/webp') callback(null); else realToBlob.call(this, callback, type, quality);
      };
    });
    await transfer(page, {files: [{name: 'fallback.png'}]});
    const png = await imageCard(page);
    assert.equal(await page.evaluate(async id => (await store.getImage(id)).type, png.image), 'image/png');
    await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = realToBlob; });
    pass('null WebP encoding falls back to PNG');

    await reload(page); await rendered(page, first.id); await rendered(page, large.id);
    const main = await page.evaluate(() => currentWall.id);
    await page.evaluate(() => backupWall('圖片測試'));
    const backup = await page.evaluate(async () => (await store.listBackups(currentWall.id))[0]);
    assert.ok(await page.evaluate(async id => {
      const b = await store.getBackup(id);
      return !Object.hasOwn(b.data, 'images') && b.data.cards.some(c => typeof c.image === 'string');
    }, backup.id));
    await page.evaluate(id => { data.cards = data.cards.filter(c => c.id !== id); render(); return save(true); }, first.id);
    await restoreBackup(page, backup.id); await rendered(page, first.id);
    await page.click('#add-wall'); await settled(page);
    assert.equal(await page.locator('.card img').count(), 0);
    await chooseWall(page, main); await rendered(page, first.id);
    pass('reload, backup restore and wall switching retain images using only image IDs');

    await page.evaluate(async id => {
      const record = await store.getImage(id); await store.putImage({...record, id: 'unreferenced'});
      window.revoked = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
      data.cards.push({...data.cards.find(c => c.image === id), id: 'shared-image'}); render(); await save(true);
    }, first.image);
    await rendered(page, 'shared-image');
    const originalURL = await page.locator(`.card[data-id="${first.id}"] img`).getAttribute('src');
    assert.equal(await page.locator('.card[data-id="shared-image"] img').getAttribute('src'), originalURL);
    await page.evaluate(id => { data.cards = data.cards.filter(c => c.id !== id); render(); return save(true); }, first.id);
    await rendered(page, 'shared-image');
    assert.equal(await page.evaluate(url => revoked.includes(url), originalURL), false);
    await page.evaluate(() => { data.cards = data.cards.filter(c => c.id !== 'shared-image'); render(); return save(true); });
    assert.equal(await page.evaluate(url => revoked.includes(url), originalURL), true);
    await page.click('#undo'); await rendered(page, 'shared-image');
    pass('object URLs are shared per ID and revoked after the last displayed reference disappears');

    const downloadReady = page.waitForEvent('download');
      await openActivity(page, 'files'); await page.click('#export');
    const download = await downloadReady, exportPath = path.join(OUT, 'round-08-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    const ids = [...new Set(exported.cards.map(c => c.image).filter(id => typeof id === 'string'))];
    assert.deepEqual(Object.keys(exported.images).sort(), ids.sort());
    assert.ok(ids.every(id => /^data:image\/(webp|png);base64,/.test(exported.images[id])));
    assert.equal(Object.hasOwn(exported.images, 'unreferenced'), false);
    pass('JSON export embeds only currently referenced images as data URLs');

    // A new browser context shares the project image store with every wall.
    for (const replace of [false, true]) {
      const fresh = await newPage();
      await fresh.click('#add-wall'); await settled(fresh);
      assert.ok(await fresh.evaluate(async id => !!await store.getImage(id), first.image));
      await open(fresh, exported); await apply(fresh, replace);
      await rendered(fresh, 'shared-image'); await rendered(fresh, large.id);
      assert.ok(await fresh.evaluate(async id => {
        const r = await store.getImage(id); return r.blob instanceof Blob && r.width === 1600 && r.height === 533;
      }, large.image));
      assert.equal(await fresh.evaluate(() => Object.hasOwn(data, 'images')), false);
      await reload(fresh); await rendered(fresh, 'shared-image');
      await fresh.context().close();
    }
    pass('selective import and whole replacement both restore image blobs into a fresh wall/database');

    const withoutImage = await page.evaluate(() => {
      const c = {...byId('shared-image')}; delete c.image; return {cards: [c], edges: []};
    });
    await open(page, withoutImage);
    assert.match(await page.textContent('#im-list'), /圖片/);
    await apply(page);
    assert.equal(await page.evaluate(() => Object.hasOwn(byId('shared-image'), 'image')), false);
    await page.click('#undo'); await rendered(page, 'shared-image');
    pass('preview and selective import can remove an image reference; undo restores it');

    const invalid = {cards: [{id: 'missing', title: 'Missing', image: 'evil'}, {id: 'bad-type', image: 123}], edges: [],
      images: {evil: 'data:text/html;base64,PHNjcmlwdD4=', svg: 'data:image/svg+xml;base64,PHN2Zz4=',
        bad: 'data:image/png;base64,???', huge: 'data:image/png;base64,' + 'A'.repeat(15 * 1024 * 1024)}};
    const normalized = await page.evaluate(d => normalize(d), invalid);
    assert.deepEqual(normalized.images, {});
    assert.equal(normalized.cards[1].image, undefined);
    const diff = await page.evaluate(() => cardDiff({title: 'A', image: 'old'}, {title: 'A', image: 'new'}));
    assert.ok(diff.some(([field, from, to]) => field === '圖片' && from === 'old' && to === 'new'));
    await open(page, invalid); await apply(page);
    await page.waitForFunction(() => document.querySelector('.card[data-id="missing"] .image-missing')?.textContent === '圖片遺失');
    assert.equal(await page.evaluate(() => store.getImage('evil')), undefined);
    await page.screenshot({path: path.join(OUT, 'round-08-images.png')});
    pass('normalization drops malicious/oversize data URLs and non-string IDs; missing images show a placeholder; diff shows 圖片');

    const fallback = await newPage(() => { window.fetch = () => Promise.reject(new Error('server unavailable in test')); });
    await transfer(fallback); const memoryCard = await imageCard(fallback); await rendered(fallback, memoryCard.id);
    assert.ok(await fallback.isVisible('#storage-warning'));
    assert.ok(await fallback.evaluate(async id => {
      const r = await store.getImage(id), original = r.width;
      r.id = 'queued'; const write = store.putImage(r); r.width = 999;
      const read = store.getImage('queued'); await write;
      const copy = await read; copy.width = 888;
      return copy.blob instanceof Blob && (await store.getImage('queued')).width === original;
    }, memoryCard.image));
    await fallback.click('#undo'); await fallback.click('#redo'); await rendered(fallback, memoryCard.id);
    await fallback.context().close();
    pass('memory fallback stores blobs, clones records, flushes queued writes and supports undo/redo');

    const upgrade = await newPage();
    assert.ok(await upgrade.evaluate(async () => {
      const root = await (await fetch('/api')).json();
      return currentWall.id === root.id && root.walls.some(wall => wall.id === currentWall.id)
        && !!await store.getImage((await store.getWall(currentWall.id)).data.cards.find(c => c.image)?.image);
    }));
    await transfer(upgrade); await rendered(upgrade, (await imageCard(upgrade)).id);
    await upgrade.context().close();
    pass('new browser context shares the server wall and image store');
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    pass('no page errors or dialogs');
    fs.writeFileSync(path.join(OUT, 'round-08-result.json'), JSON.stringify({passed: true, browser: browser.browserType().name(), errors, dialogs}, null, 2) + '\n');
    console.log('Artifacts retained: ' + OUT);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
