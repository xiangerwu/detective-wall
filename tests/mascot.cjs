const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, artifacts, openSidebar} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const out = path.join(path.dirname(artifacts('p14c')), 'p14c');
fs.mkdirSync(out, {recursive: true});
const avatarDir = path.join(__dirname, '..', 'assets', 'avatars');
const png = name => {
  const file = fs.readFileSync(path.join(avatarDir, name));
  assert.equal(file.toString('ascii', 1, 4), 'PNG', `${name} is a PNG`);
  return {width: file.readUInt32BE(16), height: file.readUInt32BE(20), bytes: file.length};
};
const ok = (condition, message) => { if (!condition) throw new Error(message); };

for (const client of ['claude', 'codex']) {
  for (const mood of ['idle', 'thinking', 'happy', 'sweat', 'sleep']) {
    const head = png(`${client}-${mood}.png`), body = png(`${client}-body-${mood}.png`);
    assert.deepEqual([head.width, head.height], [512, 512], `${client}-${mood} head is 512x512`);
    assert.equal(body.height, 1024, `${client}-body-${mood} body height is 1024`);
    assert.ok(head.bytes <= 400 * 1024 && body.bytes <= 400 * 1024, `${client}-${mood} images stay under 400KB`);
  }
  const blink = png(`${client}-body-blink.png`);
  assert.equal(blink.height, 1024, `${client} blink height is 1024`);
  assert.ok(blink.bytes <= 400 * 1024, `${client} blink stays under 400KB`);
  for (const [from, to] of [['idle', 'thinking'], ['thinking', 'happy'], ['thinking', 'sweat'], ['idle', 'sleep']]) {
    for (const frame of [1, 2]) {
      const transition = png(`${client}-tr-${from}-${to}-${frame}.png`);
      assert.equal(transition.height, 1024, `${client} ${from}-${to}-${frame} height is 1024`);
      assert.ok(transition.bytes <= 400 * 1024, `${client} ${from}-${to}-${frame} stays under 400KB`);
    }
  }
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await ready(page); await openSidebar(page);
    await page.waitForFunction(() => document.querySelector('#mascot-image')?.complete && document.querySelector('#mascot-image')?.naturalWidth > 0);
    assert.equal(await page.locator('#chat-mascot-panel').count(), 0);

    const rightBottom = await page.evaluate(() => {
      const mascot = $('#mascot').getBoundingClientRect(), view = vp.getBoundingClientRect();
      return {rightGap: view.right - mascot.right, bottomGap: view.bottom - mascot.bottom, viewRight: view.right, mascotRight: mascot.right};
    });
    ok(Math.abs(rightBottom.rightGap - 16) <= 2 && Math.abs(rightBottom.bottomGap - 16) <= 2, 'mascot starts 16px from the canvas bottom-right');
    await page.screenshot({path: path.join(out, 'mascot-right-bottom.png')});

    const start = await page.locator('#mascot-image').boundingBox();
    const target = await page.evaluate(() => { const r = vp.getBoundingClientRect(); return {x: r.left + 40, y: r.top + 40}; });
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x + start.width / 2, target.y + start.height / 2, {steps: 6}); await page.mouse.up();
    const dragged = await page.locator('#mascot').boundingBox();
    ok(Math.abs(dragged.x - target.x) < 4 && Math.abs(dragged.y - target.y) < 4, 'dragging moves mascot to the upper-left of the canvas');
    const savedPosition = await page.evaluate(() => JSON.parse(localStorage.getItem(MASCOT_POS_KEY)));
    ok(Math.abs(savedPosition.x - dragged.x) < 2 && Math.abs(savedPosition.y - dragged.y) < 2, 'dragged mascot position is saved');
    await page.screenshot({path: path.join(out, 'mascot-dragged-left-top.png')});

    await page.reload(); await ready(page); await openSidebar(page);
    const reloaded = await page.locator('#mascot').boundingBox();
    ok(Math.abs(reloaded.x - dragged.x) < 3 && Math.abs(reloaded.y - dragged.y) < 3, 'dragged mascot position survives reload');

    await page.click('#toggle-sidebar');
    const clickBox = await page.locator('#mascot-image').boundingBox();
    await page.mouse.click(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
    await page.waitForFunction(() => document.querySelector('#toggle-sidebar')?.getAttribute('aria-expanded') === 'true'
      && document.activeElement === document.querySelector('#chat-input'));
    console.log('PASS mascot default position, drag persistence, and click-to-open focus');

    const beforeSize = await page.locator('#mascot').boundingBox();
    const resize = await page.locator('#mascot-resize').boundingBox();
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
    await page.mouse.down(); await page.mouse.move(resize.x - 36, resize.y - 36, {steps: 4}); await page.mouse.up();
    const afterSize = await page.locator('#mascot').boundingBox();
    ok(afterSize.height > beforeSize.height && afterSize.height <= 360, 'mascot resize handle changes height within the limit');
    const savedSize = await page.evaluate(() => Number(localStorage.getItem(MASCOT_SIZE_KEY)));
    ok(Math.abs(savedSize - afterSize.height) <= 2, 'mascot size is saved');
    await page.reload(); await ready(page); await openSidebar(page);
    ok(Math.abs((await page.locator('#mascot').boundingBox()).height - afterSize.height) <= 3, 'mascot size survives reload');

    const setState = state => page.evaluate(stateName => {
      chatBusy = stateName === 'thinking';
      $('#chat-progress').hidden = stateName !== 'thinking';
      chatMessages = stateName === 'thinking' ? [{role: 'user', text: 'x'}]
        : stateName === 'happy' ? [{role: 'assistant', text: 'done'}]
        : stateName === 'sweat' ? [{role: 'assistant', error: 'bad'}]
        : [];
      updateChatMascot();
    }, state);
    for (const state of ['thinking', 'happy', 'sweat', 'sleep']) {
      await setState(state);
      await page.waitForFunction(stateName => {
        const image = document.querySelector('#mascot-image');
        return image?.complete && image.naturalWidth > 0 && image.getAttribute('src').endsWith(`/assets/avatars/claude-body-${stateName}.png`);
      }, state);
      await page.waitForFunction(() => {
        const transition = document.querySelector('#mascot-transition');
        return !document.querySelector('#mascot')?.classList.contains('transitioning')
          && getComputedStyle(transition).opacity === '0';
      });
      assert.equal(await page.locator('#mascot-bubble').textContent(), state === 'thinking' ? '思考中…' : state === 'happy' ? '完成了' : state === 'sweat' ? '出錯了…' : 'zzz');
      await page.screenshot({path: path.join(out, `mascot-${state}.png`)});
    }
    await page.emulateMedia({reducedMotion: 'reduce'});
    await setState('thinking');
    assert.equal(await page.locator('#mascot-image').evaluate(el => getComputedStyle(el).animationName), 'none');
    console.log('PASS mascot state images, status bubbles, reduced-motion, and generated asset limits');

    await page.click('#zoom-fit');
    await page.evaluate(() => { const r = vp.getBoundingClientRect(); setMascotPosition(r.right - mascot.offsetWidth - 16, r.bottom - mascot.offsetHeight - 16); });
    const cardPoint = await page.evaluate(() => {
      const m = $('#mascot').getBoundingClientRect();
      return [...document.querySelectorAll('.card')].map(card => {
        const r = card.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, bottom: r.bottom};
      }).find(point => point.right < m.left || point.bottom < m.top);
    });
    ok(cardPoint, 'found a card outside the mascot');
    await page.mouse.click(cardPoint.x, cardPoint.y);
    assert.ok(await page.isVisible('#panel'), 'clicking outside the mascot still reaches a card');
    assert.equal(errors.length, 0, 'page errors: ' + errors.join('; '));
    console.log('PASS mascot does not block board cards');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
