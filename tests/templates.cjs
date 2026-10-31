const assert = require('node:assert/strict');
const http = require('node:http');
const playwright = require('playwright-core');
const {openActivity} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const emptyWall = {bands: [], tags: [], cards: [], edges: []};

function request(pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
    const headers = value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)};
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try { body = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, body});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const builtins = [
  {name: '分析程式碼', bands: [], tags: ['入口', '資料流', '依賴', '風險', '待驗證']},
  {name: '規劃論文', bands: [], tags: ['問題', '文獻', '方法', '證據', '貢獻', '待驗證']},
  {name: '整理推理線索', bands: [], tags: ['觀察', '證據', '假設', '矛盾', '問題']},
  {name: '設計遊戲支線', bands: [], tags: ['角色', '場景', '任務', '選擇', '後果', '待驗證']},
];

(async () => {
  let response = await request('/api/walls/template-wall', 'PUT', {id: 'template-wall', name: 'Template wall', data: emptyWall, version: null});
  assert.equal(response.status, 200);
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(`${base}/#wall=template-wall`);
    await page.waitForFunction(() => window.wallReady === true);
    await openActivity(page, 'templates');
    await page.waitForSelector('#template-list button');
    assert.equal(await page.locator('#template-list .template-row button').filter({hasText: '刪除'}).count(), 0);
    assert.equal(await page.locator('#template-list .template-row').count(), 4);
    console.log('PASS four fixed templates are present and cannot be deleted');

    const original = await page.evaluate(() => structuredClone(data));
    for (const [index, template] of builtins.entries()) {
      await page.waitForFunction(() => !wallBusy);
      await page.click('.wall-tab[data-id="template-wall"]');
      await page.waitForFunction(() => currentWall.id === 'template-wall' && !wallBusy);
      await page.locator('#template-list .template-row').nth(index)
        .getByRole('button', {name: template.name, exact: true}).click();
      await page.waitForFunction(expected => currentWall.id !== 'template-wall'
        && currentWall.name === expected.name
        && data.bands.map(band => band.title).join('|') === expected.bands.join('|')
        && data.tags.map(tag => tag.name).join('|') === expected.tags.join('|')
        && data.cards.length === 0 && data.edges.length === 0
        && document.querySelector('#chat-input').value.length > 0 && !wallBusy, template);
      const applied = await page.evaluate(() => ({history: past.length, messages: document.querySelectorAll('#chat-messages .chat-message').length,
        prompt: document.querySelector('#chat-input').value, id: currentWall.id, name: currentWall.name}));
      assert.equal(applied.history, 0);
      assert.equal(applied.messages, 0);
      assert.match(applied.prompt, /propose_changes/);
      assert.match(applied.prompt, /中心卡/);
      assert.match(applied.prompt, /3～6/);
      assert.match(applied.prompt, /2～5/);
      assert.match(applied.prompt, /跨主線/);
      assert.match(applied.prompt, /不要設定 band/);
      assert.deepEqual(await page.evaluate(async () => (await store.getWall('template-wall')).data), original);
      if (index === 0) {
        await page.click('.wall-tab[data-id="template-wall"]');
        await page.waitForFunction(() => currentWall.id === 'template-wall' && !wallBusy);
        await page.locator('#template-list .template-row').first()
          .getByRole('button', {name: template.name, exact: true}).click();
        await page.waitForFunction(expected => currentWall.name === expected.name + ' 2' && data.cards.length === 0 && data.edges.length === 0, template);
        assert.equal(await page.evaluate(() => currentWall.name), template.name + ' 2');
      }
    }
    console.log('PASS each built-in creates a separate empty wall, fills the prompt, and does not send');

    await page.locator('#template-list .template-row').first().getByRole('button', {name: '複製'}).click();
    assert.equal(await page.inputValue('#template-name'), '分析程式碼');
    await page.click('#template-cancel');
    await page.click('#template-add');
    await page.fill('#template-name', '我的範本');
    await page.fill('#template-bands', '自訂分層一\n自訂分層二');
    await page.fill('#template-tags', '自訂標籤一\n自訂標籤二');
    await page.fill('#template-prompt', '自訂提示詞，最後使用 propose_changes。');
    await page.click('#template-save');
    await page.waitForFunction(() => document.querySelector('#template-custom-list')?.textContent.includes('我的範本'));
    assert.deepEqual((await request('/api/meta/templates')).body.value.map(template => template.name), ['我的範本']);
    await page.reload();
    await page.waitForFunction(() => window.wallReady === true);
    await openActivity(page, 'templates');
    await page.waitForFunction(() => document.querySelector('#template-custom-list')?.textContent.includes('我的範本'));
    console.log('PASS custom template survives reload');

    let row = page.locator('#template-custom-list .template-row').filter({hasText: '我的範本'});
    await row.getByRole('button', {name: '編輯'}).click();
    await page.fill('#template-name', '修改後範本');
    await page.fill('#template-prompt', '修改後提示詞');
    await page.click('#template-save');
    await page.waitForFunction(() => document.querySelector('#template-custom-list')?.textContent.includes('修改後範本'));
    row = page.locator('#template-custom-list .template-row').filter({hasText: '修改後範本'});
    await row.getByRole('button', {name: '刪除'}).click();
    await row.getByRole('button', {name: '再按一次刪除'}).click();
    await page.waitForFunction(() => !document.querySelector('#template-custom-list')?.textContent.includes('修改後範本'));
    assert.deepEqual((await request('/api/meta/templates')).body.value, []);
    console.log('PASS custom template edits and deletes through persisted meta');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
