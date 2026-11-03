const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, openSidebar} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const screenshots = path.join(__dirname, '..', 'test-results', 'mascot-integrated');
fs.mkdirSync(screenshots, {recursive: true});

const rigs = {
  claude: {
    idle: {size: [512, 768], layers: ['base', 'blink', 'hairL', 'hairR', 'ahoge'], pivots: {hairL: [21.48, 32.55], hairR: [80.08, 32.55], ahoge: [50.39, 8.07]}},
    thinking: {size: [491, 768], layers: ['base', 'hairL', 'hairR', 'ahoge', 'fx'], pivots: {hairL: [20.37, 31.25], hairR: [81.47, 30.60], ahoge: [45.82, 8.07]}},
    happy: {size: [496, 768], layers: ['base', 'hairL', 'hairR', 'ahoge', 'fx'], pivots: {hairL: [16.13, 31.25], hairR: [80.65, 30.60], ahoge: [41.33, 8.07]}},
    sweat: {size: [528, 768], layers: ['base', 'hairL', 'hairR', 'ahoge', 'fx'], pivots: {hairL: [17.05, 31.25], hairR: [81.44, 30.60], ahoge: [38.83, 8.07]}},
    sleep: {size: [528, 768], layers: ['base', 'hairL', 'hairR', 'ahoge', 'fx'], pivots: {hairL: [17.05, 31.25], hairR: [83.33, 30.60], ahoge: [51.14, 6.77]}},
    sit: {size: [512, 768], layers: ['base', 'hairL', 'hairR', 'ahoge'], pivots: {hairL: [22.46, 37.76], hairR: [79.10, 37.76], ahoge: [50.78, 17.19]}},
    read: {size: [512, 768], layers: ['base', 'hairL', 'hairR', 'ahoge'], pivots: {hairL: [21.48, 33.85], hairR: [80.08, 33.85], ahoge: [50.39, 13.02]}},
    magnify: {size: [512, 768], layers: ['base', 'hairL', 'hairR', 'ahoge'], pivots: {hairL: [21.48, 32.55], hairR: [80.08, 32.55], ahoge: [50.39, 13.02]}},
  },
  codex: {
    idle: {size: [542, 768], layers: ['tail', 'base', 'blink', 'ahoge'], pivots: {tail: [23.06, 80.08], ahoge: [47.60, 8.46]}},
    thinking: {size: [499, 768], layers: ['tail', 'base', 'ahoge', 'fx'], pivots: {tail: [23.05, 78.12], ahoge: [39.08, 7.55]}},
    happy: {size: [505, 768], layers: ['tail', 'base', 'ahoge', 'fx'], pivots: {tail: [22.18, 72.92], ahoge: [43.56, 7.55]}},
    sweat: {size: [498, 768], layers: ['tail', 'base', 'ahoge', 'fx'], pivots: {tail: [21.08, 78.12], ahoge: [47.79, 7.55]}},
    sleep: {size: [517, 768], layers: ['tail', 'base', 'ahoge', 'fx'], pivots: {tail: [20.31, 76.82], ahoge: [46.03, 7.29]}},
    sit: {size: [512, 768], layers: ['tail', 'base', 'ahoge'], pivots: {tail: [19.53, 83.33], ahoge: [47.85, 19.53]}},
    read: {size: [512, 768], layers: ['tail', 'base', 'ahoge'], pivots: {tail: [19.53, 76.17], ahoge: [46.88, 8.07]}},
    magnify: {size: [512, 768], layers: ['tail', 'base', 'ahoge'], pivots: {tail: [20.51, 77.47], ahoge: [46.88, 8.85]}},
  },
};
const moods = ['idle', 'thinking', 'happy', 'sweat', 'sleep', 'sit', 'read', 'magnify'];
const statusMoods = ['idle', 'thinking', 'happy', 'sweat', 'sleep'];
const layersRoot = path.join(__dirname, '..', 'assets', 'avatars', 'layers');
const fail = [];

const check = async (name, fn) => {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (error) {
    fail.push({name, message: error.message});
    console.log('FAIL ' + name + ': ' + error.message);
  }
};

const expectRig = async (page, client, mood) => {
  await page.waitForFunction(({client: wantedClient, mood: wantedMood}) => {
    const rig = document.querySelector('#mascot-image .rig');
    return rig?.dataset.client === wantedClient && rig.dataset.mood === wantedMood && rig.dataset.ready === 'true'
      && [...rig.querySelectorAll(':scope > img')].every(image => image.complete && image.naturalWidth > 0);
  }, {client, mood}, {timeout: 1400});
};

const setState = (page, client, mood) => page.evaluate(({client: nextClient, mood: nextMood}) => {
  chatClient = nextClient;
  mascotForcedSleep = nextMood === 'sleep';
  chatBusy = nextMood === 'thinking';
  $('#chat-progress').hidden = nextMood !== 'thinking';
  chatMessages = nextMood === 'thinking' ? [{role: 'user', text: 'x'}]
    : nextMood === 'happy' ? [{role: 'assistant', text: 'done'}]
    : nextMood === 'sweat' ? [{role: 'assistant', error: 'bad'}]
    : nextMood === 'idle' ? [{role: 'user', text: 'x'}]
    : [];
  updateChatMascot();
}, {client, mood});

const setDisplay = async (page, client, mood) => {
  if (statusMoods.includes(mood)) return setState(page, client, mood);
  await page.evaluate(async ({client: nextClient, mood: nextMood}) => {
    clearMascotIdle(); clearTimeout(mascotBlinkTimer); mascotMood = 'idle'; mascotClient = nextClient; mascotDisplayMood = '';
    const sequence = ++mascotRenderSequence;
    await mountMascotMood(nextClient, nextMood, 'v-breeze', sequence);
  }, {client, mood});
};

const screenshotRig = async (page, name) => {
  const locator = page.locator('#mascot-image .rig');
  await locator.screenshot({path: path.join(screenshots, name + '.png')});
};

const freezeRig = page => page.evaluate(() => {
  const mascot = document.querySelector('#mascot');
  const rig = document.querySelector('#mascot-image .rig');
  mascot?.classList.remove('blinking', 'crossfading', 'transitioning');
  // The transition and crossfade overlays fade out over the rig; hide them so only the rig is compared.
  for (const overlay of document.querySelectorAll('#mascot-transition, #mascot-blink')) { overlay.style.transition = 'none'; overlay.style.opacity = '0'; }
  for (const animation of rig?.getAnimations({subtree: true}) || []) animation.cancel();
  if (rig) { rig.style.animation = 'none'; rig.style.background = 'rgb(24, 24, 24)'; }
  for (const element of rig?.querySelectorAll('*') || []) element.style.animation = 'none';
});

const meanDifference = async (page, restUrl) => {
  const screenshot = await page.locator('#mascot-image .rig').screenshot({omitBackground: true});
  const layers = await page.locator('#mascot-image .rig > img').evaluateAll(images => images.filter(image => image.dataset.layer !== 'blink').map(image => image.src));
  return page.evaluate(async ({png, rest, layers}) => {
    const load = source => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
    const [shot, expected, layerImages] = await Promise.all([
      load('data:image/png;base64,' + png),
      load(rest),
      Promise.all(layers.map(load)),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = shot.naturalWidth;
    canvas.height = shot.naturalHeight;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(shot, 0, 0);
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const drawExpected = draw => {
      context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'rgb(24, 24, 24)'; context.fillRect(0, 0, canvas.width, canvas.height); draw();
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const restPixels = drawExpected(() => context.drawImage(expected, 0, 0, canvas.width, canvas.height));
    const layerPixels = drawExpected(() => layerImages.forEach(image => context.drawImage(image, 0, 0, canvas.width, canvas.height)));
    const diff = target => {
      let total = 0;
      for (let i = 0; i < actual.length; i += 4) total += (Math.abs(actual[i] - target[i]) + Math.abs(actual[i + 1] - target[i + 1]) + Math.abs(actual[i + 2] - target[i + 2])) / 3;
      return total / (canvas.width * canvas.height);
    };
    return {rest: diff(restPixels), layers: diff(layerPixels)};
  }, {png: screenshot.toString('base64'), rest: restUrl, layers});
};

(async () => {
  await check('layer asset manifest and no orig.webp copied', () => {
    for (const client of Object.keys(rigs)) {
      assert.ok(fs.existsSync(path.join(layersRoot, client, 'rig.json')), `${client}/rig.json is present`);
      for (const mood of moods) {
        const directory = path.join(layersRoot, client, mood);
        assert.ok(fs.existsSync(path.join(directory, 'rest.webp')), `${client}/${mood}/rest.webp is present`);
        for (const layer of rigs[client][mood].layers) assert.ok(fs.existsSync(path.join(directory, layer + '.webp')), `${client}/${mood}/${layer}.webp is present`);
        assert.equal(fs.existsSync(path.join(directory, 'orig.webp')), false, `${client}/${mood}/orig.webp is not copied`);
      }
    }
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'avatars', 'codex-body-blink.webp')), 'codex blink replacement is present');
  });

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.addInitScript(() => {
      globalThis.__MASCOT_TEST_TIMING = {idleSwitchMs: 500, blinkDelayMs: 200};
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await ready(page); await openSidebar(page);

    await check('nested layer assets are served safely', async () => {
      const result = await page.evaluate(async () => {
        const good = await fetch('/assets/avatars/layers/claude/idle/base.webp');
        const traversal = await fetch('/assets/avatars/layers/claude/%2e%2e/%2e%2e/index.html');
        return {good: good.status, traversal: traversal.status};
      });
      assert.equal(result.good, 200, 'nested layer asset returns 200');
      assert.ok(result.traversal >= 400, 'encoded traversal is rejected');
    });

    await check('rig layer order and mood sizes cover both characters', async () => {
      for (const client of Object.keys(rigs)) {
        for (const mood of moods) {
          await setDisplay(page, client, mood);
          await expectRig(page, client, mood);
          const actual = await page.evaluate(() => {
            const rig = document.querySelector('#mascot-image .rig');
            return {layers: [...rig.querySelectorAll(':scope > img')].map(image => image.dataset.layer), aspect: getComputedStyle(rig).aspectRatio};
          });
          assert.deepEqual(actual.layers, rigs[client][mood].layers, `${client}/${mood} layer order`);
          assert.match(actual.aspect, new RegExp(`${rigs[client][mood].size[0]}\\s*/\\s*${rigs[client][mood].size[1]}`), `${client}/${mood} canvas aspect ratio`);
          await screenshotRig(page, `${client}-${mood}`);
        }
      }
    });

    await check('all layers decode before a mood is displayed', async () => {
      await setState(page, 'claude', 'sleep'); await expectRig(page, 'claude', 'sleep');
      await page.route('**/assets/avatars/layers/codex/thinking/*.webp', async route => {
        if (!route.request().url().endsWith('/base.webp')) await new Promise(resolve => setTimeout(resolve, 160));
        await route.continue();
      });
      await setState(page, 'codex', 'thinking');
      await page.waitForTimeout(30);
      const duringLoad = await page.evaluate(() => {
        const rig = document.querySelector('#mascot-image .rig');
        return {mood: rig?.dataset.mood, count: rig?.querySelectorAll(':scope > img').length || 0};
      });
      assert.ok(duringLoad.mood !== 'thinking' || duringLoad.count === rigs.codex.thinking.layers.length, 'there is no base-only target frame');
      await expectRig(page, 'codex', 'thinking');
      await page.unroute('**/assets/avatars/layers/codex/thinking/*.webp');
    });

    await check('rig pivots use canvas percentages as transform-origin', async () => {
      for (const client of Object.keys(rigs)) {
        for (const mood of moods) {
          await setDisplay(page, client, mood); await expectRig(page, client, mood);
          const origins = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mascot-image .rig > img')].map(image => [image.dataset.layer, image.style.transformOrigin])));
          for (const [layer, pct] of Object.entries(rigs[client][mood].pivots)) assert.equal(origins[layer], `${pct[0]}% ${pct[1]}%`, `${client}/${mood}/${layer} pivot`);
        }
      }
    });

    await check('paused layer composition matches every rest.webp', async () => {
      const means = [];
      for (const client of Object.keys(rigs)) {
        for (const mood of moods) {
          await setDisplay(page, client, mood); await expectRig(page, client, mood); await freezeRig(page); await page.waitForTimeout(30);
          const comparison = await meanDifference(page, `/assets/avatars/layers/${client}/${mood}/rest.webp`), mean = comparison.rest;
          console.log(`MEAN_DIFF ${client}/${mood} rest=${mean.toFixed(3)} layers=${comparison.layers.toFixed(3)}`);
          assert.ok(mean < 12, `${client}/${mood} mean pixel difference ${mean.toFixed(3)} < 12`);
          await page.evaluate(() => { for (const overlay of document.querySelectorAll('#mascot-transition, #mascot-blink')) overlay.style.transition = overlay.style.opacity = ''; const rig = document.querySelector('#mascot-image .rig'); if (rig) { rig.style.animation = ''; rig.style.background = ''; for (const element of rig.querySelectorAll('*')) element.style.animation = ''; } });
        }
      }
    });

    await check('codex tail rotation never exceeds 3 degrees', async () => {
      for (const mood of moods) {
        await setDisplay(page, 'codex', mood); await expectRig(page, 'codex', mood);
        const max = await page.evaluate(() => {
          const tail = document.querySelector('#mascot-image .rig > img[data-layer="tail"]');
          const animation = tail?.getAnimations()[0];
          if (!tail || !animation) return 0;
          const duration = Number(animation.effect.getComputedTiming().duration) || 1;
          let result = 0;
          for (let i = 0; i <= 120; i++) {
            animation.currentTime = duration * i / 120;
            const transform = getComputedStyle(tail).transform, match = transform.match(/^matrix\((-?[^,]+),\s*(-?[^,]+),/);
            const degrees = match ? Math.atan2(Number(match[2]), Number(match[1])) * 180 / Math.PI : 0;
            result = Math.max(result, Math.abs(degrees));
          }
          return result;
        });
        assert.ok(max <= 3.01, `codex/${mood} tail max ${max.toFixed(3)}°`);
      }
    });

    await check('idle rotates variants and idle/sit/read/magnify on documented timing', async () => {
      const variants = ['v-breeze', 'v-sway', 'v-boing', 'v-gust'];
      const drawings = ['idle', 'sit', 'read', 'magnify'];
      for (const client of Object.keys(rigs)) {
        await setState(page, client, 'idle'); await expectRig(page, client, 'idle');
        for (let step = 0; step <= 6; step++) {
          const state = await page.evaluate(() => {
            const rig = document.querySelector('#mascot-image .rig');
            return {variant: rig.dataset.variant, mood: rig.dataset.mood};
          });
          assert.equal(state.variant, variants[step % variants.length], `${client} idle variant ${step}`);
          assert.equal(state.mood, drawings[Math.floor(step / 2) % drawings.length], `${client} idle drawing ${step}`);
          await screenshotRig(page, `${client}-idle-sequence-${String(step).padStart(2, '0')}-${state.mood}-${state.variant}`);
          if (step < 6) {
            const before = state.variant;
            await page.waitForFunction(previous => document.querySelector('#mascot-image .rig')?.dataset.variant !== previous, before, {timeout: 1200});
            await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.ready === 'true', null, {timeout: 1200});
          }
        }
      }
    });

    await check('blink is only on the idle image', async () => {
      await setState(page, 'claude', 'idle'); await expectRig(page, 'claude', 'idle');
      await page.waitForFunction(() => document.querySelector('#mascot')?.classList.contains('blinking'), null, {timeout: 1000});
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#mascot').evaluate(element => element.classList.contains('blinking')), false, 'blink class closes after 120ms');
      await setState(page, 'claude', 'thinking'); await expectRig(page, 'claude', 'thinking'); await page.waitForTimeout(80);
      assert.equal(await page.locator('#mascot-image .rig > img[data-layer="blink"]').count(), 0, 'thinking has no blink layer');
      await setState(page, 'claude', 'idle'); await expectRig(page, 'claude', 'idle');
      await page.waitForTimeout(1050);
      assert.equal(await page.locator('#mascot-image .rig').getAttribute('data-mood'), 'sit', 'idle carousel leaves blink image after two switches');
      assert.ok(await page.locator('#mascot-image .rig > img[data-layer="blink"]').count() === 0, 'sit has no blink layer');
    });

    await check('whole-body breathing is absent', async () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
      assert.doesNotMatch(source, /mascot-breathe/);
      assert.equal(await page.locator('#mascot-image .rig').evaluate(rig => [...rig.getAnimations({subtree: true})].some(animation => String(animation.animationName || '').includes('breathe'))), false);
    });

    await check('animations play even when the OS asks for reduced motion (user decision)', async () => {
      await page.emulateMedia({reducedMotion: 'reduce'});
      for (const client of Object.keys(rigs)) {
        await setState(page, client, 'idle'); await expectRig(page, client, 'idle');
        const layered = await page.evaluate(() => {
          const rig = document.querySelector('#mascot-image .rig');
          return {count: rig?.querySelectorAll(':scope > img').length, animations: [...rig.getAnimations({subtree: true})].length};
        });
        assert.ok(layered.count > 1 && layered.animations > 0, `${client}/idle keeps its animated layers under reduced motion`);
      }
      assert.ok(!(await page.locator('#sidebar').evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(d => parseFloat(d) === 0))), 'clipboard slide keeps its transition');
      await page.emulateMedia({reducedMotion: 'no-preference'});
    });

    await check('drag, resize, click-to-open, and top z-layer remain intact', async () => {
      await setState(page, 'claude', 'idle'); await expectRig(page, 'claude', 'idle');
      const z = await page.locator('#mascot').evaluate(element => Number.parseInt(getComputedStyle(element).zIndex, 10));
      assert.ok(z >= 1000, `mascot z-index ${z}`);
      await page.evaluate(() => setMascotPosition(600, 400));
      const start = await page.locator('#mascot-image').boundingBox();
      const target = await page.evaluate(() => { const r = vp.getBoundingClientRect(); return {x: r.left + 40, y: r.top + 40}; });
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
      await page.mouse.move(target.x + start.width / 2, target.y + start.height / 2, {steps: 5}); await page.mouse.up();
      const dragged = await page.locator('#mascot').boundingBox();
      assert.ok(Math.abs(dragged.x - target.x) < 4 && Math.abs(dragged.y - target.y) < 4, 'layer rig remains draggable');
      await page.evaluate(() => setMascotPosition(600, 400));
      const before = await page.locator('#mascot').boundingBox();
      const resize = await page.locator('#mascot-resize').boundingBox();
      await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await page.mouse.down();
      await page.mouse.move(resize.x - 36, resize.y - 36, {steps: 4}); await page.mouse.up();
      const after = await page.locator('#mascot').boundingBox();
      assert.ok(after.height > before.height && Math.abs(after.x + after.width - before.x - before.width) <= 2 && Math.abs(after.y + after.height - before.y - before.height) <= 2, 'top-left resize keeps bottom-right anchored');
      await page.evaluate(() => showClipboard(false));
      const click = await page.locator('#mascot-image').boundingBox();
      await page.mouse.click(click.x + click.width / 2, click.y + click.height / 2);
      await page.waitForFunction(() => document.querySelector('#sidebar')?.getAttribute('aria-expanded') === 'true');
    });

    await check('mascot page errors stay empty', () => assert.deepEqual(errors, []));
  } finally {
    await browser.close();
  }
  if (fail.length) throw new Error(`${fail.length} mascot layer checks failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
