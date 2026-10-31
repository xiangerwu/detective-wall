# 第三方依賴

本專案不把第三方程式碼、Node.js、瀏覽器或 `node_modules` 打包進發布檔。版本與授權如下。

| 套件 | 版本 | SPDX 授權 | 著作權人 | 使用方式 |
| --- | --- | --- | --- | --- |
| marked | 12.0.2 | MIT | Christopher Jeffrey | Markdown CDN |
| DOMPurify | 3.1.6 | MPL-2.0 OR Apache-2.0 | Cure53 and contributors | Markdown HTML 清理 CDN |
| Playwright Core | 1.60.0 | Apache-2.0 | Microsoft Corporation | 開發測試依賴 |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | Anthropic PBC and contributors | MCP stdio server |
| zod | 4.6.7 | MIT | Colin McDonnell and contributors | MCP 工具輸入驗證 |
| Cork004 | — | CC0 1.0 | ambientCG | 軟木主題貼圖；https://ambientcg.com/view?id=Cork004 |

直接依賴的版本以 `package.json`／`package-lock.json` 為準，CDN 資源使用上表固定版本與 SRI。間接依賴的授權可由 `package-lock.json` 查到；目前全部為寬鬆授權（MIT／ISC／BSD／Apache-2.0）。發布前仍應依各套件隨附的授權文字與版本重新核對。
