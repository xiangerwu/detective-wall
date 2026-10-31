const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const playwright = require('playwright-core');
const {openSidebar} = require('./wall-ready.cjs');

const out = process.env.WALL_TEST_OUT;
const base = process.env.WALL_TEST_URL;
const db = path.join(process.env.TEMP, 'wall.db');
const fakeLog = process.env.WALL_FAKE_CLI_LOG;

function request(pathname, method = 'GET', value, originBase = base) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, originBase), body = value === undefined ? '' : JSON.stringify(value);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function records() {
  return fs.existsSync(fakeLog)
    ? fs.readFileSync(fakeLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function configFromArgs(args) {
  return JSON.parse(argValue(args, '--mcp-config'));
}

function startServer(dbPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: {...process.env, ...env, WALL_DB: dbPath, WALL_PORT: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timer;
    const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/WALL_READY (\d+)/);
      if (match) done(null, {child, url: 'http://127.0.0.1:' + match[1]});
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', done);
    child.once('exit', code => done(new Error('wall server exited before ready: ' + code)));
    timer = setTimeout(() => done(new Error('wall server did not start')), 30000);
  });
}

function stopServer(server) {
  return new Promise(resolve => {
    if (server.child.exitCode != null) return resolve();
    server.child.once('exit', resolve);
    server.child.kill();
  });
}

const wall = {bands: [], tags: [], cards: [{id: 'chat-card', kind: 'card', x: 20, y: 20, title: 'Chat card', note: '', tags: [], links: []}], edges: []};

(async () => {
  assert.ok(process.env.WALL_CLAUDE_BIN?.endsWith('fake-chat-cli.js'));
  assert.ok(process.env.WALL_CODEX_BIN?.endsWith('fake-chat-cli.js'));
  let response = await request('/api/walls/chat-wall', 'PUT', {id: 'chat-wall', name: 'Chat wall &|^', data: wall, version: null});
  assert.equal(response.status, 200);

  response = await request('/api/chat/clients');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.clients.map(client => [client.id, client.available]), [['claude', true], ['codex', true]]);
  console.log('PASS chat client discovery uses fake CLI overrides without running a model');

  response = await request('/api/chat/chat-wall?client=claude');
  assert.equal(response.status, 200);
  assert.equal(response.body.sessionId, null);
  assert.deepEqual(response.body.messages, []);

  const special = '引號 "雙引號"' + '\n換行 &|^';
  response = await request('/api/chat/chat-wall', 'POST', {client: 'claude', message: special});
  assert.equal(response.status, 200);
  assert.match(response.body.reply, /claude fake reply/);
  let log = records().at(-1);
  assert.equal(log.client, 'claude');
  assert.equal(log.stdin, special);
  assert.equal(log.args.includes('--resume'), false);
  assert.equal(log.args.includes('--strict-mcp-config'), true);
  assert.equal(argValue(log.args, '--output-format'), 'stream-json');
  assert.equal(log.args.includes('--verbose'), true);
  assert.equal(argValue(log.args, '--allowedTools'), 'mcp__detective-wall__*');
  assert.match(argValue(log.args, '--disallowedTools'), /Bash/);
  assert.match(argValue(log.args, '--disallowedTools'), /Read/);
  assert.match(argValue(log.args, '--disallowedTools'), /Edit/);
  assert.match(argValue(log.args, '--disallowedTools'), /Write/);
  assert.match(argValue(log.args, '--disallowedTools'), /WebFetch/);
  assert.equal(log.args.includes('--restricted'), true);
  assert.equal(log.args.includes('--tools='), true);
  assert.equal(argValue(log.args, '--permission-mode'), 'dontAsk');
  assert.equal(argValue(log.args, '--permission-prompts'), 'none');
  const claudeConfig = configFromArgs(log.args).mcpServers['detective-wall'];
  assert.equal(path.resolve(claudeConfig.env.WALL_DB), path.resolve(db));
  assert.equal(claudeConfig.env.WALL_PORT, new URL(base).port);
  assert.equal(claudeConfig.env.WALL_MCP_WALLS, 'chat-wall');
  assert.match(claudeConfig.args[0], /server[\\/\\\\]mcp\.js$/);
  assert.match(argValue(log.args, '--append-system-prompt'), /chat-wall/);
  assert.match(argValue(log.args, '--append-system-prompt'), /Chat wall/);
  assert.equal(log.args.includes('--fork-session'), false);
  const claudeSession = response.body.sessionId;
  console.log('PASS Claude stdin, MCP config, strict config, tool allow/deny and permission flags are enforced');

  response = await request('/api/chat/chat-wall', 'POST', {client: 'claude', message: 'second'});
  assert.equal(response.status, 200);
  log = records().at(-1);
  assert.equal(argValue(log.args, '--resume'), claudeSession);
  assert.equal(log.stdin, 'second');
  let history = (await request('/api/chat/chat-wall?client=claude')).body;
  assert.equal(history.sessionId, claudeSession);
  assert.deepEqual(history.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  console.log('PASS Claude resumes the same wall/client conversation and persists history');

  response = await request('/api/chat/chat-wall/reset', 'POST', {client: 'claude'});
  assert.equal(response.status, 200);
  assert.equal(response.body.sessionId, null);
  assert.deepEqual(response.body.messages, []);
  await request('/api/chat/chat-wall', 'POST', {client: 'claude', message: 'after reset'});
  log = records().at(-1);
  assert.equal(log.args.includes('--resume'), false);
  console.log('PASS reset starts Claude without the previous session id');

  response = await request('/api/chat/chat-wall', 'POST', {client: 'codex', message: special});
  assert.equal(response.status, 200);
  log = records().at(-1);
  assert.equal(log.client, 'codex');
  assert.equal(log.stdin, special);
  assert.equal(log.args.includes('resume'), false);
  assert.equal(argValue(log.args, '--disable'), 'shell_tool');
  assert.equal(log.args.includes('--json'), true);
  assert.equal(log.args.includes('--approve-for-me'), true);
  assert.equal(log.args.includes('--ignore-user-config'), true);
  assert.equal(log.args.includes('--skip-git-repo-check'), true);
  assert.equal(log.args.includes('-s'), false);
  assert.equal(log.args.includes('--sandbox'), false);
  assert.equal(path.basename(log.cwd), 'chat-workdir');
  assert.equal(path.dirname(log.cwd), path.dirname(db));
  assert.deepEqual(fs.readdirSync(log.cwd), []);
  const overrides = log.args.filter(arg => arg.startsWith('mcp_servers.detective-wall.'));
  assert.ok(overrides.some(arg => arg.startsWith('mcp_servers.detective-wall.command=')));
  assert.ok(overrides.some(arg => arg.startsWith('mcp_servers.detective-wall.args=')));
  const envOverride = overrides.find(arg => arg.startsWith('mcp_servers.detective-wall.env='));
  assert.match(envOverride, /WALL_DB/);
  assert.match(envOverride, /WALL_PORT/);
  assert.match(log.args.find(arg => arg.startsWith('developer_instructions=')), /chat-wall/);
  const codexSession = response.body.sessionId;
  console.log('PASS codex stdin, MCP -c overrides, disabled shell feature, approval and empty cwd are enforced');

  response = await request('/api/chat/chat-wall', 'POST', {client: 'codex', message: 'codex second'});
  assert.equal(response.status, 200);
  log = records().at(-1);
  assert.equal(argValue(log.args, '--disable'), 'shell_tool');
  assert.equal(log.args.includes('resume'), true);
  assert.equal(log.args.includes(codexSession), true);
  // --approve-for-me is an exec option, so it must come before the resume subcommand.
  assert.ok(log.args.indexOf('--approve-for-me') > -1 && log.args.indexOf('--approve-for-me') < log.args.indexOf('resume'));
  assert.equal(log.args.includes('--skip-git-repo-check'), true);
  console.log('PASS codex resumes its own conversation without sharing Claude state');

  const timeoutRequest = request('/api/chat/chat-wall', 'POST', {client: 'claude', message: 'timeout'});
  await sleep(30);
  response = await request('/api/chat/chat-wall', 'POST', {client: 'claude', message: 'busy'});
  assert.equal(response.status, 409);
  response = await timeoutRequest;
  assert.equal(response.status, 504);
  assert.match(response.body.error, /逾時/);
  await sleep(100);
  const heartbeat = process.env.WALL_FAKE_HEARTBEAT;
  const heartbeatSize = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
  await sleep(100);
  assert.equal(fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0, heartbeatSize);
  console.log('PASS one run per wall returns 409 and timeout kills the fake CLI process tree');

  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(base + '/#wall=chat-wall');
    await page.waitForFunction(() => window.wallReady === true);
    await openSidebar(page);
    await page.waitForFunction(() => document.querySelector('#chat-client')?.options.length === 2);
    await page.selectOption('#chat-client', 'claude');
    await page.click('#chat-new');
    await page.waitForFunction(() => document.querySelectorAll('#chat-messages .chat-message').length === 0);
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/claude-body-sleep\.png$/);
    assert.ok(await page.locator('#chat-mascot').evaluate(img => img.complete && img.naturalWidth > 0));
    await page.fill('#chat-input', 'warmup');
    await page.click('#chat-send');
    await page.waitForFunction(() => document.querySelector('#chat-progress')?.hidden
      && [...document.querySelectorAll('#chat-messages .chat-message')].some(row => row.textContent.includes('warmup')));
    await page.fill('#chat-input', 'UI message');
    await page.click('#chat-send');
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-messages .chat-message')].some(row => row.textContent.includes('UI message')));
    await page.waitForFunction(() => document.querySelector('#chat-progress')?.hidden
      && document.querySelector('#chat-mascot')?.getAttribute('src').endsWith('/assets/avatars/claude-body-happy.png'));
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/claude-body-happy\.png$/);
    const claudeAvatars = page.locator('#chat-messages .chat-line.ai .chat-avatar');
    assert.ok(await claudeAvatars.count() >= 2);
    assert.match(await claudeAvatars.first().getAttribute('src'), /\/assets\/avatars\/claude-idle\.png$/);
    assert.match(await claudeAvatars.last().getAttribute('src'), /\/assets\/avatars\/claude-happy\.png$/);
    assert.equal(await claudeAvatars.last().getAttribute('alt'), '');
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-messages .chat-avatar')].every(img => img.complete && img.naturalWidth === 128));
    await page.reload();
    await page.waitForFunction(() => window.wallReady === true);
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-messages .chat-message')].some(row => row.textContent.includes('UI message')));
    await page.fill('#chat-input', 'fail');
    await page.click('#chat-send');
    await page.waitForFunction(() => document.querySelector('#chat-status.error')?.textContent.includes('fake CLI failure'));
    await page.waitForFunction(() => document.querySelector('#chat-progress')?.hidden
      && document.querySelector('#chat-mascot')?.getAttribute('src').endsWith('/assets/avatars/claude-body-sweat.png'));
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/claude-body-sweat\.png$/);
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-messages .chat-line.ai .chat-avatar')].at(-1)?.getAttribute('src').endsWith('/assets/avatars/claude-sweat.png'));
    await page.fill('#chat-input', 'progress sleep');
    await page.click('#chat-send');
    await page.waitForFunction(() => document.querySelectorAll('#chat-progress-list li').length >= 3);
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/claude-body-thinking\.png$/);
    assert.ok(await page.locator('#chat-mascot').evaluate(img => img.complete && img.naturalWidth > 0));
    assert.match(await page.locator('#chat-progress-avatar').getAttribute('src'), /\/assets\/avatars\/claude-thinking\.png$/);
    assert.deepEqual(await page.locator('#chat-progress-list li').allTextContents(), [
      '讀取 README.md', '搜尋卡片：方法', '送出提案（41 項）',
    ]);
    await page.screenshot({path: path.join(out, 'chat-progress.png')});
    await page.waitForFunction(() => document.querySelector('#chat-progress').hidden);
    await page.selectOption('#chat-client', 'codex');
    await page.waitForFunction(() => document.querySelector('#chat-mascot')?.getAttribute('src').includes('/assets/avatars/codex-body-'));
    await page.fill('#chat-input', 'progress sleep');
    await page.click('#chat-send');
    await page.waitForFunction(() => document.querySelectorAll('#chat-progress-list li').length >= 3);
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/codex-body-thinking\.png$/);
    assert.match(await page.locator('#chat-progress-avatar').getAttribute('src'), /\/assets\/avatars\/codex-thinking\.png$/);
    assert.deepEqual(await page.locator('#chat-progress-list li').allTextContents(), [
      '讀取 README.md', '搜尋卡片：方法', '送出提案（41 項）',
    ]);
    await page.waitForFunction(() => document.querySelector('#chat-progress').hidden);
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/codex-body-happy\.png$/);
    assert.match(await page.locator('#chat-messages .chat-line.ai .chat-avatar').last().getAttribute('src'), /\/assets\/avatars\/codex-happy\.png$/);
    await page.selectOption('#chat-client', 'claude');

    await page.fill('#chat-input', 'stop');
    await page.click('#chat-send');
    await page.waitForFunction(() => document.querySelectorAll('#chat-progress-list li').length >= 3);
    await page.click('#chat-stop');
    await page.waitForFunction(() => document.querySelector('#chat-status')?.textContent === '已停止');
    await page.waitForFunction(() => document.querySelector('#chat-mascot')?.getAttribute('src').endsWith('/assets/avatars/claude-body-sweat.png'));
    assert.match(await page.locator('#chat-mascot').getAttribute('src'), /\/assets\/avatars\/claude-body-sweat\.png$/);
    const stoppedHistory = (await request('/api/chat/chat-wall?client=claude')).body;
    assert.equal(stoppedHistory.messages.at(-1).status, 'stopped');
    console.log('PASS UI streams mapped tool progress, captures a progress screenshot, and stops with persisted status');
    console.log('PASS UI shows chat replies and CLI errors, and history survives reload');
  } finally {
    await browser.close();
  }

  const missing = await startServer(path.join(out, 'temp', 'missing', 'wall.db'), {  // under temp, so each run starts empty
    WALL_CLAUDE_BIN: path.join(out, 'missing-claude.exe'),
    WALL_CODEX_BIN: path.join(out, 'missing-codex.exe'),
  });
  try {
    response = await request('/api/chat/clients', 'GET', undefined, missing.url);
    assert.ok(response.body.clients.every(client => client.available === false));
    response = await request('/api/walls/missing-wall', 'PUT', {id: 'missing-wall', name: 'Missing', data: wall, version: null}, missing.url);
    assert.equal(response.status, 200);
    response = await request('/api/chat/missing-wall', 'POST', {client: 'claude', message: 'hello'}, missing.url);
    assert.equal(response.status, 503);
    assert.match(response.body.error, /無法使用/);
    console.log('PASS missing CLI is reported as unavailable without spawning a model');
  } finally {
    await stopServer(missing);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
