'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(name, context) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex', name), 'utf8'), context);
}

async function run() {
  const conversationId = '019c56c3-06fc-7db3-a928-9c3607e17129';
  let receive;
  const responses = [];
  const transcripts = [
    { innerText: 'Other hidden chat', getClientRects: () => [] },
    { innerText: 'Current window conversation', getClientRects: () => [1] }
  ];
  const context = vm.createContext({
    window: {
      location: { hash: `#/local/${conversationId}`, pathname: '/', search: '' },
      addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; }
    },
    document: {
      querySelectorAll(selector) {
        if (selector === '[data-thread-user-message-navigation-content]') return transcripts;
        if (selector === 'button[data-composer-navigation-target="model"]')
          return [{ innerText: '6.1 Codex', getAttribute: () => '', getClientRects: () => [1] }];
        if (selector === 'button[data-composer-navigation-target="reasoning"]')
          return [{ innerText: 'Uber', getAttribute: () => '', getClientRects: () => [1] }];
        if (selector.includes('[data-conversation-id]')) return [];
        throw new Error(`Unexpected selector: ${selector}`);
      }
    }
  });
  load('context-webview.js', context);
  context.scmToolkitRegisterCodexSnapshot({ postMessage: message => responses.push(message) });
  receive({ data: { type: 'unrelated' } });
  assert.equal(responses.length, 0);
  receive({ data: { type: 'scm-toolkit-context-request', id: 'request' } });
  assert.equal(responses[0].text, 'Current window conversation');
  assert.equal(responses[0].conversationId, conversationId);
  assert.equal(responses[0].model.name, 'GPT-6.1 Codex');
  assert.equal(responses[0].model.effort, 'Extra High');

  transcripts.splice(0, transcripts.length, {
    innerText: 'Retained hidden chat',
    getClientRects: () => []
  });
  receive({ data: { type: 'scm-toolkit-context-request', id: 'hidden' } });
  assert.equal(responses[1].text, 'Retained hidden chat');
  receive({ data: { type: 'scm-toolkit-context-request', id: 'model', modelOnly: true } });
  assert.equal(responses[2].model.name, 'GPT-6.1 Codex');
  assert.equal(responses[2].model.effort, 'Extra High');
  assert.equal('text' in responses[2], false, 'No transcript for model-only requests');

  let mounted, changed;
  const frames = [], clicks = [];
  const anchor = {
    parentElement: {}, getAttribute: () => 'Chat actions',
    getClientRects: () => [1], closest: () => null,
    before(button) { mounted = button; button.parentElement = this.parentElement; button.nextElementSibling = this; }
  };
  const location = { hash: `#/local/${conversationId}` };
  const ui = vm.createContext({
    window: { location, addEventListener() {} },
    MutationObserver: class { constructor(callback) { changed = callback; } observe() {} },
    requestAnimationFrame: callback => frames.push(callback),
    document: {
      documentElement: {},
      querySelectorAll: selector => selector === 'button' ? [anchor] : [],
      getElementById: () => mounted,
      createElement: () => ({ style: {}, setAttribute() {},
        addEventListener(type, callback) { if (type === 'click') this.click = callback; },
        remove() { mounted = undefined; }
      })
    }
  });
  load('context-webview.js', ui);
  ui.scmToolkitRegisterCodexSnapshot({ postMessage: message => clicks.push(message) });
  frames.shift()();
  assert.equal(mounted.title, 'Open chat checkout in a new window');
  const nextChat = '019c56c3-06fc-7db3-a928-9c3607e17130';
  location.hash = `#/local/${nextChat}`;
  mounted.click();
  assert.equal(clicks[0].threadId, nextChat, 'Resolve the current chat when clicked, not when mounted');
  assert.equal(clicks[0].type, 'scm-toolkit-open-chat-checkout');
  location.hash = '/';
  changed(); frames.shift()();
  assert.equal(mounted, undefined, 'Hide the button when there is no identifiable chat');

  const registered = new Map();
  let listener;
  const messages = [];
  const webview = {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(message) { messages.push(message); return true; }
  };
  const provider = {
    editorPanels: new Map(),
    sidebarViews: new Set([{ visible: true, webview }]),
    initializeWebview() {},
    handleMessage() { throw new Error('Custom snapshot replies must not reach Codex job handling'); }
  };
  const host = vm.createContext({ require, setTimeout, clearTimeout, encodeURIComponent });
  load('context-host.js', host);
  const disposable = host.scmToolkitRegisterCodexSnapshotProvider(provider, {
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() {} };
      }
    }
  });
  assert(registered.has('sweetiebot.readCodexContext'));
  assert(registered.has('sweetiebot.readCodexConversation'));

  provider.initializeWebview(webview, 'sidebar', () => {});
  const closedPanel = { get active() { throw new Error('Webview is disposed'); } };
  provider.editorPanels.set(closedPanel, {});
  provider.getWebviewForPanel = () => undefined;

  const textPending = registered.get('sweetiebot.readCodexContext')();
  assert.equal(messages[0].type, 'scm-toolkit-context-request');
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[0].id,
    text: 'Window-local text',
    conversationId
  });
  assert.equal(await textPending, 'Window-local text');

  const sourcePending = registered.get('sweetiebot.readCodexConversation')();
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[1].id,
    text: '🦄' + 'x'.repeat(94999),
    conversationId,
    model: { name: 'GPT-6.1 Codex', effort: 'Extra High' }
  });
  const snapshot = await sourcePending;
  assert.equal(snapshot.text, 'x'.repeat(94999), 'Clipping must not leave a lone low surrogate');
  assert.equal(snapshot.model.name, 'GPT-6.1 Codex');
  assert.equal(snapshot.model.effort, 'Extra High');
  assert.equal(snapshot.source.kind, 'codex');
  assert.equal(snapshot.source.uuid, conversationId);
  assert.match(snapshot.source.url, /^https:\/\/vscode\.dev\/redirect\?url=/);
  assert(snapshot.source.url.includes(conversationId));

  provider.handleMessage(webview, { type: 'scm-toolkit-context-response' });
  assert.equal(messages.length, 2, 'no submit or interrupt messages are sent');

  const sidebar = [...provider.sidebarViews][0];
  sidebar.visible = false;
  const hiddenPending = registered.get('sweetiebot.readCodexContext')();
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[2].id,
    text: 'Retained conversation',
    conversationId
  });
  assert.equal(await hiddenPending, 'Retained conversation', 'Source Control can hide Codex without losing context');

  const identityPending = registered.get('sweetiebot.readCodexIdentity')();
  assert.equal(messages.at(-1).identityOnly, true);
  assert.equal(messages.at(-1).allowHidden, true);
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId, hasConversation: true });
  assert.equal((await identityPending).threadId, conversationId);
  const ambiguous = registered.get('sweetiebot.readCodexIdentity')();
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, hasConversation: true });
  await assert.rejects(ambiguous, /identify/);
  assert(registered.has('sweetiebot.readCodexModel'));
  const modelPending = registered.get('sweetiebot.readCodexModel')();
  assert.equal(messages.at(-1).modelOnly, true);
  listener({type:'scm-toolkit-context-response',id:messages.at(-1).id,
    model:{name:'GPT-6.1 Codex',effort:'Medium'}});
  assert.deepEqual(JSON.parse(JSON.stringify(await modelPending)),
    {name:'GPT-6.1 Codex',effort:'Medium'});

  provider.sidebarViews.clear();
  assert.throws(
    () => registered.get('sweetiebot.readCodexConversation')(),
    /Open a Codex conversation/
  );
  disposable.dispose();
  console.log('Read-only Codex snapshot and provenance bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
