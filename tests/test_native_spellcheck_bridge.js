'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {startNativeSpellcheckBridge, registerNativeSpellcheckBridge, validDraft, validReply, blockquotesUnchanged}
  = require('../efs/native_spellcheck_bridge');

function request(port, ticket, method, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? '' : JSON.stringify(data);
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        Authorization: 'Bearer ' + ticket,
        ...(data === undefined ? {} : {'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('quoted Markdown including nested quotes and lazy lines stays verbatim', () => {
  const original = 'Teh introduction.\n> Thsi is quoted.\n> > Anothre quote.\ncontinued text teh\n\n# Heading\nTeh conclusion.';
  const corrected = 'The introduction.\n> Thsi is quoted.\n> > Anothre quote.\ncontinued text teh\n\n# Heading\nThe conclusion.';
  assert.equal(blockquotesUnchanged(original, corrected), true);
  assert.equal(blockquotesUnchanged(original, corrected.replace('Thsi', 'This')), false);
  assert.equal(blockquotesUnchanged(original, corrected.replace('continued text teh', 'continued text the')), false);
  assert.equal(blockquotesUnchanged(original, corrected.replace('> >', '>')), false);
  assert.equal(blockquotesUnchanged('> A quote\r\n', '> A quote\n'), false);
  assert.equal(blockquotesUnchanged('> A quote\n# Hedaing', '> A quote\n# Heading'), true);
});

test('the authenticated channel rejects rewritten blockquotes but accepts changes outside them', async () => {
  const original = 'Teh start.\n> Thsi is quoted.\nlazy continuaton\n\nTeh end.';
  const session = await startNativeSpellcheckBridge({title: '', body: original}, {timeoutMs: 10000});
  const fields = new URLSearchParams(new URL(session.url).hash.slice(1));
  const port = Number(fields.get('port')), ticket = fields.get('ticket');
  assert.equal((await request(port, ticket, 'GET', '/job')).status, 200);
  const changedQuote = 'The start.\n> This is quoted.\nlazy continuation\n\nThe end.';
  assert.equal((await request(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: changedQuote}})).status, 422);
  const safe = 'The start.\n> Thsi is quoted.\nlazy continuaton\n\nThe end.';
  assert.equal((await request(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: safe}})).status, 200);
  assert.deepEqual(await session.completed, {title: '', body: safe});
});

test('strict loopback token transport accepts exactly one claimed result', async () => {
  const session = await startNativeSpellcheckBridge({title: '', body: 'Fxi teh wrds.'}, {timeoutMs: 10000});
  const launch = new URL(session.url);
  const fields = new URLSearchParams(launch.hash.slice(1));
  const port = Number(fields.get('port')), ticket = fields.get('ticket');
  assert.equal(launch.origin, 'https://chatgpt.com');
  assert.equal(fields.get('sweetiebot_spellcheck'), '1');
  assert.match(ticket, /^[a-f0-9]{64}$/);
  assert.equal((await request(port, '0'.repeat(64), 'GET', '/job')).status, 401);
  assert.equal((await request(port, ticket, 'GET', '/job', undefined, {Origin: 'https://evil.test'})).status, 403);
  assert.equal((await request(port, ticket, 'GET', '/job', undefined, {Host: 'localhost:' + port})).status, 403);
  assert.deepEqual(await request(port, ticket, 'GET', '/job'),
    {status: 200, body: {title: '', body: 'Fxi teh wrds.'}});
  assert.equal((await request(port, ticket, 'GET', '/job')).status, 409);
  assert.equal((await request(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: 'Fix the words.'}})).status, 200);
  assert.deepEqual(await session.completed, {title: '', body: 'Fix the words.'});
  assert.notEqual(ticket, '0'.repeat(64));
});

test('malformed and unsupported responses are rejected without completing session', async () => {
  const session = await startNativeSpellcheckBridge({title: '', body: 'Spellcheck sample.'},
    {timeoutMs: 10000});
  const q = new URLSearchParams(new URL(session.url).hash.slice(1));
  const port = Number(q.get('port')), ticket = q.get('ticket');
  assert.equal((await request(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: 'Wrong order'}})).status, 409);
  await request(port, ticket, 'GET', '/job');
  for (const result of [{status: 'complete', result: {title: 1, body: 'wrong'}},
    {status: 'complete', result: {title: '', body: 'x'.repeat(60001)}},
    {status: 'error', error: 'x'.repeat(501)}]) {
    assert.equal((await request(port, ticket, 'POST', '/result', result)).status, 400);
  }
  assert.equal((await request(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: 'Safe correction.'}})).status, 200);
  assert.equal((await session.completed).body, 'Safe correction.');
});

test('remote errors, explicit cancellation and timeouts reject safely', async () => {
  const failed = await startNativeSpellcheckBridge({title: '', body: 'Hello'}, {timeoutMs: 10000});
  const q = new URLSearchParams(new URL(failed.url).hash.slice(1));
  await request(Number(q.get('port')), q.get('ticket'), 'GET', '/job');
  await request(Number(q.get('port')), q.get('ticket'), 'POST', '/result',
    {status: 'error', error: 'Plugin not available'});
  await assert.rejects(failed.completed, /Plugin not available/);
  const cancelled = await startNativeSpellcheckBridge({title: '', body: 'Hello'});
  cancelled.cancel();
  await assert.rejects(cancelled.completed, /cancelled/);
  const timeout = await startNativeSpellcheckBridge({title: '', body: 'Hello'}, {timeoutMs: 1000});
  await assert.rejects(timeout.completed, /timed out/);
});

test('the transport refuses invalid or excessively large draft and reply types', async () => {
  for (const draft of [{title: '', body: ''}, {title: '', body: 'x'.repeat(60001)},
    {title: '', body: 'NUL\0'}, {title: 4, body: 'Hello'}]) {
    assert.equal(validDraft(draft), false);
    await assert.rejects(startNativeSpellcheckBridge(draft));
  }
  for (const value of [{status: 'complete', result: {title: '', body: 'ok'}},
    {status: 'error', error: 'Offline'}]) assert.equal(validReply(value), true);
  assert.equal(validReply({status: 'complete', result: {title: null, body: 'ok'}}), false);
});

test('explicit VS Code command opens only the native browser and returns a review document', async () => {
  const calls = [], handlers = {}, subscriptions = [];
  const vscode = {
    commands: {
      registerCommand(name, fn) { handlers[name] = fn; return {dispose() {delete handlers[name];}}; },
      async getCommands() { return ['workbench.action.browser.open']; },
      async executeCommand(name, params) {calls.push([name, params]);}
    },
    workspace: {async openTextDocument(spec) {calls.push(['document', spec]); return spec;}},
    window: {async showTextDocument(spec) {calls.push(['show', spec]);}},
  };
  const session = {
    url: 'https://chatgpt.com/#sweetiebot_spellcheck=1&port=1234&ticket=' + 'f'.repeat(64),
    completed: Promise.resolve({title: '', body: 'Corrected result.'}),
    cancel() {throw new Error('must not cancel successful result');}
  };
  registerNativeSpellcheckBridge(vscode, {subscriptions}, async draft => {
    assert.deepEqual(draft, {title: '', body: 'Fxi teh words.'});
    return session;
  });
  assert.equal(typeof handlers['sweetiebot.spellcheckWithChatGPT'], 'function');
  assert.deepEqual(await handlers['sweetiebot.spellcheckWithChatGPT']('Fxi teh words.'),
    {title: '', body: 'Corrected result.'});
  assert.equal(calls[0][0], 'workbench.action.browser.open');
  assert.equal(calls[1][0], 'document');
  assert.equal(calls[1][1].content, 'Corrected result.');
  assert.equal(calls[2][0], 'show');
  subscriptions.forEach(x => x.dispose());
});


test('the scoped native preload exchanges a real authenticated job without Chrome extensions', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '../assets/browser/spellcheck_bridge.js'), 'utf8');
  const session = await startNativeSpellcheckBridge({title: '', body: 'Fxi teh wrds.'}, {timeoutMs: 10000});
  const location = new URL(session.url);
  const revisions = [], sent = [], messages = [], observers = [];
  let mentioned = false;
  const mention = {
    getAttribute(key) {return key === 'app-mention-path' ? 'app://spellcheck-only' :
      key === 'app-mention-display-name' ? 'Spellcheck Only' : null;},
    textContent: 'Spellcheck Only'
  };
  const composer = {
    isContentEditable: true, innerText: '', textContent: '',
    focus() {},
    querySelectorAll() {return mentioned ? [mention] : [];},
    closest() {return {querySelector() {return send;}};}
  };
  const option = {
    isConnected: true, textContent: 'Spellcheck Only',
    getClientRects() {return [1];},
    getAttribute() {return null;},
    click() {mentioned = true;}
  };
  const surface = {
    isConnected: true,
    getClientRects() {return [1];},
    closest() {return null;},
    querySelectorAll() {return [option];}
  };
  const send = {
    disabled: false,
    isConnected: true,
    getClientRects() {return [1];},
    getAttribute(name) {return name === 'aria-disabled' ? 'false' : null;},
    click() {
      sent.push(composer.innerText);
      messages.push({innerText: '{"title":"","body":"Fix the words."}'});
      for (const observer of observers) observer.check();
    }
  };
  const selection = {removeAllRanges() {}, addRange() {}};
  const document = {
    documentElement: {},
    querySelector(selector) {
      return selector.includes('#prompt-textarea') ? composer : null;
    },
    querySelectorAll(selector) {
      if (selector.includes('data-mention-list-scroll-area')) return [surface];
      if (selector.includes('data-message-author-role')) return messages;
      return [];
    },
    createRange() {return {selectNodeContents() {}, collapse() {}};},
    execCommand(action, _ui, value) {
      if (action !== 'insertText') return false;
      composer.innerText += value;
      return true;
    }
  };
  const window = {location, getSelection() {return selection;}};
  window.top = window;
  const history = {replaceState(_state, _title, url) {
    revisions.push(url);
    location.href = url;
  }, state: null};
  class Observer {
    constructor(check) {this.check = check;}
    observe() {observers.push(this);}
    disconnect() {const index = observers.indexOf(this); if (index !== -1) observers.splice(index, 1);}
  }
  const context = {
    window, document, history, MutationObserver: Observer,
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    Buffer, require, URL, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(script, context, {filename: 'spellcheck_bridge.js'});
  const result = await session.completed;
  assert.deepEqual(result, {title: '', body: 'Fix the words.'});
  assert.equal(revisions.length, 1);
  assert.equal(location.hash, '', 'transient bearer credentials must be removed from the URL');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Spellcheck this text/);
  assert.match(sent[0], /Leave Markdown blockquotes completely unchanged/);
  assert.match(sent[0], /Fxi teh wrds\./);
  assert.doesNotMatch(sent[0], /Bearer|127\.0\.0\.1|sweetiebot_spellcheck/);
});

test('the preload refuses unrelated sites and malformed launch credentials', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '../assets/browser/spellcheck_bridge.js'), 'utf8');
  for (const href of [
    'https://evil.example/#sweetiebot_spellcheck=1&port=1&ticket=' + 'a'.repeat(64),
    'https://chatgpt.com/#sweetiebot_spellcheck=1&port=1&ticket=bad',
    'https://chatgpt.com/c/private#sweetiebot_spellcheck=1&port=1&ticket=' + 'a'.repeat(64),
    'https://chatgpt.com/'
  ]) {
    const window = {location: {href}}; window.top = window;
    vm.runInNewContext(script, {
      window, URL, URLSearchParams,
      require() {throw new Error('Unexpected native credential or network access');},
      history: {replaceState() {throw new Error('Unexpected URL mutation');}}
    }, {filename: 'spellcheck_bridge.js'});
  }
});
