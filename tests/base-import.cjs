const { ready, reload, settled: waitSettled, openActivity, artifacts } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
// Keep test artifacts in the authorized task directory; retain them for review.
const OUT = artifacts('base-import');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const b = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
  const seed = await page.evaluate(() => structuredClone(data));

  // file from "AI A": rename mine, add n1 (+ edge to mine), add n2 without position (+ edge to dt), retype dt-q1, one bad edge
  const a = structuredClone(seed);
  a.cards.find(c => c.id === 'mine').title = 'My Paper（A 版）';
  a.cards.push({ id: 'n1', kind: 'card', x: 900, y: 700, title: 'A 的新線索', note: 'A 寫的筆記', links: [] });
  a.cards.push({ id: 'n2', kind: 'note', title: '沒有座標的疑問' });
  a.edges.push({ from: 'n1', to: 'mine', type: 'uses' }, { from: 'n2', to: 'dt', type: 'question' }, { from: 'x', to: 'y', type: 'bogus' });
  a.edges.find(e => e.id === 'e6').type = 'builds';
  const fa = path.join(OUT, 'ai_a.json'); fs.writeFileSync(fa, JSON.stringify(a));

  await page.setInputFiles('#import-file', fa); await page.waitForSelector('#importer[open]');
  ok(await page.isVisible('#importer'), 'preview dialog opens');
  const summary = await page.textContent('#im-summary');
  ok(/新卡片 2｜有變更的卡片 1｜新連線 2｜有變更的連線 1/.test(summary), 'summary counts: ' + summary);
  ok(await page.evaluate(() => data.cards.length) === seed.cards.length, 'nothing changes before confirming');
  ok((await page.textContent('#im-apply')) === '匯入勾選項目（6）', 'apply label counts checked items');

  // cancel leaves the wall alone
  await page.click('#im-cancel');
  ok(!(await page.isVisible('#importer')) && await page.evaluate(() => data.cards.length) === seed.cards.length, 'cancel imports nothing');

  // partial import: uncheck card n2 only
  await page.setInputFiles('#import-file', fa); await page.waitForSelector('#importer[open]');
  const rows = await page.$$eval('#im-list .im-row', rs => rs.map(r => r.textContent));
  const n2 = rows.findIndex(t => t.includes('沒有座標的疑問'));
  await page.locator('#im-list .im-row input').nth(n2).uncheck();
  ok((await page.textContent('#im-apply')) === '匯入勾選項目（5）', 'unchecking updates the count');
  await page.screenshot({ path: path.join(OUT, 'import_preview.png') });
  await page.click('#im-apply'); await waitSettled(page);
  const after = await page.evaluate(() => structuredClone(data));
  ok(after.cards.find(c => c.id === 'mine').title === 'My Paper（A 版）', 'changed card applied');
  ok(after.cards.some(c => c.id === 'n1') && !after.cards.some(c => c.id === 'n2'), 'n1 imported, unchecked n2 not');
  ok(after.edges.some(e => e.from === 'n1' && e.to === 'mine' && e.type === 'uses'), 'new edge imported');
  ok(!after.edges.some(e => e.from === 'n2'), 'edge to unimported card skipped');
  ok(after.edges.find(e => e.id === 'e6').type === 'builds', 'edge type change applied');
  ok(/略過 1 條線/.test(await page.textContent('#import')), 'flash reports skipped edge: ' + await page.textContent('#import'));

  // second AI file: keeps the seed wall plus its own card; A's work must survive a merge
  const bfile = structuredClone(seed);
  bfile.cards.push({ id: 'm1', kind: 'card', x: -300, y: 300, title: 'B 的新線索', note: '', links: [] });
  bfile.cards.find(c => c.id === 'mine').title = 'My Paper';  // B still has the old title
  const fb = path.join(OUT, 'ai_b.json'); fs.writeFileSync(fb, JSON.stringify(bfile));
  await page.setInputFiles('#import-file', fb); await page.waitForSelector('#importer[open]');
  const rows2 = await page.$$eval('#im-list .im-row', rs => rs.map(r => r.textContent));
  ok(rows2.some(t => t.includes('My Paper（A 版）') && t.includes('My Paper')), 'conflicting title shown as old → new');
  const mi = rows2.findIndex(t => t.includes('標題'));
  await page.locator('#im-list .im-row input').nth(mi).uncheck();  // keep A's title
  // leave the reverted e6 type unchecked too, import only B's card
  for (let i = 0; i < rows2.length; i++) if (!rows2[i].includes('B 的新線索')) await page.locator('#im-list .im-row input').nth(i).uncheck();
  await page.click('#im-apply'); await waitSettled(page);
  const merged = await page.evaluate(() => structuredClone(data));
  ok(merged.cards.some(c => c.id === 'm1') && merged.cards.some(c => c.id === 'n1'), 'both AIs\' cards on the wall');
  ok(merged.cards.find(c => c.id === 'mine').title === 'My Paper（A 版）', 'unchecked conflict kept current title');

  // identical file → no items
  const fs3 = path.join(OUT, 'same.json'); fs.writeFileSync(fs3, JSON.stringify(merged));
  await page.setInputFiles('#import-file', fs3); await page.waitForSelector('#importer[open]');
  ok(await page.isDisabled('#im-apply') && /沒有可匯入/.test(await page.textContent('#im-list')), 'identical file: nothing to import');
  await page.click('#im-cancel');

  // replace whole wall (two clicks)
  await page.setInputFiles('#import-file', fb); await page.waitForSelector('#importer[open]');
  await page.click('#im-replace'); await waitSettled(page);
  ok(await page.isVisible('#importer'), 'first click only arms replace');
  await page.click('#im-replace'); await waitSettled(page);
  const rep = await page.evaluate(() => structuredClone(data));
  ok(!rep.cards.some(c => c.id === 'n1') && rep.cards.some(c => c.id === 'm1'), 'replace makes wall equal to file');

  // invalid file
  const fbad = path.join(OUT, 'bad.json'); fs.writeFileSync(fbad, '{"foo":1}');
  await page.setInputFiles('#import-file', fbad); await page.waitForFunction(() => /不是案件圖譜/.test(document.querySelector('#import').textContent));
  ok(!(await page.isVisible('#importer')) && /不是案件圖譜/.test(await page.textContent('#import')), 'invalid JSON rejected');

  ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  await b.close();
})();
