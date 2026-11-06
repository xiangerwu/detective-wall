// End-to-end checks against the Rust server, using the existing fake CLI and picker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const executable = process.env.CASEGRAPH_TEST_SERVER || path.join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'casegraph-server.exe' : 'casegraph-server');
assert.ok(fs.existsSync(executable), 'build casegraph-server before running this test');
const out = path.resolve(process.env.WALL_TEST_OUT || path.join(root, 'test-results', 'rust-chat'));
fs.mkdirSync(out, {recursive: true});
const run = fs.mkdtempSync(path.join(out, 'run-'));
const dbPath = path.join(run, 'wall.db');
const cliLog = path.join(run, 'cli.jsonl');
const heartbeat = path.join(run, 'heartbeat');
const pickedPath = path.join(run, "選取 folder's");
const executionLog = path.join(run, 'execution.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = message => { console.log('PASS ' + message); fs.appendFileSync(executionLog, 'PASS ' + message + '\n'); };
const records = () => fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const argument = (args, key) => args[args.indexOf(key) + 1];
let server;

function request(pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request(new URL(pathname, server.url), {method,
      headers: value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({status: res.statusCode, body: text ? JSON.parse(text) : null}); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function until(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error('Timed out: ' + description);
}

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {cwd: root, windowsHide: true,
      env: {...process.env, WALL_DB: dbPath, WALL_PORT: '0',
        WALL_CLAUDE_BIN: path.join(__dirname, 'fake-chat-cli.js'), WALL_CODEX_BIN: path.join(__dirname, 'fake-chat-cli.js'),
        WALL_FAKE_CLI_LOG: cliLog, WALL_FAKE_HEARTBEAT: heartbeat, WALL_CHAT_TIMEOUT_MS: '3000',
        WALL_PICK_FOLDER_BIN: path.join(__dirname, 'fake-pick-folder.js'), WALL_FAKE_PICK_FOLDER_PATH: pickedPath,
        WALL_FAKE_PICK_FOLDER_MODE: 'busy', WALL_FAKE_PICK_FOLDER_DELAY_MS: '350', ...extraEnv},
      stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', settled = false;
    const timer = setTimeout(() => finish(new Error('server did not start: ' + output)), 15000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    child.stdout.on('data', chunk => {
      output += chunk;
      fs.appendFileSync(path.join(run, 'server.log'), chunk);
      const match = output.match(/WALL_READY (\d+)/);
      if (match) finish(null, {child, url: 'http://127.0.0.1:' + match[1]});
    });
    child.stderr.on('data', chunk => { output += chunk; fs.appendFileSync(path.join(run, 'server.log'), chunk); });
    child.once('error', finish);
    child.once('exit', code => finish(new Error('server exited before ready: ' + code + '\n' + output)));
  });
}

async function stopServer() {
  if (!server || server.child.exitCode !== null) return;
  await request('/api/chat/chat-wall/stop', 'POST').catch(() => {});
  const child = server.child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function subscribe(client) {
  const events = [];
  let response, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const ready = new Promise((resolve, reject) => {
    const req = http.get(new URL('/api/chat/chat-wall/events?client=' + client, server.url), res => {
      response = res;
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end).replaceAll('\r', '');
          buffer = buffer.slice(end + 2);
          const event = block.match(/^event:\s*(.*)$/m)?.[1];
          const data = block.match(/^data:\s*(.*)$/m)?.[1];
          if (event && data) {
            events.push({event, value: JSON.parse(data)});
            if (event === 'ready') resolve();
          }
        }
      });
      res.once('end', finish);
      res.once('close', finish);
      res.once('error', error => { reject(error); finish(); });
    });
    req.once('error', error => { reject(error); finish(); });
  });
  return {events, ready, done, close: () => response?.destroy()};
}

(async () => {
  server = await startServer();
  try {
    const wall = {bands: [], tags: [], cards: [{id: 'c1', kind: 'card', x: 20, y: 20, title: '案件', note: '', tags: [], links: []}], edges: []};
    assert.equal((await request('/api/walls/chat-wall', 'PUT', {id:'chat-wall',name:'Chat wall &|^',data:wall,version:null})).status, 200);
    const available = (await request('/api/chat/clients')).body;
    assert.deepEqual(available.clients.map(client => [client.id,client.available]), [['claude',true],['codex',true]]);
    const special = "訊息 ' \" $() ; & | ^\n第二行";
    let lastSessions = {};
    for (const client of ['claude', 'codex']) {
      const first = await request('/api/chat/chat-wall','POST',{client,message:special});
      assert.equal(first.status,200,JSON.stringify(first.body));
      assert.equal(first.body.reply,client + ' fake reply: ' + special);
      let log = records().at(-1);
      assert.equal(log.stdin,special);
      assert.equal(path.resolve(log.cwd),path.join(run,'chat-workdir'));
      assert.deepEqual(fs.readdirSync(log.cwd),[]);
      if (process.platform === 'win32') {
        assert.equal(log.execArgv[0],'-r');
        assert.equal(path.basename(log.execArgv[1]),'hidden-console.js');
      }
      if (client === 'claude') {
        const config = JSON.parse(argument(log.args,'--mcp-config')).mcpServers['detective-wall'];
        assert.equal(path.basename(config.command),process.platform === 'win32' ? 'casegraph-mcp.exe' : 'casegraph-mcp');
        assert.deepEqual(config.args,[]);
        assert.equal(config.env.WALL_DB,dbPath);
        assert.equal(config.env.WALL_MCP_WALLS,'chat-wall');
        assert.ok(log.args.includes('--strict-mcp-config') && log.args.includes('--restricted') && log.args.includes('--tools='));
        assert.equal(argument(log.args,'--allowedTools'),'mcp__detective-wall__*');
        assert.equal(argument(log.args,'--permission-mode'),'dontAsk');
      } else {
        assert.equal(argument(log.args,'--disable'),'shell_tool');
        assert.ok(log.args.includes('--ignore-user-config') && log.args.includes('--skip-git-repo-check'));
        assert.ok(log.args.some(arg => arg.startsWith('mcp_servers.detective-wall.env=') && arg.includes('WALL_MCP_WALLS="chat-wall"')));
      }
      const second = await request('/api/chat/chat-wall','POST',{client,message:'second'});
      assert.equal(second.status,200,JSON.stringify(second.body));
      assert.equal(second.body.sessionId,first.body.sessionId);
      log = records().at(-1);
      if (client === 'claude') assert.equal(argument(log.args,'--resume'),first.body.sessionId);
      else {
        assert.ok(log.args.indexOf('--approve-for-me') < log.args.indexOf('resume'));
        assert.equal(log.args.at(-2),first.body.sessionId);
      }
      const history = (await request('/api/chat/chat-wall?client=' + client)).body;
      assert.deepEqual(history.messages.map(row => row.role),['user','assistant','user','assistant']);
      assert.equal(history.sessionId,first.body.sessionId);
      lastSessions[client] = first.body.sessionId;
    }
    pass('Claude and Codex preserve stdin, restricted tool/MCP arguments, separate sessions and SQLite history');

    await stopServer();
    server = await startServer();
    for (const client of ['claude','codex']) {
      assert.equal((await request('/api/chat/chat-wall?client=' + client)).body.sessionId,lastSessions[client]);
      const reset = await request('/api/chat/chat-wall/reset','POST',{client});
      assert.equal(reset.status,200);
      assert.equal(reset.body.sessionId,null);
      assert.deepEqual(reset.body.messages,[]);
    }
    await request('/api/chat/chat-wall','POST',{client:'claude',message:'after reset'});
    assert.ok(!records().at(-1).args.includes('--resume'));
    pass('chat sessions survive Rust process restart and reset clears resume/history');

    for (const client of ['claude','codex']) {
      const stream = subscribe(client);
      try {
        await stream.ready;
        const result = await request('/api/chat/chat-wall','POST',{client,message:'progress sleep'});
        assert.equal(result.status,200,JSON.stringify(result.body));
        await stream.done;
        assert.deepEqual(stream.events.filter(row => row.event === 'progress').map(row => row.value.text),['讀取 README.md','搜尋卡片：方法','送出提案（41 項）']);
        assert.ok(stream.events.some(row => row.event === 'started'));
        assert.ok(stream.events.some(row => row.event === 'complete'));
      } finally { stream.close(); }
    }
    pass('SSE delivers mapped progress once, completion, and closes after each client run');

    const stream = subscribe('claude');
    try {
      await stream.ready;
      const pending = request('/api/chat/chat-wall','POST',{client:'claude',message:'stop'});
      await until(() => stream.events.filter(row => row.event === 'progress').length === 3,'stop progress');
      assert.equal((await request('/api/chat/chat-wall','POST',{client:'codex',message:'busy'})).status,409);
      assert.equal((await request('/api/chat/chat-wall/reset','POST',{client:'claude'})).status,409);
      assert.equal((await request('/api/chat/chat-wall/stop?client=codex','POST')).status,409);
      const stopped = await request('/api/chat/chat-wall/stop','POST');
      assert.equal(stopped.status,200);
      assert.equal((await pending).status,499);
      await stream.done;
      assert.ok(stream.events.some(row => row.event === 'stopped'));
      assert.equal((await request('/api/chat/chat-wall?client=claude')).body.messages.at(-1).status,'stopped');
      const before = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
      await sleep(150);
      assert.equal(fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0,before);
    } finally { stream.close(); }
    pass('per-wall busy/reset checks, stop client validation, persisted stopped status and descendant termination');

    const timeout = await request('/api/chat/chat-wall','POST',{client:'claude',message:'timeout'});
    assert.equal(timeout.status,504);
    assert.equal((await request('/api/chat/chat-wall?client=claude')).body.messages.at(-1).status,'timed_out');
    const failure = await request('/api/chat/chat-wall','POST',{client:'claude',message:'fail'});
    assert.equal(failure.status,502);
    assert.match(failure.body.error,/fake CLI failure/);
    assert.equal((await request('/api/chat/chat-wall','POST',{client:'claude',message:'recovered'})).status,200);
    pass('timeout and CLI errors persist and release the wall for the next conversation');

    const disconnectMessage = 'disconnect sleep';
    const payload = JSON.stringify({client:'codex',message:disconnectMessage});
    const disconnected = http.request(new URL('/api/chat/chat-wall',server.url),{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}});
    disconnected.on('error', () => {});
    disconnected.end(payload);
    await until(() => records().some(row => row.stdin === disconnectMessage),'disconnected CLI started');
    disconnected.destroy();
    await until(async () => (await request('/api/chat/chat-wall?client=codex')).body.messages.some(row => row.role === 'assistant' && row.text.includes(disconnectMessage)),'disconnected response persisted');
    assert.equal((await request('/api/chat/chat-wall','POST',{client:'codex',message:'after disconnect'})).status,200);
    pass('HTTP disconnect does not abandon the running CLI, SQLite reply or busy-state cleanup');

    const picker = request('/api/pick-folder','POST');
    await sleep(50);
    assert.equal((await request('/api/pick-folder','POST')).status,409);
    assert.deepEqual((await picker).body,{path:pickedPath});
    await stopServer();
    server = await startServer({WALL_FAKE_PICK_FOLDER_MODE:'cancel'});
    assert.deepEqual((await request('/api/pick-folder','POST')).body,{cancelled:true});
    pass('folder picker override preserves Unicode paths, busy exclusion and cancellation');
  } finally { await stopServer(); }
  console.log('Artifacts: ' + run);
})().catch(error => {
  console.error(error);
  fs.appendFileSync(executionLog,'FAIL ' + error.stack + '\n');
  process.exitCode = 1;
});
