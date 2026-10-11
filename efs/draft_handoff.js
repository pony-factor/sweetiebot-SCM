'use strict';
const { createServer } = require('node:http');

// Keep browser-generated draft text on this machine, outside remote redirect URLs.
async function createDraftHandoff(publish) {
  const page = `<!doctype html><meta charset="utf-8"><title>Publish with Codex Pony</title>
<style>body{font:16px system-ui;max-width:800px;margin:40px auto;padding:20px}pre{white-space:pre-wrap}button{font:inherit;padding:12px}</style>
<h1>🦄 Publish with Codex Pony</h1><h2 id="title"></h2><pre id="body"></pre>
<button id="publish">Publish pull request</button><p id="status"></p>
<script>
const draft = new URLSearchParams(location.hash.slice(1));
const title = draft.get('title'), body = draft.get('body');
history.replaceState(null, '', location.pathname);
document.getElementById('title').textContent = title || '';
document.getElementById('body').textContent = body || '';
const button = document.getElementById('publish'), status = document.getElementById('status');
button.disabled = !title || !body;
button.onclick = async () => {
 button.disabled = true; status.textContent = 'Publishing with codex-pony…';
 try {
  const response = await fetch(location.pathname, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  status.textContent = '🦄 Codex Pony opened PR #' + result.number;
  const link = document.createElement('a'); link.href = result.url; link.textContent = 'Open pull request'; status.append(document.createElement('br'),link);
 } catch (error) { status.textContent = error.message; }
};
</script>`;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (code, error) => { response.writeHead(code, {'Content-Type':'application/json'}); response.end(JSON.stringify({error})); };
    if (request.headers.host !== new URL(origin).host || !/^\/kefania-draft\/[0-9a-f-]{36}$/.test(request.url)) return fail(404, 'Unknown draft.');
    if (request.method === 'GET') { response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(page); return; }
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return fail(403, 'Open the local draft page to publish.');
    try {
      let input = '';
      for await (const chunk of request) { input += chunk; if (input.length > 100000) return fail(413, 'Draft exceeds the size limit.'); }
      const {title, body} = JSON.parse(input);
      if (typeof title !== 'string' || typeof body !== 'string') return fail(400, 'Invalid draft.');
      const result = await publish({path:request.url, query:new URLSearchParams({title,body}).toString()});
      if (!result?.url) return fail(409, 'Draft was expired, already used, or could not be published. Check the VS Code notification.');
      response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify(result));
    } catch { fail(400, 'Draft could not be published. Check the VS Code notification before retrying.'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  server.unref();
  const expiry = setTimeout(() => server.close(), 3600000);
  expiry.unref();
  return {origin:`http://127.0.0.1:${server.address().port}`,dispose(){clearTimeout(expiry);server.close();}};
}
module.exports = {createDraftHandoff};
