'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {startNativeSpellcheckBridge, registerNativeSpellcheckBridge, validDraft, validReply}
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
