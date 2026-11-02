const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, artifacts} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = artifacts('p17');
const themes = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const themeLabels = {whiteboard: '白板色', wood: '木紋', paper: '書頁黃', cork: '軟木', moon: '月夜', cyber: '賽博'};

async function fillVisualFixture(page) {
  await page.evaluate(() => {
    const add = (parent, tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      parent.append(node);
      return node;
    };
    showActivity(null); showSidebar(true); setSidebarWidth(360);
    $('#chat-client-meta').textContent = '已連線';
    $('#chat-client-state').textContent = '';
    $('#chat-client').disabled = false; $('#chat-new').disabled = false;

    $('#ai-proposals-toggle').checked = true;
    $('#ai-pending-count').textContent = '2 件待審';
    $('#ai-review-open').disabled = false;
    const proposalList = $('#ai-proposal-list'); proposalList.replaceChildren();
    for (const [title, summary] of [
      ['補上「港口車牌」時間錨點', '時間線 · 新增 1 張卡片 · 影響 2 條關係'],
      ['連結雨夜目擊者與碼頭', '關係線 · 建議建立 2 條連結 · 需要你確認'],
    ]) {
      const row = add(proposalList, 'article', 'ai-row proposal-card');
      const copy = add(row, 'div', 'card-copy');
      add(copy, 'strong', '', title); add(copy, 'small', '', summary);
      const actions = add(row, 'div', 'card-actions');
      const button = add(actions, 'button', '', '檢視變更'); button.type = 'button';
    }

    $('#ai-audit-meta').textContent = '最近 1 筆';
    const auditList = $('#ai-audit-list'); auditList.replaceChildren();
    const audit = add(auditList, 'article', 'ai-row audit-card');
    add(audit, 'span', 'audit-icon', '✓');
    const auditCopy = add(audit, 'div', 'audit-copy');
    add(auditCopy, 'strong', '', '標籤：目擊時間');
    add(auditCopy, 'small', '', '08:35 · 寫入「雨夜目擊者」「港口車牌」等 3 張卡片');
    const revert = add(audit, 'button', '', '回復'); revert.type = 'button';

    $('#chat-progress').hidden = false; $('#progress-state').textContent = '分析中';
    $('#chat-elapsed').textContent = '執行中 18 秒'; $('#chat-progress-summary').textContent = '正在比對來源與時間軸';
    $('#chat-progress-track').hidden = false; $('#chat-progress-bar').style.width = '62%';
    $('#chat-progress-list').replaceChildren();
    for (const line of ['時間錨點', '來源比對']) add($('#chat-progress-list'), 'li', '', line);
    $('#chat-stop').hidden = false; $('#chat-stop').disabled = false;

    const messages = $('#chat-messages'); messages.replaceChildren();
    const user = add(messages, 'div', 'chat-line user');
    add(user, 'div', 'chat-message user', '請把「雨夜目擊者」與「港口車牌」的時間線對齊，指出還缺哪份證據。');
    const ai = add(messages, 'div', 'chat-line ai');
    const avatar = add(ai, 'img', 'chat-avatar'); avatar.src = '/assets/avatars/claude-thinking.webp'; avatar.alt = 'AI'; avatar.decoding = 'async';
    const bubble = add(ai, 'div', 'chat-message assistant'); add(bubble, 'small', '', 'AI · 推理摘要');
    const md = add(bubble, 'div', 'md');
    add(md, 'p', '', '兩個強證據相差 5 分鐘：目擊紀錄為 22:14，車牌掃描為 22:19。我會先維持「高度可能」而不是直接建立人物關係。');
    add(md, 'p', '', '可先用這段查詢找出時間窗內的來源：');
    const pre = add(md, 'pre', ''); const code = add(pre, 'code', '');
    code.textContent = "const anchors = timeline.filter(item =>\n  item.time >= '22:14' && item.time <= '22:19'\n);\nreturn anchors.map(({source, time}) => ({source, time}));";
    const user2 = add(messages, 'div', 'chat-line user');
    add(user2, 'div', 'chat-message user', '如果只有一份錄影，哪個角度最有用？');
    const ai2 = add(messages, 'div', 'chat-line ai');
    const avatar2 = add(ai2, 'img', 'chat-avatar'); avatar2.src = '/assets/avatars/claude-thinking.webp'; avatar2.alt = 'AI'; avatar2.decoding = 'async';
    const bubble2 = add(ai2, 'div', 'chat-message assistant'); add(bubble2, 'small', '', 'AI · 建議');
    add(add(bubble2, 'div', 'md'), 'p', '', '優先找 3 號門朝外的原始錄影，它同時涵蓋車牌、車頭方向與時間戳。');

    $('#chat-input').disabled = false; $('#chat-send').disabled = false;
    $('#chat-input').value = ''; $('#chat-status').textContent = '';
  });
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1728}});
    await page.goto(PAGE); await ready(page);
    assert.equal(await page.locator('#sidebar .theme-picker, #sidebar #theme').count(), 0);
    assert.equal(await page.locator('#sidebar > .side-panel').count(), 6);
    for (const theme of themes) {
      await page.evaluate(themeName => setTheme(themeName), theme);
      await fillVisualFixture(page);
      const file = path.join(OUT, `${theme}.png`);
      await page.locator('#sidebar').screenshot({path: file});
      assert.equal(await page.locator('#sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 360);
      for (const width of [300, 480]) {
        await page.evaluate(value => setSidebarWidth(value), width);
        assert.deepEqual(await page.locator('#sidebar, #sidebar > .side-panel').evaluateAll(elements => elements.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.id)), [], `P17 ${theme} ${width}px sidebar has no horizontal overflow`);
      }
      await page.evaluate(() => setSidebarWidth(360));
      console.log(`PASS P17 ${themeLabels[theme]} 360px sidebar screenshot`);
    }
    const images = themes.flatMap(theme => [
      path.join(__dirname, '..', 'test-results', 'ai-sidebar', 'shots', `mock-2-${theme}.png`),
      path.join(OUT, `${theme}.png`),
    ]);
    execFileSync('magick', ['montage', ...images, '-tile', '2x6', '-geometry', '360x+4+4', '-background', '#111820', path.join(OUT, 'compare.png')], {stdio: 'ignore'});
    assert.ok(fs.statSync(path.join(OUT, 'compare.png')).size > 0);
    console.log('PASS P17 mock-2 references and implementation screenshots are arranged side by side');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
