const fs = require('node:fs');
const {spawn} = require('node:child_process');

const args = process.argv.slice(2);
const client = args.includes('exec') ? 'codex' : 'claude';
const logPath = process.env.WALL_FAKE_CLI_LOG;
let input = '';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const records = logPath && fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : [];
  const resumeAt = args.indexOf('--resume');
  const resumeCommand = args.indexOf('resume');
  const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : resumeCommand >= 0 ? args.at(-2) : null;
  const sessionId = resumeId || client + '-session-' + (records.filter(row => row.client === client).length + 1);
  const record = {client, args, cwd: process.cwd(), stdin: input, sessionId, pid: process.pid};
  if (input.includes('timeout')) {
    const child = spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync(process.env.WALL_FAKE_HEARTBEAT, 'x'), 20)"], {
      stdio: 'ignore', env: {...process.env, WALL_FAKE_HEARTBEAT: process.env.WALL_FAKE_HEARTBEAT},
    });
    record.childPid = child.pid;
  }
  if (input.includes('stop')) {
    const child = spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync(process.env.WALL_FAKE_HEARTBEAT, 's'), 20)"], {
      stdio: 'ignore', env: {...process.env, WALL_FAKE_HEARTBEAT: process.env.WALL_FAKE_HEARTBEAT},
    });
    record.childPid = child.pid;
  }
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  if (input.includes('fail')) {
    process.stderr.write('fake CLI failure');
    process.exitCode = 9;
    return;
  }
  if (input.includes('progress') || input.includes('stop')) {
    if (client === 'claude') {
      emit({type: 'assistant', message: {content: [{type: 'tool_use', name: 'read_file', input: {path: 'README.md'}}]}});
      emit({type: 'assistant', message: {content: [{type: 'tool_use', name: 'search_cards', input: {query: '方法'}}]}});
      emit({type: 'assistant', message: {content: [{type: 'tool_use', name: 'propose_changes', input: {ops: Array.from({length: 41})}}]}});
    } else {
      // Same shape as codex-cli 0.153.4: `tool` + object `arguments`, and each call repeated as item.completed.
      for (const [tool, args] of [['read_file', {path: 'README.md'}], ['search_cards', {query: '方法'}], ['propose_changes', {ops: Array.from({length: 41})}]]) {
        emit({type: 'item.started', item: {type: 'mcp_tool_call', server: 'detective-wall', tool, arguments: args, status: 'in_progress'}});
        emit({type: 'item.completed', item: {type: 'mcp_tool_call', server: 'detective-wall', tool, arguments: args, status: 'completed'}});
      }
    }
  }
  if (input.includes('timeout') || input.includes('stop')) {
    setInterval(() => {}, 1000);
    return;
  }
  const reply = client + ' fake reply: ' + input;
  const finish = () => {
    if (client === 'claude') {
      emit({type: 'result', session_id: sessionId, result: reply});
    } else {
      emit({type: 'thread.started', thread_id: sessionId});
      emit({type: 'item.completed', item: {type: 'agent_message', text: reply}});
    }
  };
  const delay = input.includes('sleep') ? 1000 : 0;
  delay ? setTimeout(finish, delay) : finish();
});
