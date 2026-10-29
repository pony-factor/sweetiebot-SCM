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

  // The webview saves only a UUID, retaining the existing VS Code webview state.
  let reloadReceive;
  let reloadState = { existingCodexState: 'preserved' };
  const reloadReplies = [];
  const reloadWindow = { location: { hash: `#/local/${conversationId}`, pathname: '/', search: '' },
    addEventListener(type, listener) { assert.equal(type, 'message'); reloadReceive = listener; } };
  const reloadView = vm.createContext({
    window: reloadWindow,
    document: { querySelectorAll() { return []; } }
  });
  load('context-webview.js', reloadView);
  const reloadApi = {
    getState: () => reloadState,
    setState: state => { reloadState = state; },
    postMessage: message => reloadReplies.push(message)
  };
  reloadView.scmToolkitRegisterCodexSnapshot(reloadApi);
  reloadReceive({ data: { type: 'scm-toolkit-context-request', id: 'save', reloadState: true } });
  assert.equal(reloadState.sweetiebotReloadConversation, conversationId);
  assert.equal(reloadState.existingCodexState, 'preserved');
  assert.deepEqual(Object.keys(reloadReplies[0]).sort(), ['conversationId', 'id', 'type'],
    'Reload snapshots never expose transcripts or model metadata');
  reloadReceive({ data: { type: 'unrelated' } });
  assert.equal(reloadReplies.length, 1, 'Unrelated events cannot trigger restoration');
  reloadReceive({ data: { type: 'persisted-atom-sync' } });
  assert.equal(reloadReplies[1].type, 'scm-toolkit-restore-conversation');
  assert.equal(reloadReplies[1].conversationId, conversationId);
  assert.equal(reloadState.sweetiebotReloadConversation, undefined, 'Consume restore state once');
  assert.equal(reloadState.existingCodexState, 'preserved');
  reloadReceive({ data: { type: 'persisted-atom-sync' } });
  assert.equal(reloadReplies.length, 2, 'Repeated renderer readiness does not reopen a chat');

  // Landing on Codex home must clear a stale restore ID instead of reopening it.
  reloadWindow.location.hash = '/';
  reloadState = { existingCodexState: 'preserved', sweetiebotReloadConversation: conversationId };
  reloadReceive({ data: { type: 'scm-toolkit-context-request', id: 'home', reloadState: true } });
  assert.equal(reloadReplies[2].conversationId, undefined);
  assert.equal(reloadState.sweetiebotReloadConversation, undefined);
  assert.equal(reloadState.existingCodexState, 'preserved');

  // Invalid persisted payloads are removed and never converted into navigation.
  reloadState = { existingCodexState: 'preserved', sweetiebotReloadConversation: '../../settings' };
  reloadView.scmToolkitRegisterCodexSnapshot(reloadApi);
  reloadReceive({ data: { type: 'persisted-atom-sync' } });
  assert.equal(reloadReplies.length, 3);
  assert.equal(reloadState.sweetiebotReloadConversation, undefined);
  assert.equal(reloadState.existingCodexState, 'preserved');

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

  let shareRequest, stage = 0;
  const sharedResponses = [];
  const control = (text, click) => ({ textContent: text, getAttribute: () => '', getClientRects: () => [1], click });
  const menuButton = control('Chat actions', () => { stage = 1; });
  const shareButton = control('Share', () => { stage = 2; });
  const copyButton = control('Copy shared link', () => { stage = 3; });
  copyButton.isConnected = true;
  copyButton.closest = () => ({ textContent: 'Anyone with the link can view this chat' });
  const sharingUI = vm.createContext({
    setTimeout,
    window: { location: { hash: `#/local/${conversationId}` }, addEventListener: (_, callback) => { shareRequest = callback; } },
    document: { querySelectorAll: selector => selector === 'button' ? [menuButton]
      : selector === '[role="menuitem"]' && stage === 1 ? [shareButton]
      : selector === '[role="dialog"] button' && stage === 2 ? [copyButton] : [] }
  });
  load('context-webview.js', sharingUI);
  sharingUI.scmToolkitRegisterCodexSnapshot({postMessage: message => sharedResponses.push(message)});
  await shareRequest({data:{type:'scm-toolkit-context-request',id:'share',shareOnly:conversationId}});
  assert.equal(stage,3,'Native Chat actions, Share and Copy link must run in order');
  assert.equal(sharedResponses[0].conversationId,conversationId);
  await shareRequest({data:{type:'scm-toolkit-context-request',id:'wrong-chat',shareOnly:nextChat}});
  assert.match(sharedResponses[1].error,/originating chat/);

  // Preserve legacy Copy link support when the native Share dialog closes.
  let legacyRequest, legacyStage = 0;
  const legacyResponses = [];
  const legacyMenu = control('Chat actions', () => { legacyStage = 1; });
  const legacyShare = control('Share', () => { legacyStage = 2; });
  const legacyCopy = control('Copy link', () => { legacyCopy.isConnected = false; legacyStage = 3; });
  legacyCopy.isConnected = true;
  legacyCopy.closest = () => ({ textContent: 'Anyone with the link can view this chat' });
  const legacyUI = vm.createContext({
    setTimeout,
    window: { location: { hash: `#/local/${conversationId}` },
      addEventListener: (_, callback) => { legacyRequest = callback; } },
    document: { querySelectorAll: selector => selector === 'button' ? [legacyMenu]
      : selector === '[role="menuitem"]' && legacyStage === 1 ? [legacyShare]
      : selector === '[role="dialog"] button' && legacyStage === 2 ? [legacyCopy] : [] }
  });
  load('context-webview.js', legacyUI);
  legacyUI.scmToolkitRegisterCodexSnapshot({ postMessage: message => legacyResponses.push(message) });
  await legacyRequest({ data: { type: 'scm-toolkit-context-request', id: 'legacy-share', shareOnly: conversationId } });
  assert.equal(legacyStage, 3, 'Legacy Copy link must still work when its dialog closes');
  assert.equal(legacyResponses[0].conversationId, conversationId);


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
    postMessageToWebview(target, message) {
      assert.equal(target, webview, 'Restoration targets the original Codex webview');
      messages.push(message);
    },
    initializeWebview() {},
    handleMessage() { throw new Error('Custom snapshot replies must not reach Codex job handling'); }
  };
  const host = vm.createContext({ require, setTimeout, clearTimeout, encodeURIComponent });
  load('context-host.js', host);
  const hostVscode = {
    env: { clipboard: { readText: async () => clipboard, writeText: async value => { clipboard = value; } } },
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() {} };
      }
    }
  };
  let clipboard = 'previous clipboard';
  const disposable = host.scmToolkitRegisterCodexSnapshotProvider(provider, hostVscode);
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

  assert(registered.has('sweetiebot.preserveCodexConversation'));
  assert.equal(await registered.get('sweetiebot.preserveCodexConversation')(), false,
    'Hidden sidebar cannot be restored by automatic app repair');
  sidebar.visible = true;
  const reloadPending = registered.get('sweetiebot.preserveCodexConversation')();
  assert.equal(messages.at(-1).reloadState, true);
  assert.equal(messages.at(-1).identityOnly, false);
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId });
  assert.equal(await reloadPending, true);
  provider.handleMessage(webview, { type: 'scm-toolkit-restore-conversation', conversationId });
  assert.equal(messages.at(-1).type, 'navigate-to-route');
  assert.equal(messages.at(-1).path, `/local/${conversationId}`);
  const beforeInvalid = messages.length;
  for (const invalid of ['../../settings', 'https://example.com', 'a'.repeat(41), null]) {
    provider.handleMessage(webview, { type: 'scm-toolkit-restore-conversation', conversationId: invalid });
  }
  assert.equal(messages.length, beforeInvalid, 'Only canonical local UUIDs can be restored');
  sidebar.visible = false;

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

  const sharedUrl = 'https://chatgpt.com/s/cx_1234567890abcdefghijklmnop';
  const sharing = registered.get('sweetiebot.shareCodexConversation')(conversationId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).shareOnly, conversationId);
  clipboard = sharedUrl;
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId });
  const shared = await sharing;
  assert.equal(shared.uuid, conversationId);
  assert.equal(shared.sharedUrl, sharedUrl);
  assert.equal(clipboard, 'previous clipboard', 'Native copy must preserve the previous clipboard');
  const changedChat = registered.get('sweetiebot.shareCodexConversation')(conversationId);
  await new Promise(resolve => setImmediate(resolve));
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId: nextChat });
  await assert.rejects(changedChat, /active chat changed/);

  provider.sidebarViews.clear();
  assert.throws(
    () => registered.get('sweetiebot.readCodexConversation')(),
    /Open a Codex conversation/
  );
  disposable.dispose();
  console.log('Read-only Codex snapshot and provenance bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
