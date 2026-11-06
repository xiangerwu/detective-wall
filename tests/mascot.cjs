const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, artifacts, openSidebar} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const out = path.join(path.dirname(artifacts('p14c')), 'p14c');
fs.mkdirSync(out, {recursive: true});
const avatarDir = path.join(__dirname, '..', 'assets', 'avatars');
const webp = name => {
  const file = fs.readFileSync(path.join(avatarDir, name));
  assert.equal(file.toString('ascii', 0, 4), 'RIFF', `${name} is a WebP`);
  assert.equal(file.toString('ascii', 8, 12), 'WEBP', `${name} is a WebP`);
  return {bytes: file.length};
};
const ok = (condition, message) => { if (!condition) throw new Error(message); };

for (const client of ['claude', 'codex']) {
  for (const mood of ['idle', 'thinking', 'happy', 'sweat', 'sleep']) {
    const head = webp(`${client}-${mood}.webp`);
    assert.ok(head.bytes <= 400 * 1024, `${client}-${mood} images stay under 400KB`);
  }
  for (const [from, to] of [['idle', 'thinking'], ['thinking', 'happy'], ['thinking', 'sweat'], ['idle', 'sleep']]) {
    for (const frame of [1, 2]) {
      const transition = webp(`${client}-tr-${from}-${to}-${frame}.webp`);
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
    await page.goto(base); await ready(page); await openSidebar(page); await page.waitForTimeout(650);
    await page.waitForFunction(() => {
      const rig = document.querySelector('#mascot-image .rig');
      return rig?.dataset.ready === 'true' && [...rig.querySelectorAll(':scope > img')].every(image => image.complete && image.naturalWidth > 0);
    });
    assert.equal(await page.locator('#chat-mascot-panel').count(), 0);

    const rightBottom = await page.evaluate(() => {
      const mascot = $('#mascot').getBoundingClientRect(), board = $('#sidebar').getBoundingClientRect();
      return {rightGap: board.left - mascot.right, bottomGap: board.bottom - mascot.bottom};
    });
    ok(rightBottom.rightGap >= 6 && rightBottom.rightGap <= 12 && Math.abs(rightBottom.bottomGap) <= 2,
      'mascot starts immediately left of the open clipboard with aligned feet');
    await page.screenshot({path: path.join(out, 'mascot-left-of-clipboard.png')});

    const sidebarBefore = await page.locator('#sidebar').boundingBox();
    const sidebarHandle = await page.locator('#sidebar-resize').boundingBox();
    assert.equal(await page.locator('#sidebar-resize').getAttribute('role'), 'separator');
    assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-orientation'), 'vertical');
    await page.mouse.move(sidebarHandle.x + sidebarHandle.width / 2, sidebarHandle.y + sidebarHandle.height / 2);
    await page.mouse.down(); await page.mouse.move(sidebarHandle.x - 100, sidebarHandle.y + sidebarHandle.height / 2, {steps: 5}); await page.mouse.up();
    const sidebarAfter = await page.locator('#sidebar').boundingBox();
    ok(sidebarBefore && sidebarAfter && sidebarAfter.width > sidebarBefore.width, 'dragging the folder handle widens the folder');
    const savedSidebarWidth = await page.evaluate(() => Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)));
    ok(Math.abs(savedSidebarWidth - sidebarAfter.width) <= 2, 'folder width is saved');
    const sidebarMascotAfterResize = await page.evaluate(() => {
      const mascot = $('#mascot').getBoundingClientRect(), board = $('#sidebar').getBoundingClientRect();
      return {rightGap: board.left - mascot.right, bottomGap: board.bottom - mascot.bottom};
    });
    ok(sidebarMascotAfterResize.rightGap >= 6 && sidebarMascotAfterResize.rightGap <= 12
      && Math.abs(sidebarMascotAfterResize.bottomGap) <= 2, `mascot follows the resized folder ${JSON.stringify(sidebarMascotAfterResize)}`);
    await page.reload(); await ready(page); await openSidebar(page); await page.waitForTimeout(650);
    const restoredSidebar = await page.locator('#sidebar').boundingBox();
    ok(restoredSidebar && Math.abs(restoredSidebar.width - sidebarAfter.width) <= 2, 'folder width survives reload');
    const restoredMascot = await page.evaluate(() => {
      const mascot = $('#mascot').getBoundingClientRect(), board = $('#sidebar').getBoundingClientRect();
      return {rightGap: board.left - mascot.right, bottomGap: board.bottom - mascot.bottom};
    });
    ok(restoredMascot.rightGap >= 6 && restoredMascot.rightGap <= 12 && Math.abs(restoredMascot.bottomGap) <= 2,
      'mascot remains left of the folder after width reload');

    for (const size of [144, 288]) {
      await page.evaluate(height => setMascotSize(height), size);
      await page.waitForTimeout(650);
      const beforeClick = await page.locator('#mascot').boundingBox();
      await page.locator('#mascot-image').click();
      await page.waitForTimeout(650);
      const afterClick = await page.locator('#mascot').boundingBox();
      ok(beforeClick && afterClick
        && Math.abs(afterClick.x - beforeClick.x) <= 1
        && Math.abs(afterClick.y - beforeClick.y) <= 1
        && Math.abs(afterClick.width - beforeClick.width) <= 1
        && Math.abs(afterClick.height - beforeClick.height) <= 1,
      `clicking the open-folder mascot keeps its ${size}px bounding box fixed`);
    }

    const beforeDrag = await page.locator('#mascot').boundingBox();
    const start = await page.locator('#mascot-image').boundingBox();
    const target = await page.evaluate(() => { const r = vp.getBoundingClientRect(); return {x: r.left + 40, y: r.top + 40}; });
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x + start.width / 2, target.y + start.height / 2, {steps: 6}); await page.mouse.up();
    const afterDrag = await page.locator('#mascot').boundingBox();
    ok(beforeDrag && afterDrag && Math.abs(afterDrag.x - beforeDrag.x) <= 1 && Math.abs(afterDrag.y - beforeDrag.y) <= 1,
      'dragging does not move the fixed mascot');

    await page.reload(); await ready(page); await openSidebar(page); await page.waitForTimeout(650);
    const reloaded = await page.evaluate(() => {
      const mascot = $('#mascot').getBoundingClientRect(), board = $('#sidebar').getBoundingClientRect();
      return {rightGap: board.left - mascot.right, bottomGap: board.bottom - mascot.bottom};
    });
    ok(reloaded.rightGap >= 6 && reloaded.rightGap <= 12 && Math.abs(reloaded.bottomGap) <= 2,
      'fixed mascot position follows the clipboard after reload');

    await page.evaluate(() => showClipboard(false));
    await page.waitForTimeout(650);  // the pet slides with the docking case folder (.56s)
    const clickBox = await page.locator('#mascot-image').boundingBox();
    await page.mouse.click(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
    await page.waitForFunction(() => document.querySelector('#sidebar')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('#sidebar')?.contains(document.activeElement));
    await page.waitForTimeout(650);
    console.log('PASS mascot fixed position, non-dragging, resize, and click-to-open board focus');

    // Earlier steps parked the pet top-left, where growing up-left would be clamped; resize it with room around it.
    const beforeSize = await page.locator('#mascot').boundingBox();
    const resize = await page.locator('#mascot-resize').boundingBox();
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
    await page.mouse.down(); await page.mouse.move(resize.x - 36, resize.y - 36, {steps: 4}); await page.mouse.up();
    const afterSize = await page.locator('#mascot').boundingBox();
    ok(afterSize.height > beforeSize.height && afterSize.height <= 360, 'mascot resize handle changes height within the limit');
    ok(Math.abs(afterSize.x + afterSize.width - beforeSize.x - beforeSize.width) <= 2 && Math.abs(afterSize.y + afterSize.height - beforeSize.y - beforeSize.height) <= 2
      && afterSize.height - beforeSize.height > 30, 'top-left grip grows the pet while its bottom-right corner stays put');
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
      // Transition frames must point at real files, or the pet flashes a broken-image icon.
      if (state === 'happy') { // the empty chat starts asleep, so thinking -> happy is the first state change with transition frames
        await page.waitForFunction(() => /-tr-/.test(document.querySelector('#mascot-transition').getAttribute('src')));
        const frame = await page.locator('#mascot-transition').getAttribute('src');
        assert.equal((await page.request.get(new URL(frame, base).href)).status(), 200, `transition frame ${frame} exists`);
      }
      await page.waitForFunction(stateName => {
        const rig = document.querySelector('#mascot-image .rig');
        return rig?.dataset.client === 'claude' && rig.dataset.mood === stateName && rig.dataset.ready === 'true'
          && [...rig.querySelectorAll(':scope > img')].every(image => image.complete && image.naturalWidth > 0);
      }, state);
      await page.waitForFunction(() => {
        const transition = document.querySelector('#mascot-transition');
        return !document.querySelector('#mascot')?.classList.contains('transitioning')
          && getComputedStyle(transition).opacity === '0';
      });
      assert.equal(await page.locator('#mascot-bubble').textContent(), state === 'thinking' ? '思考中…' : state === 'happy' ? '完成了' : state === 'sweat' ? '出錯了…' : 'zzz');
      await page.screenshot({path: path.join(out, `mascot-${state}.png`)});
    }
    // The user wants the pet animated regardless of the OS reduced-motion setting.
    await page.emulateMedia({reducedMotion: 'reduce'});
    await setState('thinking');
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'thinking');
    assert.ok(await page.locator('#mascot-image .rig > img').count() > 1);
    assert.ok((await page.locator('#mascot-image .rig').evaluate(rig => rig.getAnimations({subtree: true}).length)) > 0);
    console.log('PASS mascot state images, status bubbles, animation under reduced motion, and generated asset limits');

    // Clicking the pet: a line in its voice and a different idle pose for a moment, back to the chat state afterwards.
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await page.evaluate(() => {
      chatBusy = false; $('#chat-progress').hidden = true; chatMessages = [{role: 'user', text: 'x'}];
      updateChatMascot(); showClipboard(false); showMascotBubble('');
    });
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle');
    // The pet slides with the case folder (.56s) whenever a click opens or docks it; measure after it stops.
    const pokeAt = async () => {
      await page.waitForTimeout(650);
      const pet = await page.locator('#mascot-image').boundingBox();
      await page.mouse.click(pet.x + pet.width / 2, pet.y + pet.height / 2);
    };
    const lineShown = () => page.waitForFunction(() => MASCOT_LINES.claude.includes(document.querySelector('#mascot-bubble').textContent)
      && document.querySelector('#mascot-bubble').classList.contains('show'));
    await pokeAt();
    await lineShown();
    await page.waitForFunction(() => {
      const rig = document.querySelector('#mascot-image .rig');
      return ['sit', 'read', 'magnify'].includes(rig?.dataset.mood) && rig.dataset.ready === 'true';
    });
    assert.equal(await page.locator('#sidebar').getAttribute('aria-expanded'), 'true', 'a click opens the AI case folder');
    const firstLine = await page.locator('#mascot-bubble').textContent();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#mascot-bubble')).opacity === '1');
    await page.screenshot({path: path.join(out, 'mascot-poke.png')});
    await pokeAt();
    await lineShown();
    assert.notEqual(await page.locator('#mascot-bubble').textContent(), firstLine, 'the next click says a different line');
    assert.equal(await page.locator('#sidebar').getAttribute('aria-expanded'), 'true', 'a click keeps an open case folder open');
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle', null, {timeout: 8000});

    await setState('thinking');
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'thinking'
      && !document.querySelector('#mascot')?.classList.contains('transitioning'));
    await pokeAt();
    await lineShown();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#mascot-image .rig').getAttribute('data-mood'), 'thinking', 'while the AI works the pet only talks');
    console.log('PASS clicking the pet shows its lines, switches pose, and keeps the thinking pose while the AI works');

    // Reduce motion: an idle page with the pet showing runs no animations at all (remote desktops repaint less).
    await page.evaluate(() => { chatBusy = false; $('#chat-progress').hidden = true; chatMessages = [{role: 'user', text: 'x'}]; updateChatMascot(); });
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle');
    await page.waitForFunction(() => document.getAnimations().some(a => a.playState === 'running'));
    await page.evaluate(() => setReduceMotion(true));
    await page.waitForTimeout(700);
    ok(await page.evaluate(() => !document.getAnimations().some(a => a.playState === 'running') && !mascotIdleTimer && !mascotBlinkTimer),
      'reduce motion leaves an idle page with the pet showing free of running animations and pet timers');
    await page.reload(); await ready(page);
    ok(await page.evaluate(() => reduceMotion && document.documentElement.classList.contains('reduce-motion') && $('#reduce-motion').checked),
      'reduce motion is remembered across reloads');
    await page.evaluate(() => { setReduceMotion(false); chatBusy = false; chatMessages = [{role: 'user', text: 'x'}]; updateChatMascot(); });
    await page.waitForFunction(() => document.getAnimations().some(a => a.playState === 'running'));
    console.log('PASS reduce motion stops the pet animations and is remembered');

    await page.click('#zoom-fit');
    await page.evaluate(() => showMascotBubble(''));
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
