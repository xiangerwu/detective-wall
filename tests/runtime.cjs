const path = require('node:path');

const debug = path.join(__dirname, '..', 'src-tauri', 'target', 'debug');
const extension = process.platform === 'win32' ? '.exe' : '';
const serverBin = process.env.CASEGRAPH_SERVER_BIN || path.join(debug, 'casegraph-server' + extension);
const mcpBin = process.env.CASEGRAPH_MCP_BIN || path.join(debug, 'casegraph-mcp' + extension);

module.exports = {serverBin, mcpBin};
