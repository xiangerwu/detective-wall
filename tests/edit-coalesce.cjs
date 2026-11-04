// Typing in the card editor updates only that card, and a burst of saves goes out as a few PUTs with the last state.
const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.WALL_TEST_URL); await ready(page);

    // Editing one card leaves every other card's element untouched.
    const [first, second] = await page.evaluate(() => data.cards.slice(0, 2).map(card => card.id));
    await page.evaluate(a => openPanel(a), first);  // opening re-renders all cards once to mark the selection
    await page.waitForSelector('#panel:not([hidden])');
    await page.evaluate(b => { window.otherBefore = cardElements.get(b); }, second);
    await page.fill('#f-title', '只更新這一張');
    const result = await page.evaluate(([a, b]) => ({
      other: cardElements.get(b) === window.otherBefore && window.otherBefore.isConnected,
      title: document.querySelector(`.card[data-id="${a}"] h3`)?.textContent,
    }), [first, second]);
    assert.equal(result.title, '只更新這一張', 'the edited card shows the new title');
    assert.equal(result.other, true, 'the other cards keep their elements');
    console.log('PASS typing in the editor rebuilds only the edited card');

    // Saves a few milliseconds apart, like typing: queued PUTs of the same wall merge, so the wall is never sent
    // more often than it was saved (before, queued states were re-sent: ~39 PUTs for 20 saves), and the last wins.
    await page.evaluate(() => store.flushWrites());
    const sent = await page.evaluate(async () => {
      const titles = [], original = window.fetch;
      window.fetch = (url, options) => {
        if (options?.method === 'PUT' && String(url).includes('/api/walls/')) titles.push(JSON.parse(options.body).data.cards[0].title);
        return original(url, options);
      };
      try {
        for (let i = 1; i <= 20; i++) { data.cards[0].title = `連打 ${i}`; save(); await new Promise(resolve => setTimeout(resolve, 2)); }
        await store.flushWrites();
      } finally { window.fetch = original; }
      return titles;
    });
    const saved = await page.evaluate(async () => (await (await fetch(`/api/walls/${currentWall.id}`)).json()).data.cards[0].title);
    assert.equal(saved, '連打 20', 'the last save wins');
    assert.ok(sent.length <= 20 && new Set(sent).size === sent.length, `each state is sent at most once (${sent.length} PUTs: ${sent.join(', ')})`);
    console.log(`PASS 20 saves while typing went out as ${sent.length} PUT(s), none repeated, last state kept`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
