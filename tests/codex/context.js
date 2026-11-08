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
  let stage = 0;
  const control = (text, click) => ({ textContent: text, getAttribute: () => '', getClientRects: () => [1], click,
    dispatchEvent() {} });
  const menu = control('Chat actions', () => {});
  menu.dispatchEvent = event => { if (event.type === 'pointerdown') stage = 1; };
  const copy = control('Copy', () => { stage = 2; });
  const markdown = control('Markdown', () => { stage = 3; });
  const deeplink = control('Deeplink', () => { stage = 4; });
  const context = vm.createContext({
    PointerEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    setTimeout,
    window: { location: { hash: `#/local/${conversationId}` },
      addEventListener(type, listener) { receive = listener; } },
    document: { querySelectorAll(selector) {
      if (selector === 'button') return [menu];
      if (selector === '[role="menuitem"]') return stage === 1 ? [copy] : [markdown, deeplink];
      return [];
    } }
  });
  load('context-webview.js', context);
  context.scmToolkitRegisterCodexSnapshot({ postMessage: message => responses.push(message) });
  await receive({ data: { type: 'scm-toolkit-context-request', id: 'request' } });
  assert.equal(stage, 3, 'Capture must invoke Chat actions > Copy > Markdown');
  assert.equal(responses[0].nativeCopy, 'markdown');
  assert.equal('text' in responses[0], false, 'Never scrape a rendered transcript');
  await receive({ data: { type: 'scm-toolkit-context-request', id: 'link', copyDeepLink: true,
    expectedThreadId: conversationId } });
  assert.equal(stage, 4, 'Capture the native deeplink separately');
  assert.equal(responses[1].nativeCopy, 'deeplink');

  const beforeHandoff = stage;
  await receive({ data: { type: 'scm-toolkit-chat-identity-request', id: 'branch-identity' } });
  assert.equal(responses.at(-1).conversationId, conversationId);
  await receive({ data: { type: 'scm-toolkit-composer-focus-request', id: 'branch-focus' } });
  assert.equal(responses.at(-1).focused, false);
  assert.equal(stage, beforeHandoff, 'Branch identity and focus never invoke Copy or Share, even without flags');

  // Editor hydration is retryable, but user activity or a chat change cancels it.
  const focusListeners = new Map(), focusTimers = [];
  let changedFocus, visibleThread = conversationId;
  const focusDocument = {
    documentElement: {},
    activeElement: null,
    querySelectorAll() { return []; },
    addEventListener(name, callback) { focusListeners.set(name, callback); },
    removeEventListener(name) { focusListeners.delete(name); }
  };
  const focusVM = vm.createContext({
    document: focusDocument, window: { getSelection: () => null },
    MutationObserver: class {
      constructor(callback) { changedFocus = callback; }
      observe() {}
      disconnect() {}
    },
    setTimeout(callback) { focusTimers.push(callback); return focusTimers.length; },
    clearTimeout() {}
  });
  load('composer-focus.js', focusVM);
  const focus = focusVM.scmToolkitComposerFocus();
  const waiting = focus.restore({}, () => visibleThread, conversationId);
  focusTimers.at(-1)();
  assert.equal(await waiting, null, 'An unhydrated composer should request a later retry');
  const cancelled = focus.restore({}, () => visibleThread, conversationId);
  focusListeners.get('pointerdown')();
  assert.equal(await cancelled, false, 'User interaction must stop focus retries');
  const departed = focus.restore({}, () => visibleThread, conversationId);
  visibleThread = 'another-chat';
  changedFocus();
  assert.equal(await departed, false, 'Never restore focus after the intended chat is left');

  let focusReceive;
  const focusResponses = [];
  const focusWebview = vm.createContext({
    scmToolkitComposerFocus: () => ({ restore: async () => null }),
    window: { location: { hash: `#/local/${conversationId}` }, addEventListener: (_, callback) => { focusReceive = callback; } },
    document: { querySelectorAll: () => [] }
  });
  load('context-webview.js', focusWebview);
  focusWebview.scmToolkitRegisterCodexSnapshot({ postMessage: value => focusResponses.push(value) });
  await focusReceive({ data: { type: 'scm-toolkit-composer-focus-request', id: 'still-loading',
    composerFocus: { state: {}, threadId: conversationId } } });
  assert.equal(focusResponses[0].focusRetry, true, 'Pass the hydration retry signal to the host');

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

  let shareRequest; stage = 0;
  const sharedResponses = [];
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

  let preparingRequest, preparationClock = 0, preparationCopied = false, cancelPreparation = false;
  const preparingCopy = control('Copy link', () => { preparationCopied = true; });
  Object.defineProperty(preparingCopy, 'disabled', { get: () => preparationClock < 60000 });
  preparingCopy.closest = () => ({ textContent: 'Anyone with the link can view this chat' });
  const preparationResponses = [];
  const preparingUI = vm.createContext({
    Date: { now: () => preparationClock },
    setTimeout(callback) {
      preparationClock += 1000;
      if (cancelPreparation) preparingRequest({ data: { type: 'scm-toolkit-cancel-share' } });
      callback();
    },
    window: { location: { hash: `#/local/${conversationId}` },
      addEventListener: (_, callback) => { preparingRequest = callback; } },
    document: { querySelectorAll: selector => selector === '[role="dialog"] button' ? [preparingCopy] : [] }
  });
  load('context-webview.js', preparingUI);
  preparingUI.scmToolkitRegisterCodexSnapshot({ postMessage: message => preparationResponses.push(message) });
  await preparingRequest({ data: { type: 'scm-toolkit-context-request', id: 'preparing-share', shareOnly: conversationId } });
  assert.equal(preparationCopied, true, 'Reuse an open Share dialog and wait beyond the old 35-second deadline');
  assert.equal(preparationResponses[0].conversationId, conversationId);
  preparationClock = 0; preparationCopied = false; cancelPreparation = true;
  await preparingRequest({ data: { type: 'scm-toolkit-context-request', id: 'cancelled-share', shareOnly: conversationId } });
  assert.equal(preparationCopied, false, 'Checkout cancellation stops a Share dialog still preparing');
  assert.match(preparationResponses.at(-1).error, /cancelled/);


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
  const host = vm.createContext({ require, URL, setTimeout, clearTimeout, encodeURIComponent });
  load('context-host.js', host);
  let liveResume = false, configListener, checkoutFoldersChanged, checkoutNeedsNewWindow = false;
  const hostVscode = {
    // The snapshot URL must not require Sweetiebot discovery in the recipient's VS Code.
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].type, 'scm-toolkit-context-request');
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[0].id,
    text: 'Window-local text',
    conversationId
  });
  assert.equal(await textPending, 'Window-local text');

  const sourcePending = registered.get('sweetiebot.readCodexConversation')();
  await new Promise(resolve => setImmediate(resolve));
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
  assert.equal(new URL(snapshot.source.url).searchParams.get('url'),
    `vscode://openai.chatgpt/local/${conversationId}`,
    'Codex source links must target the official Codex URI handler');

  provider.handleMessage(webview, { type: 'scm-toolkit-context-response' });
  assert.equal(messages.length, 2, 'no submit or interrupt messages are sent');

  const sidebar = [...provider.sidebarViews][0];
  sidebar.visible = false;
  const hiddenPending = registered.get('sweetiebot.readCodexContext')();
  await new Promise(resolve => setImmediate(resolve));
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
  assert.equal(messages.at(-1).type, 'scm-toolkit-chat-identity-request');
  assert.equal(messages.at(-1).identityOnly, true);
  assert.equal(messages.at(-1).allowHidden, true);
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId, hasConversation: true });
  assert.equal((await identityPending).threadId, conversationId);
  const focusPending = registered.get('sweetiebot.codex.restoreComposerFocus')({ state: {}, threadId: conversationId });
  assert.equal(messages.at(-1).type, 'scm-toolkit-composer-focus-request');
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, focused: true });
  assert.equal(await focusPending, true);
  const loadingFocus = registered.get('sweetiebot.codex.restoreComposerFocus')({ state: {}, threadId: conversationId });
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, focused: false, focusRetry: true });
  assert.equal(await loadingFocus, null, 'A delayed editor is distinct from cancellation');
  const cancelledFocus = registered.get('sweetiebot.codex.restoreComposerFocus')({ state: {}, threadId: conversationId });
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, focused: false });
  assert.equal(await cancelledFocus, false, 'User cancellation must not cause retries');

  clipboard = 'clipboard before branch switch';
  const interruptedCopy = registered.get('sweetiebot.readCodexContext')();
  const cancelledCopy = assert.rejects(interruptedCopy, /checkout is changing/);
  await new Promise(setImmediate);
  const cancelledId = messages.at(-1).id;
  await registered.get('sweetiebot.cancelCodexCapture')();
  await cancelledCopy;
  assert.equal(messages.at(-1).type, 'scm-toolkit-cancel-capture');
  assert.equal(clipboard, 'clipboard before branch switch');
  listener({ type: 'scm-toolkit-context-response', id: cancelledId, nativeCopy: 'markdown', conversationId });
  assert.equal(clipboard, 'clipboard before branch switch', 'Late copy responses cannot restart a cancelled export');
  clipboard = 'previous clipboard';
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

  const beforeUnrequestedShare = messages.length;
  await assert.rejects(registered.get('sweetiebot.shareCodexConversation')(conversationId), /explicit New PR/);
  assert.equal(messages.length, beforeUnrequestedShare, 'Background requests cannot open Share');
  const sharedUrl = 'https://chatgpt.com/s/cx_1234567890abcdefghijklmnop';
  const sharing = registered.get('sweetiebot.shareCodexConversation')(conversationId, { explicitNewPullRequest: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).shareOnly, conversationId);
  clipboard = sharedUrl;
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId });
  const shared = await sharing;
  assert.equal(shared.uuid, conversationId);
  assert.equal(shared.sharedUrl, sharedUrl);
  assert.equal(clipboard, 'previous clipboard', 'Native copy must preserve the previous clipboard');
  const changedChat = registered.get('sweetiebot.shareCodexConversation')(conversationId, { explicitNewPullRequest: true });
  await new Promise(resolve => setImmediate(resolve));
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, conversationId: nextChat });
  await assert.rejects(changedChat, /active chat changed/);

  const cancelledShare = registered.get('sweetiebot.shareCodexConversation')(conversationId, { explicitNewPullRequest: true });
  const cancellation = assert.rejects(cancelledShare, /checkout is changing/);
  await new Promise(resolve => setImmediate(resolve));
  registered.get('sweetiebot.cancelCodexShare')();
  await cancellation;
  assert.equal(messages.at(-1).type, 'scm-toolkit-cancel-share');

  const queuedFirst = registered.get('sweetiebot.readCodexContext')();
  const firstFailure = assert.rejects(queuedFirst, /first copy failed/);
  await new Promise(setImmediate);
  const firstRequest = messages.at(-1);
  const requestsBeforeQueue = messages.length;
  const queuedSecond = registered.get('sweetiebot.readCodexConversation')();
  await new Promise(setImmediate);
  assert.equal(messages.length, requestsBeforeQueue, 'A busy copy queues the next request without opening another menu');
  listener({ type: 'scm-toolkit-context-response', id: firstRequest.id, error: 'first copy failed' });
  await firstFailure;
  await new Promise(setImmediate);
  assert.notEqual(messages.at(-1).id, firstRequest.id, 'A failed copy releases the queue after restoring the clipboard');
  listener({ type: 'scm-toolkit-context-response', id: messages.at(-1).id, text: 'Queued conversation', conversationId });
  assert.equal((await queuedSecond).text, 'Queued conversation');
  assert.equal(clipboard, 'previous clipboard');

  const runningCopy = registered.get('sweetiebot.readCodexContext')();
  const runningCancelled = assert.rejects(runningCopy, /checkout is changing/);
  await new Promise(setImmediate);
  const waitingCopy = registered.get('sweetiebot.readCodexConversation')();
  const waitingCancelled = assert.rejects(waitingCopy, /checkout is changing/);
  await registered.get('sweetiebot.cancelCodexCapture')();
  const messagesAfterCancel = messages.length;
  await Promise.all([runningCancelled, waitingCancelled]);
  assert.equal(messages.length, messagesAfterCancel, 'A checkout change cancels queued copies before they open a menu');

  provider.sidebarViews.clear();
  await assert.rejects(
    registered.get('sweetiebot.readCodexConversation')(),
    /Open a Codex conversation/
  );
  disposable.dispose();
  { const id = conversationId;
 let nativeListener,clipboard='user clipboard';const commands=new Map(), messages=[];
 const view={onDidReceiveMessage(fn){nativeListener=fn;return{dispose(){}}},async postMessage(m){messages.push(m);return true}};
 const provider={sidebarViews:new Set([{visible:true,webview:view}]),editorPanels:new Map(),initializeWebview(){},handleMessage(){}};
 const host=vm.createContext({require,URL,setTimeout,clearTimeout,encodeURIComponent});
 vm.runInContext(fs.readFileSync(path.join(__dirname, '../../assets/codex/context-host.js'),'utf8'),host);
 host.scmToolkitRegisterCodexSnapshotProvider(provider,{commands:{registerCommand(k,f){commands.set(k,f);return{dispose(){}}}},env:{clipboard:{readText:async()=>clipboard,writeText:async s=>clipboard=s}}});
 provider.initializeWebview(view,'sidebar',()=>{});
 const result=commands.get('sweetiebot.readCodexConversation')();
 await new Promise(setImmediate);
 clipboard='# Entire native export\n\n> Latest user request\n\n<details><summary>2 previous messages</summary>\n\n> tool payload ' + 'x'.repeat(100000) + '\n</details>\n\n**User:** distinctive historical message ![attachment](data:image/png;base64,AAAAAA==)';
 nativeListener({type:'scm-toolkit-context-response',id:messages.at(-1).id,conversationId:id,nativeCopy:'markdown'});
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(messages.at(-1).copyDeepLink,true);
 clipboard=`codex://threads/${id}?host=remote`;
 nativeListener({type:'scm-toolkit-context-response',id:messages.at(-1).id,conversationId:id,nativeCopy:'deeplink',model:{name:'GPT-6.1'}});
 const snapshot=await result;assert.match(snapshot.text,/historical message/);assert.match(snapshot.text,/Latest user request/);assert(!snapshot.text.includes('AAAAAA'));assert(snapshot.text.length<500);assert.equal(snapshot.source.desktopUrl,`codex://threads/${id}?host=remote`);assert.equal(clipboard,'user clipboard');

  }
  console.log('Read-only Codex snapshot and provenance bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
