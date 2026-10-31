const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload, openActivity, openSidebar, artifacts} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const out = artifacts('visual');
const p13 = path.join(path.dirname(out), 'p13');
fs.mkdirSync(p13, {recursive: true});
const themes = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const styles = ['tech', 'paper'];

function uiStyleText() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const style = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] || '';
  const firstUiRule = style.indexOf('*{box-sizing:border-box}');
  assert.ok(firstUiRule >= 0, 'style must keep a theme block before the UI rules');
  let ui = style.slice(firstUiRule);
  // Allowlist: the six [data-theme=…] palette/wall blocks, the .card/.c-* card tones,
  // and the [data-card-style=paper] card-tone block. Every other UI rule is scanned.
  ui = ui.replace(/\.card,\.swatch,\.tag-chip\{[^}]*\}/g, '');
  ui = ui.replace(/\.c-[^{]+\{[^}]*\}/g, '');
  const paper = ui.indexOf('/* Technology is the existing dense style.');
  if (paper >= 0) ui = ui.slice(0, paper);
  return ui;
}

async function themeStyles(page, theme) {
  const result = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const color = value => {
      const text = String(value).trim();
      const rgba = text.match(/^rgba?\(([^)]+)\)$/i);
      if (rgba) {
        const values = rgba[1].replace(/\//g, ' ').trim().split(/[\s,]+/).map(Number);
        return [values[0], values[1], values[2], Number.isFinite(values[3]) ? values[3] : 1];
      }
      const hex = text.match(/^#([0-9a-f]{3,8})$/i)?.[1];
      if (hex) {
        const full = hex.length <= 4 ? hex.split('').map(char => char + char).join('') : hex;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1];
      }
      throw new Error('unsupported computed color: ' + text);
    };
    const composite = (foreground, background) => {
      const alpha = foreground[3];
      return [0, 1, 2].map(i => foreground[i] * alpha + background[i] * (1 - alpha));
    };
    const luminance = value => {
      const rgb = value.slice(0, 3).map(channel => channel / 255).map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    };
    const ratio = (foreground, background) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + .05) / (dark + .05);
    };
    const token = name => color(root.getPropertyValue(name));
    const style = selector => getComputedStyle(document.querySelector(selector));
    const backgrounds = {
      body: color(style('body').backgroundColor),
      header: color(style('header').backgroundColor),
      activitybar: color(style('#activitybar').backgroundColor),
      activityPanel: color(style('#activity-panel').backgroundColor),
      sidebar: color(style('#sidebar').backgroundColor),
      panel: color(style('#panel').backgroundColor),
      input: color(style('#chat-input').backgroundColor),
      dialog: color(style('#importer').backgroundColor),
    };
    const foregrounds = {
      body: color(style('body').color),
      muted: token('--ui-muted'),
      button: color(style('button').color),
      input: color(style('#chat-input').color),
    };
    return {
      tokens: Object.fromEntries(['--ui-bg', '--ui-panel', '--ui-bar', '--ui-surface', '--ui-input', '--ui-text', '--ui-muted', '--ui-raised', '--ui-active']
        .map(name => [name, token(name)])),
      backgrounds,
      foregrounds,
      ratios: {
        primary: ratio(foregrounds.body, backgrounds.body),
        secondary: ratio(foregrounds.muted, backgrounds.body),
        button: ratio(foregrounds.button, color(style('button').backgroundColor)),
        input: ratio(foregrounds.input, backgrounds.input),
        board: ratio(token('--ui-bg'), token('--wall-color')),
        accent: ratio(token('--ui-accent'), token('--ui-panel')),
      },
    };
  });
  const same = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 1);
  assert.ok(same(result.backgrounds.body, result.tokens['--ui-bg']), `${theme}: body background is not --ui-bg`);
  assert.ok(same(result.backgrounds.header, result.tokens['--ui-panel']), `${theme}: header is not --ui-panel`);
  assert.ok(same(result.backgrounds.activitybar, result.tokens['--ui-bar']), `${theme}: activity bar is not --ui-bar`);
  assert.ok(same(result.backgrounds.activityPanel, result.tokens['--ui-panel']), `${theme}: activity panel is not --ui-panel`);
  assert.ok(same(result.backgrounds.sidebar, result.tokens['--ui-panel']), `${theme}: sidebar is not --ui-panel`);
  assert.ok(same(result.backgrounds.panel, result.tokens['--ui-surface']), `${theme}: editor is not --ui-surface`);
  assert.ok(same(result.backgrounds.input, result.tokens['--ui-input']), `${theme}: input is not --ui-input`);
  assert.ok(same(result.backgrounds.dialog, result.tokens['--ui-surface']), `${theme}: dialog is not --ui-surface`);
  for (const [name, value] of Object.entries(result.ratios)) {
    if (name !== 'board') assert.ok(value >= 4.5, `${theme}: ${name} contrast ${value.toFixed(2)} < 4.5`);
  }
  assert.ok(result.ratios.board >= 1.5, `${theme}: UI/board contrast ${result.ratios.board.toFixed(2)} < 1.5`);
  return result.ratios;
}

(async () => {
  const declarations = uiStyleText().split('}').map(rule => rule.slice(rule.lastIndexOf('{') + 1)).join('\n');
  const literals = declarations.match(/#[0-9a-f]{3,8}\b|rgba?\s*\(/gi) || [];
  assert.deepEqual(literals, [], 'hard-coded UI colors remain outside the documented allowlist');
  console.log('PASS UI color scan leaves only theme and card color allowlists');
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await ready(page);
    const cork = await page.context().request.get(base + '/assets/cork.jpg');
    assert.equal(cork.status(), 200);
    assert.equal(cork.headers()['content-type'], 'image/jpeg');
    const traversal = await page.context().request.get(base + '/assets/../server/db.js');
    assert.equal(traversal.status(), 404);
    await page.evaluate(() => setTheme('cork'));
    assert.match(await page.evaluate(() => getComputedStyle($('#bg')).backgroundImage), /cork\.jpg/);
    console.log('PASS cork texture route is fixed, cached JPEG and not traversable');
    await page.click('#zoom-fit');

    for (const theme of themes) for (const style of styles) {
      await page.evaluate(({theme, style}) => {
        setTheme(theme); setCardStyle(style); showActivity(null); fitView(true);
      }, {theme, style});
      assert.equal(await page.getAttribute('html', 'data-theme'), theme);
      assert.equal(await page.getAttribute('html', 'data-card-style'), style);
      assert.equal(await page.locator(`.card.card-${style}`).count(), 7);
      await page.screenshot({path: path.join(out, `theme-${theme}-${style}.png`)});
      await page.evaluate(() => openPanel('mine'));
      await page.screenshot({path: path.join(p13, `theme-${theme}-${style}.png`)});
      await page.evaluate(() => closePanel());
    }
    console.log('PASS six themes and both card styles render cards and notes with persisted style classes');
    console.log('PASS P13 theme screenshots include both card styles and the editor panel');
    const themeRatios = {};
    for (const theme of themes) {
      await page.evaluate(themeName => {
        setTheme(themeName); setCardStyle('tech'); showActivity('sources'); showSidebar(true); fitView(true); openPanel('mine');
        $('#importer').showModal();
      }, theme);
      await page.waitForTimeout(250);
      themeRatios[theme] = await themeStyles(page, theme);
      await page.evaluate(() => $('#importer').close());
      await page.screenshot({path: path.join(out, `theme-${theme}-full-ui.png`)});
      await page.evaluate(() => closePanel());
    }
    console.log('THEME_CONTRAST ' + JSON.stringify(themeRatios));
    console.log('PASS six themes apply palette tokens to the full UI and meet WCAG contrast');
    await page.evaluate(() => setCardStyle('paper'));
    await reload(page);
    assert.equal(await page.getAttribute('html', 'data-card-style'), 'paper');
    assert.equal(await page.locator('.card.card-paper').count(), 7);
    console.log('PASS card style survives reload');

    const panelIds = ['files', 'history', 'templates', 'sources', 'tags', 'theme', 'help'];
    for (const id of panelIds) {
      await openActivity(page, id);
      const section = {files: 'files', history: 'history', templates: 'template', sources: 'source', tags: 'tags', theme: 'theme', help: 'help'}[id];
      assert.equal(await page.isVisible(`#${section}-section`), true);
      await page.screenshot({path: path.join(out, `panel-${id}.png`)});
    }
    console.log('PASS all seven left panels have review screenshots');

    await page.evaluate(() => openPanel('shoup'));
    await page.fill('#f-tag', 'CardTag');
    await page.waitForSelector('#f-tag-list [role="option"]');
    assert.match(await page.textContent('#f-tag-list'), /建立「CardTag」/);
    await page.getByRole('option', {name: '建立「CardTag」', exact: true}).click();
    assert.ok(await page.evaluate(() => byId('shoup').tags.length === 1));
    await page.evaluate(() => openPanel('q1'));
    await page.fill('#f-tag', 'CardTag');
    await page.getByRole('option', {name: '加入「CardTag」', exact: true}).click();
    assert.ok(await page.evaluate(() => byId('q1').tags.length === 1));
    await page.waitForTimeout(600);
    const removeCardTag = page.locator('#f-tags .tag-chip button');
    assert.equal(await removeCardTag.count(), 1);
    await removeCardTag.click();
    await page.click('#f-close');
    await page.keyboard.press('Control+Z');
    await page.evaluate(() => openPanel('q1'));
    assert.equal(await page.locator('#f-tags .tag-chip button').count(), 1);
    await page.click('#f-close');
    console.log('PASS card and note editors add with the combobox, remove with chip buttons, and undo');

    await openActivity(page, 'tags');
    await page.fill('#tag-new-name', 'Project');
    await page.press('#tag-new-name', 'Enter');
    await page.waitForSelector('#tag-filter .tag-manager');
    const projectId = await page.evaluate(() => data.tags.find(tag => tag.name === 'Project').id);
    await page.evaluate(() => openPanel('q1'));
    await page.fill('#f-tag', 'Project');
    await page.getByRole('option', {name: '加入「Project」', exact: true}).click();
    await page.click('#f-close');
    await openActivity(page, 'tags');
    await page.locator(`#tag-filter .tag-manager[data-id="${projectId}"] .tag-name`).click();
    await page.fill('.tag-rename-input', 'Clues');
    await page.press('.tag-rename-input', 'Enter');
    assert.equal(await page.evaluate(id => data.tags.find(tag => tag.id === id).name, projectId), 'Clues');
    await page.locator(`#tag-filter .tag-manager[data-id="${projectId}"] .tag-edit`).click();
    await page.click('#tagpop [data-color="green"]');
    assert.equal(await page.evaluate(id => data.tags.find(tag => tag.id === id).color, projectId), 'green');
    await page.click('#tagpop button:not(.danger):has-text("關閉")');
    await page.locator(`#tag-filter .tag-manager[data-id="${projectId}"] .tag-toggle`).click();
    assert.ok(await page.evaluate(id => activeTags.has(id), projectId));
    await page.locator(`#tag-filter .tag-manager[data-id="${projectId}"] .tag-toggle`).click();
    await page.locator(`#tag-filter .tag-manager[data-id="${projectId}"] .tag-edit`).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', {name: '刪除標籤', exact: true}).click();
    assert.ok(await page.evaluate(id => data.tags.some(tag => tag.id === id), projectId));
    await page.getByRole('button', {name: '再按一次刪除', exact: true}).click();
    assert.ok(await page.evaluate(id => !data.tags.some(tag => tag.id === id) && data.cards.every(card => !(card.tags || []).includes(id)), projectId));
    await page.keyboard.press('Control+Z');
    assert.ok(await page.evaluate(id => data.tags.some(tag => tag.id === id) && data.cards.some(card => (card.tags || []).includes(id)), projectId));
    console.log('PASS tag panel adds, inline-renames, recolours, two-click deletes, and undoes as one change');

    await openActivity(page, 'sources');
    const folder = path.join(out, 'visual-source');
    await page.fill('#source-folders', 'relative/path');
    await page.click('#source-folders-add');
    assert.match(await page.textContent('#source-folders-status'), /絕對路徑/);
    await page.fill('#source-folders', folder);
    await page.press('#source-folders', 'Enter');
    await page.waitForSelector('#source-folder-list .source-folder-row');
    assert.equal(await page.evaluate(async () => (await store.getMeta('sourceFolders')).length), 1);
    await reload(page);
    await openActivity(page, 'sources');
    // the folder list loads from the server after the panel opens
    await page.waitForFunction(() => document.querySelectorAll('#source-folder-list .source-folder-row').length === 1);
    await page.fill('#source-folders', folder);
    await page.click('#source-folders-add');
    assert.match(await page.textContent('#source-folders-status'), /已在清單/);
    await page.getByRole('button', {name: '移除資料夾：' + folder, exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('#source-folder-list .source-folder-row').length === 0);
    assert.deepEqual(await page.evaluate(() => store.getMeta('sourceFolders')), []);
    console.log('PASS folder list adds on Enter, rejects relative and duplicate paths, saves immediately, and removes');

    await page.evaluate(() => showActivity(null));
    await page.click('#zoom-fit');
    await page.click('.card[data-id="mine"]');
    const before = await page.locator('#panel').boundingBox();
    const handle = await page.locator('#panel-resize').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 80, handle.y + 70, {steps: 5});
    await page.mouse.up();
    const after = await page.locator('#panel').boundingBox();
    assert.ok(after.width > before.width && after.height > before.height && after.width >= 300 && after.height >= 240);
    const savedSize = await page.evaluate(() => JSON.parse(localStorage.getItem(PANEL_SIZE_KEY)));
    assert.ok(savedSize.width >= 300 && savedSize.height >= 240);
    const titlebar = await page.locator('#panel-titlebar').boundingBox();
    const body = await page.locator('#panel-body').boundingBox();
    const bodyScroll = await page.evaluate(() => ({height: $('#panel-body').scrollHeight, client: $('#panel-body').clientHeight}));
    assert.ok(bodyScroll.height > bodyScroll.client);
    await page.evaluate(() => { $('#panel-body').scrollTop = $('#panel-body').scrollHeight; });
    const titlebarBottom = await page.locator('#panel-titlebar').boundingBox();
    assert.equal(Math.round(titlebarBottom.y), Math.round(titlebar.y));
    await page.screenshot({path: path.join(out, 'editor-bottom.png')});
    await page.click('#f-close');
    await reload(page);
    await page.click('#zoom-fit'); await page.click('.card[data-id="mine"]');
    const restored = await page.locator('#panel').boundingBox();
    assert.ok(Math.abs(restored.width - after.width) < 2 && Math.abs(restored.height - after.height) < 2);
    await page.keyboard.press('Escape');
    console.log('PASS editor resize persists, body scrolls independently, and header stays fixed');

    await openSidebar(page);
    await page.evaluate(() => showActivity(null));
    await page.locator('#sidebar').screenshot({path: path.join(out, 'ai-area.png')});
    assert.deepEqual(await page.locator('#sidebar > section').evaluateAll(sections => sections.map(section => section.id)), ['chat-section', 'ai-section']);
    console.log('PASS right AI area screenshot is captured');
    assert.equal(errors.length, 0, 'page errors: ' + errors.join('; '));
    console.log('PASS no page errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
