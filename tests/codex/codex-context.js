'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(name, context) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/codex', name), 'utf8'), context);
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
  reloadState = { existingCodexState: 'preserved', sweetiebotReloadConversation: '../../../settings' };
  reloadView.scmToolkitRegisterCodexSnapshot(reloadApi);
  reloadReceive({ data: { type: 'persisted-atom-sync' } });
  assert.equal(reloadReplies.length, 3);
  assert.equal(reloadState.sweetiebotReloadConversation, undefined);
  assert.equal(reloadState.existingCodexState, 'preserved');

  let mounted, changed, uiMessage;
  const frames = [], clicks = [];
  const anchor = {
    parentElement: {}, getAttribute: () => 'Chat actions',
    getClientRects: () => [1], closest: () => null,
    before(button) { mounted = button; button.parentElement = this.parentElement; button.nextElementSibling = this; }
  };
  const location = { hash: `#/local/${conversationId}` };
  const ui = vm.createContext({
    window: { location, addEventListener(type, listener) {
      if (type === 'message') uiMessage = listener;
    } },
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
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  assert.equal(mounted, undefined, 'Do not show the shortcut until the host verifies the checkout');
  assert.equal(clicks[0].type, 'scm-toolkit-checkout-visibility-request');
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-result',
    threadId: conversationId, requestId: clicks[0].requestId, show: true } });
  flush();
  assert.equal(mounted.title, 'Open chat checkout in a new window');
  const nextChat = '019c56c3-06fc-7db3-a928-9c3607e17130';
  location.hash = `#/local/${nextChat}`;
  changed(); flush();
  assert.equal(mounted, undefined, 'A chat change hides the previous checkout shortcut immediately');
  const nextRequest = clicks.at(-1);
  assert.equal(nextRequest.threadId, nextChat);
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-result',
    threadId: conversationId, requestId: clicks[0].requestId, show: true } });
  flush();
  assert.equal(mounted, undefined, 'Ignore stale answers from a previously visible chat');
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-result',
    threadId: nextChat, requestId: nextRequest.requestId, show: false } });
  flush();
  assert.equal(mounted, undefined, 'Hide the shortcut when already in the chat checkout');
  changed(); flush();
  assert.equal(clicks.length, 2, 'Do not re-query the host on every DOM mutation');
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-refresh' } });
  flush();
  const refreshed = clicks.at(-1);
  assert.notEqual(refreshed.requestId, nextRequest.requestId);
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-result',
    threadId: nextChat, requestId: nextRequest.requestId, show: false } });
  flush();
  assert.equal(mounted, undefined, 'Ignore answers that predate a workspace refresh');
  uiMessage({ data: { type: 'scm-toolkit-checkout-visibility-result',
    threadId: nextChat, requestId: refreshed.requestId, show: true } });
  flush();
  assert(mounted, 'Show the shortcut when the chat checkout differs from the current window');
  mounted.click();
  assert.equal(clicks.at(-1).threadId, nextChat, 'Resolve the current chat when clicked');
  assert.equal(clicks.at(-1).type, 'scm-toolkit-open-chat-checkout');
  location.hash = '/';
  changed(); flush();
  assert.equal(mounted, undefined, 'Hide the button when there is no identifiable chat');

  let shareRequest, stage = 0;
  const sharedResponses = [];
  const control = (text, click) => ({ textContent: text, getAttribute: () => '', getClientRects: () => [1], click,
    dispatchEvent() {} });
  const menuButton = control('Chat actions', () => {});
  menuButton.dispatchEvent = event => { if (event.type === 'pointerdown' && event.button === 0) stage = 1; };
  const shareButton = control('Share', () => { stage = 2; });
  const copyButton = control('Copy shared link', () => { stage = 3; });
  copyButton.isConnected = true;
  copyButton.closest = () => ({ textContent: 'Anyone with the link can view this chat' });
  const sharingUI = vm.createContext({
    PointerEvent: class { constructor(type, options) { Object.assign(this, {type}, options); } },
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
    PointerEvent: class { constructor(type, options) { Object.assign(this, {type}, options); } },
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

  let preparingRequest, preparationClock = 0, preparationCopied = false;
  const preparingCopy = control('Copy link', () => { preparationCopied = true; });
  Object.defineProperty(preparingCopy, 'disabled', { get: () => preparationClock < 60000 });
  preparingCopy.closest = () => ({ textContent: 'Anyone with the link can view this chat' });
  const preparationResponses = [];
  const preparingUI = vm.createContext({
    Date: { now: () => preparationClock },
    setTimeout(callback) { preparationClock += 1000; callback(); },
    window: { location: { hash: `#/local/${conversationId}` },
      addEventListener: (_, callback) => { preparingRequest = callback; } },
    document: { querySelectorAll: selector => selector === '[role="dialog"] button' ? [preparingCopy] : [] }
  });
  load('context-webview.js', preparingUI);
  preparingUI.scmToolkitRegisterCodexSnapshot({ postMessage: message => preparationResponses.push(message) });
  await preparingRequest({ data: { type: 'scm-toolkit-context-request', id: 'preparing-share', shareOnly: conversationId } });
  assert.equal(preparationCopied, true, 'Reuse an open Share dialog and wait beyond the old 35-second deadline');
  assert.equal(preparationResponses[0].conversationId, conversationId);


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
  let liveResume = false, configListener, checkoutFoldersChanged, checkoutNeedsNewWindow = false;
  const hostVscode = {
    workspace: {
      getConfiguration: () => ({get(key, fallback) { return key === 'codexContinueAtReset' ? liveResume : fallback; }}),
      onDidChangeConfiguration(callback) { configListener = callback; return {dispose() {}}; },
      onDidChangeWorkspaceFolders(callback) { checkoutFoldersChanged = callback; return {dispose() {}}; }
    },
    env: { clipboard: { readText: async () => clipboard, writeText: async value => { clipboard = value; } } },
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() {} };
      },
      async executeCommand(id, threadId) {
        assert.equal(id, 'sweetiebot.codex.chatCheckoutVisibility');
        return { threadId, needsNewWindow: checkoutNeedsNewWindow };
      }
    }
  };
  let clipboard = 'previous clipboard';
  const disposable = host.scmToolkitRegisterCodexSnapshotProvider(provider, hostVscode);
  assert(registered.has('sweetiebot.readCodexContext'));
  assert(registered.has('sweetiebot.readCodexConversation'));

  provider.initializeWebview(webview, 'sidebar', () => {});
  provider.handleMessage(webview, {type: 'scm-toolkit-checkout-visibility-request',
    threadId: conversationId, requestId: 3});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).type, 'scm-toolkit-checkout-visibility-result');
  assert.equal(messages.at(-1).show, false);
  checkoutNeedsNewWindow = true;
  provider.handleMessage(webview, {type: 'scm-toolkit-checkout-visibility-request',
    threadId: conversationId, requestId: 4});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).show, true);
  checkoutFoldersChanged();
  assert.equal(messages.at(-1).type, 'scm-toolkit-checkout-visibility-refresh');
  messages.length = 0;
  provider.handleMessage(webview, {type:'scm-toolkit-read-resume-setting'});
  assert.equal(messages.at(-1).type, 'scm-toolkit-resume-setting');
  assert.equal(messages.at(-1).enabled, false);
  liveResume = true;
  configListener({affectsConfiguration: key => key === 'sweetiebot.codexContinueAtReset'});
  assert.equal(messages.at(-1).enabled, true);
  provider.handleMessage(webview, {type:'scm-toolkit-read-resume-setting'});
  assert.equal(messages.at(-1).enabled, true);
  messages.length = 0;
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
  for (const invalid of ['../../../settings', 'https://example.com', 'a'.repeat(41), null]) {
    provider.handleMessage(webview, { type: 'scm-toolkit-restore-conversation', conversationId: invalid });
  }
  assert.equal(messages.length, beforeInvalid, 'Only canonical local UUIDs can be restored');
  sidebar.visible = false;

  const identityPending = registered.get('sweetiebot.readCodexIdentity')();
  assert.equal(messages.at(-1).identityOnly, true);
  assert.equal(messages.at(-1).allowHidden, true);
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId, hasConversation: true });
  assert.equal((await identityPending).threadId, conversationId);
  const focusState = { anchor: { path: [0], offset: 2 }, focus: { path: [0], offset: 4 } };
  const focusedIdentity = registered.get('sweetiebot.readCodexIdentity')();
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId, composerFocus: focusState });
  assert.deepEqual((await focusedIdentity).composerFocus, focusState, 'Focus metadata travels with identity without reading the draft');
  const restoredFocus = registered.get('sweetiebot.codex.restoreComposerFocus')({ threadId: conversationId, state: focusState });
  assert.equal(messages.at(-1).composerFocus.threadId, conversationId);
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, focused: true });
  assert.equal(await restoredFocus, true);
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
  await checkComposerFocus();
  console.log('Read-only Codex snapshot and provenance bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

async function checkComposerFocus() {
  const listeners = new Map(), observers = [], timers = new Map();
  let timerId = 0, present = true, activeChat = 'same-chat', focused = 0, restored;
  const text = { nodeType: 3, length: 12 };
  const editor = { childNodes: [text], contains: node => node === text || node === editor,
    closest: () => editor, getClientRects: () => [1], focus() { focused++; document.activeElement = editor; } };
  text.parentNode = editor;
  const selection = { anchorNode: text, anchorOffset: 4, focusNode: text, focusOffset: 7,
    setBaseAndExtent(...args) { restored = args; } };
  const document = { activeElement: editor, documentElement: {},
    querySelectorAll: () => present ? [editor] : [],
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); } };
  const fire = (name, event = {}) => { for (const listener of [...listeners.get(name) || []]) listener(event); };
  const context = vm.createContext({ document, window: { getSelection: () => selection },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } } });
  load('composer-focus.js', context);
  const helper = context.scmToolkitComposerFocus();
  const saved = helper.capture();
  assert.equal(saved.anchor.offset, 4);
  assert.equal(saved.focus.offset, 7);
  fire('focusin', { target: editor });
  fire('focusout', { target: editor, relatedTarget: null });
  document.activeElement = {};
  assert.equal(helper.capture().anchor.offset, 4, 'Workbench branch controls retain the last editing intent');
  present = false;
  const pending = helper.restore(saved, () => activeChat, 'same-chat');
  assert.equal(focused, 0, 'Wait for the destination composer');
  present = true;
  observers.at(-1).callback();
  assert.equal(await pending, true);
  assert.equal(focused, 1);
  assert.deepEqual(restored, [text, 4, text, 7], 'Restore the exact selected range without changing text');
  assert.equal(text.length, 12);
  assert.equal(timers.size, 0);
  fire('focusout', { target: editor, relatedTarget: {} });
  document.activeElement = {};
  assert.equal(helper.capture(), undefined, 'Other Codex controls must not request composer focus');
  present = false;
  const cancelled = helper.restore(saved, () => activeChat, 'same-chat');
  fire('pointerdown');
  present = true;
  observers.at(-1).callback();
  assert.equal(await cancelled, false);
  assert.equal(focused, 1, 'A new user click prevents delayed focus stealing');
  activeChat = 'another-chat';
  const stale = helper.restore(saved, () => activeChat, 'same-chat');
  for (const callback of [...timers.values()]) callback();
  assert.equal(await stale, false);
  assert.equal(focused, 1, 'Never restore into a different conversation');
  console.log('Branch handoff composer focus, selection, hydration and cancellation checks passed.');
}
