'use strict';

// A one-shot, local-only, bearer-authenticated channel. The native browser
// preload is the only intended client; never forward ChatGPT cookies or tokens.
const http = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {normalizeChatgptProjectUrl, resolveChatgptReviewProjectUrl} = require('../codex/chatgpt_project');

const ADDRESS = '127.0.0.1';
const MAX_INPUT = 60000;
const MAX_REPLY = 120000;
const DEFAULT_TIMEOUT_MS = 180000;

// Quoted Markdown is source material, not prose the assistant may revise.
// Include unmarked lazy continuation lines until a blank or a new block starts.
function blockquoteLines(body) {
  const lines = body.split('\n');
  const quoted = [];
  let inside = false;
  for (const line of lines) {
    const text = line.replace(/\r$/, '');
    if (/^[ \t]*>/.test(text)) inside = true;
    else if (!text.trim() || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d+[.)][ \t]|`{3,}|~{3,})/.test(text)) inside = false;
    if (inside) quoted.push(line);
  }
  return quoted;
}

function blockquotesUnchanged(original, corrected) {
  return JSON.stringify(blockquoteLines(original)) === JSON.stringify(blockquoteLines(corrected));
}

function validDraft(draft) {
  return draft && typeof draft === 'object'
    && typeof draft.title === 'string' && draft.title.length <= 512
    && typeof draft.body === 'string' && draft.body.length > 0
    && draft.body.length <= MAX_INPUT && !draft.body.includes('\0')
    && !draft.title.includes('\0');
}

function validReply(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.status === 'error') return typeof value.error === 'string'
    && value.error.length <= 500 && !value.error.includes('\0');
  const result = value.result;
  return value.status === 'complete' && result && typeof result === 'object'
    && !Array.isArray(result) && typeof result.title === 'string'
    && result.title.length <= 512 && typeof result.body === 'string'
    && result.body.length <= MAX_INPUT && !result.body.includes('\0')
    && !result.title.includes('\0');
}

async function startNativeSpellcheckBridge(draft, {
  timeoutMs = DEFAULT_TIMEOUT_MS, projectUrl = '', mode = 'spellcheck'
} = {}) {
  if (!['spellcheck', 'commit-title'].includes(mode)) throw new Error('Unsupported ChatGPT review mode.');
  if (!validDraft(draft)) throw new Error('The spellcheck draft must have a nonempty, bounded body.');
  // Invalid configured projects never silently downgrade to a general chat.
  const destination = normalizeChatgptProjectUrl(projectUrl) || 'https://chatgpt.com/';
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('Invalid spellcheck session timeout.');
  }
  const ticket = randomBytes(32).toString('hex');
  const expected = Buffer.from(ticket, 'ascii');
  let resolveCompletion, rejectCompletion, settled = false, claimed = false;
  const completed = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A launch that fails before awaiting the result must not leave a rejected
  // Promise with no handler.
  void completed.catch(() => {});
  let server, timer;
  function finish(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server?.close();
    if (error) rejectCompletion(error);
    else resolveCompletion(value);
  }
  function reply(res, status, value) {
    if (res.headersSent) return;
    const text = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(text)
    });
    res.end(text);
  }
  server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    if (!port || req.headers.host !== ADDRESS + ':' + port
        || req.headers.origin !== undefined
        || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      reply(res, 403, {error: 'Forbidden'});
      return;
    }
    const candidate = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : '';
    const supplied = Buffer.from(candidate, 'ascii');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(res, 401, {error: 'Unauthorized'});
      return;
    }
    if (settled) {
      reply(res, 410, {error: 'Session expired'});
      return;
    }
    if (req.method === 'GET' && req.url === '/job') {
      if (claimed) { reply(res, 409, {error: 'Already claimed'}); return; }
      claimed = true;
      reply(res, 200, {title: draft.title, body: draft.body,
        ...(mode === 'commit-title' ? {mode} : {})});
      return;
    }
    if (req.method === 'POST' && req.url === '/result') {
      if (!claimed) { reply(res, 409, {error: 'Not claimed'}); return; }
      if (!/application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        reply(res, 415, {error: 'Expected JSON'}); return;
      }
      let chunks = [], size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_REPLY) throw new Error('Oversized response');
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!validReply(value)) throw new Error('Invalid response shape');
        if (value.status === 'complete' && mode === 'spellcheck'
            && !blockquotesUnchanged(draft.body, value.result.body)) {
          reply(res, 422, {error: 'Spellcheck changed a protected Markdown blockquote'});
          return;
        }
        if (value.status === 'complete' && mode === 'commit-title'
            && (value.result.body !== '' || !value.result.title.trim()
              || value.result.title.length > 72
              || /[\r\n\x00-\x1f]/.test(value.result.title))) {
          reply(res, 422, {error: 'Invalid ChatGPT commit-title suggestion'});
          return;
        }
        reply(res, 200, {ok: true});
        if (value.status === 'error') finish(new Error('ChatGPT Spellcheck Only: ' + value.error));
        else finish(null, value.result);
      } catch {
        reply(res, 400, {error: 'Invalid response'});
      }
      return;
    }
    reply(res, 404, {error: 'Not found'});
  });
  // A failed bind must reject rather than leave an unreachable pending job.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, ADDRESS, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const port = server.address().port;
  timer = setTimeout(() => finish(new Error('Native Spellcheck Only timed out.')), timeoutMs);
  const hash = new URLSearchParams({
    sweetiebot_spellcheck: '1', port: String(port), ticket,
    ...(mode === 'commit-title' ? {mode} : {})
  });
  return {
    url: destination + '#' + hash.toString(),
    completed,
    cancel() { finish(new Error('Native Spellcheck Only was cancelled.')); }
  };
}

function registerNativeSpellcheckBridge(vscode, context, start = startNativeSpellcheckBridge) {
  const active = new Set();
  const command = vscode.commands.registerCommand('sweetiebot.spellcheckWithChatGPT', async input => {
    // No automatic uploads: this explicit command is the consent boundary.
    const body = typeof input === 'string' ? input : await vscode.window.showInputBox({
      prompt: 'Text to send to ChatGPT Spellcheck Only for review (not applied automatically)',
      ignoreFocusOut: true
    });
    if (!body) return null;
    const registered = await vscode.commands.getCommands(true);
    if (!registered.includes('workbench.action.browser.open')) {
      throw new Error('This VS Code build does not have the native Integrated Browser.');
    }
    const projectUrl = resolveChatgptReviewProjectUrl(vscode.workspace.getConfiguration?.('scmToolkit'));
    const session = await start({title: '', body}, {projectUrl});
    active.add(session);
    try {
      await vscode.commands.executeCommand('workbench.action.browser.open', {
        url: session.url, openToSide: false, reuseUrlFilter: session.url
      });
      const result = await session.completed;
      const editor = await vscode.workspace.openTextDocument({
        language: 'markdown', content: result.body
      });
      await vscode.window.showTextDocument(editor, {preview: true});
      return result;
    } catch (error) {
      session.cancel();
      throw error;
    } finally {
      active.delete(session);
    }
  });
  context.subscriptions.push(command, {
    dispose() { for (const session of active) session.cancel(); active.clear(); }
  });
}

module.exports = {
  startNativeSpellcheckBridge, registerNativeSpellcheckBridge,
  validDraft, validReply, blockquotesUnchanged
};
