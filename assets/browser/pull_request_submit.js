/* Submit only the exact prompt launched by Sweetiebot's PR or merge action. */
function scmToolkitStartPullRequestWorkflow(launchAddress = window.location.href) {
  if (window.top !== window) return;
  const launch = new URL(launchAddress);
  const fragment = new URLSearchParams(launch.hash.slice(1));
  const fragmentLaunch = fragment.get('sweetiebot_pr') === '1' || fragment.get('sweetiebot_merge') === '1';
  const payload = fragmentLaunch ? fragment : launch.searchParams;
  const prLaunch = payload.get('sweetiebot_pr') === '1';
  const mergeLaunch = fragmentLaunch && payload.get('sweetiebot_merge') === '1';
  const collectOnly = mergeLaunch && fragment.get('sweetiebot_collect') === '1';
  const prompt = payload.get('q');
  const existingConversation = /^\/(?:g\/g-p-[A-Za-z0-9-]+\/)?c\/[A-Za-z0-9-]+\/?$/.test(launch.pathname);
  if (launch.origin !== 'https://chatgpt.com' || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname) || collectOnly && existingConversation)
      || prLaunch === mergeLaunch || (!prompt && !collectOnly) || collectOnly && prompt) return;
  if (prompt && (prompt.length > 100000 || (launchAddress === window.location.href && encodeURIComponent(prompt).length > 70000))) return;

  let callback;
  try {
    const candidate = new URL(payload.get('return_to'));
    if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1'
        && candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash
        && (prLaunch && /^\/kefania-draft\/[0-9a-f-]{36}\/(draft|pony)$/.test(candidate.pathname)
          || mergeLaunch && /^\/lindsey-merge\/[0-9a-f-]{36}$/.test(candidate.pathname))) callback = candidate;
  } catch { /* Older manual drafting links do not collect results automatically. */ }
  // Give this action's new tab a blank draft without deleting or replacing the
  // user's shared draft. ChatGPT reads storage in its page world, not preload.
  if (collectOnly && !callback) return;
  let inserting = false;
  let composerIsolated = false;
  if (!collectOnly && fragmentLaunch && (callback || mergeLaunch)) {
    const isolateComposerDraft = () => {
      const storage = window.localStorage;
      const keys = new Set(['oai/apps/lightweight-web/composerDraft/v1', 'oai/apps/conversationDrafts']);
      const prototype = window.Storage.prototype;
      const get = prototype.getItem, set = prototype.setItem, remove = prototype.removeItem;
      const drafts = new Map();
      prototype.getItem = function(name) { return this === storage && keys.has(String(name)) ? drafts.get(String(name)) ?? null : get.call(this, name); };
      prototype.setItem = function(name, value) { if (this === storage && keys.has(String(name))) drafts.set(String(name), String(value)); else set.call(this, name, value); };
      prototype.removeItem = function(name) { if (this === storage && keys.has(String(name))) drafts.delete(String(name)); else remove.call(this, name); };
      // ChatGPT also reads named Storage properties rather than getItem.
      // Keep those reads and writes in the same tab-local draft map.
      const isolated = new Proxy(storage, {
        get(target, name) {
          if (keys.has(name)) return drafts.get(name);
          const value = Reflect.get(target, name, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, name, value) {
          if (keys.has(name)) { drafts.set(name, String(value)); return true; }
          return Reflect.set(target, name, value, target);
        },
        deleteProperty(target, name) {
          if (keys.has(name)) { drafts.delete(name); return true; }
          return Reflect.deleteProperty(target, name);
        }
      });
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => isolated });
    };
    try { require('electron').contextBridge.executeInMainWorld({ func: isolateComposerDraft }); composerIsolated = true; }
    catch { /* Existing composer guards still prevent overwriting a user draft. */ }
  }
  // Remove transport metadata before ChatGPT hydrates or constructs requests.
  // The complete prompt remains in this isolated preload closure.
  if (fragmentLaunch) {
    const clean = new URL(launch.href); clean.hash = ''; clean.searchParams.delete('sweetiebot_launch');
    history.replaceState(history.state, '', clean.href);
  }
  let initialSubmitted = false;
  const collectResult = () => {
    if (!callback) return;
    const expires = Date.now() + (mergeLaunch ? 6 * 3600000 : 1200000);
    let previous, stableSince;
    let retries = 0, errorSince, lastRetry = -Infinity, retryNotice;
    let recoveryAllowed = !collectOnly;
    let followupInjecting = false, followupPending, followupInserted = false;
    let formatPhase = 0, awaitingResponseChange, lastResponseText = '', responseStableSince = Date.now();
    let stagedUrl, staging = false, stageAttemptRound = -1, stagingFailed = false;
    let validatedCompressedHref;
    const validatedGzip = new Map();
    let encodedFallbackUrl, encodingFallback = false, fallbackRaw, fallbackEncodingFailed = false;
    let nodeZlib;
    try { nodeZlib = require('node:zlib'); } catch { /* Sandboxed preload cannot load Node zlib. */ }
    const nativeTransport = (action, payload) =>
      require('electron').ipcRenderer.invoke('sweetiebot:merge-transport', { action, ...payload });
    const stageCompressed = (data, expectedId) => {
      // Almost all handoffs use the short inline gzip URL. Only an oversized
      // complete payload is staged in memory on the nonce-scoped loopback server.
      if (stageAttemptRound === formatPhase || awaitingResponseChange || stagedUrl || staging || !/^[A-Za-z0-9_-]+$/.test(data) ||
          data.length > 48 * 1024 * 1024 ||
          callback.href.length + '#result_gz='.length + data.length <= 80000) return;
      stageAttemptRound = formatPhase;
      if (!nodeZlib) {
        staging = true;
        void nativeTransport('stage', { data, expectedId }).then(id => {
          if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
            throw Error('Invalid staged handoff digest.');
          stagedUrl = callback.href + '#result_id=' + id;
        }).catch(() => { stagingFailed = true; }).finally(() => { staging = false; });
        return;
      }
      let bytes, digest, body;
      try {
        bytes = Buffer.from(data, 'base64url');
        if (bytes.toString('base64url') !== data) throw Error('Noncanonical Base64URL.');
        digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        if (expectedId && expectedId !== digest) throw Error('The short Apply link does not match its payload.');
        body = JSON.stringify({ id: digest, data });
        if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw Error('Oversized staged handoff.');
      } catch { stagingFailed = true; return; }
      staging = true;
      const http = require('node:http');
      const request = http.request({ hostname: '127.0.0.1', port: callback.port,
        method: 'POST', path: callback.pathname + '/stage', timeout: 10000,
        headers: { Origin: callback.origin, Host: callback.host,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let answer = '';
        response.on('data', chunk => { answer += chunk; if (answer.length > 4096) request.destroy(); });
        response.on('end', () => {
          staging = false;
          try {
            if (![200, 201].includes(response.statusCode) || JSON.parse(answer).id !== digest)
              throw Error('Local staging failed.');
            stagedUrl = callback.href + '#result_id=' + digest;
          } catch { stagingFailed = true; }
        });
      });
      request.on('timeout', () => request.destroy(Error('Local staging timed out.')));
      request.on('error', () => { staging = false; stagingFailed = true; });
      request.end(body);
    };
    const clearNotice = () => { retryNotice?.remove(); retryNotice = undefined; };
    const cancelRecovery = event => {
      if (!event.isTrusted || (event.type === 'input' && (inserting || followupInjecting))) return;
      if (event.type === 'click') {
        const button = event.target.closest?.('button');
        if (!/^(?:send|send prompt|stop|stop streaming|retry|try again)$/i.test(
          button?.getAttribute('aria-label') || button?.textContent?.trim() || '')) return;
      }
      recoveryAllowed = false;
      clearNotice();
    };
    const finishRecovery = () => {
      document.removeEventListener('input', cancelRecovery, true);
      document.removeEventListener('click', cancelRecovery, true);
      clearNotice();
    };
    document.addEventListener('input', cancelRecovery, true);
    document.addEventListener('click', cancelRecovery, true);
    const driveFollowup = () => {
      if (!followupPending || !recoveryAllowed) return;
      const composer = document.querySelector('#prompt-textarea')
        || document.querySelector('[contenteditable="true"][role="textbox"].ProseMirror');
      const current = String(composer?.value ?? composer?.innerText ?? composer?.textContent ?? '').trim();
      if (!composer || !composer.getClientRects().length || (current && current !== followupPending)) return;
      if (!current) {
        composer.focus();
        followupInjecting = true;
        try {
          if (composer.tagName === 'TEXTAREA') {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(composer, followupPending);
            composer.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            followupInserted = document.execCommand('insertText', false, followupPending);
          }
        } finally { followupInjecting = false; }
        if (composer.tagName === 'TEXTAREA') followupInserted = true;
        return;
      }
      if (!followupInserted) return;
      const button = document.querySelector(
        'button#composer-submit-button, button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]'
      );
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true'
          || !button.getClientRects().length || /stop|voice/i.test(button.getAttribute('aria-label') || '')
          || button.getAttribute('data-testid') === 'stop-button') return;
      if (globalThis.sweetiebotEnsureMaximumThinking &&
          !globalThis.sweetiebotEnsureMaximumThinking()) return;
      awaitingResponseChange = lastResponseText;
      followupPending = undefined; followupInserted = false; formatPhase++;
      button.click();
    };
    const collect = () => {
      if (Date.now() > expires || window.location.origin !== launch.origin) return finishRecovery();
      const generating = [...document.querySelectorAll('button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop"]')]
        .some(button => {
          const style = window.getComputedStyle?.(button);
          return !button.hidden && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true'
            && style?.display !== 'none' && style?.visibility !== 'hidden'
            && (mergeLaunch || button.getClientRects().length > 0);
        });
      // The nonce-bearing callback validates ownership without depending on
      // ChatGPT's changing message-container markup.
      const links = document.querySelectorAll('a[href]');
      let latest = stagedUrl || encodedFallbackUrl;
      let claimedStagingId;
      for (const link of links) {
        let url;
        try { url = new URL(link.href); } catch { continue; }
        if (url.origin !== callback.origin || url.pathname !== callback.pathname || url.search
            || url.href.length > 80000) continue;
        const result = new URLSearchParams(url.hash.slice(1));
        const expectedKeys = mergeLaunch ? ['result', 'result_gz', 'result_id'] : callback.pathname.endsWith('/pony') ? ['profile'] : ['title', 'body'];
        if ([...result.keys()].some(key => !expectedKeys.includes(key)) ||
            (mergeLaunch ? !expectedKeys.some(key => result.get(key)?.trim()) : !expectedKeys.every(key => result.get(key)?.trim()))) continue;
        if (mergeLaunch) {
          const values = ['result', 'result_gz', 'result_id'].filter(key => result.get(key)?.trim());
          if (values.length !== 1) continue;
          if (values[0] === 'result_id') {
            if (!/^[a-f0-9]{64}$/.test(result.get('result_id'))) continue;
            claimedStagingId = result.get('result_id');
            // A short link is inert until the complete matching payload has
            // been authenticated and staged. Never follow an arbitrary token.
            continue;
          }
          if (result.get('result_gz') && !nodeZlib) {
            if (validatedGzip.get(url.href) === 'valid') {
              validatedCompressedHref = url.href;
              latest = url.href;
            } else if (!validatedGzip.has(url.href)) {
              validatedGzip.set(url.href, 'pending');
              void nativeTransport('validate', { data: result.get('result_gz') })
                .then(valid => validatedGzip.set(url.href, valid === true ? 'valid' : 'invalid'))
                .catch(() => validatedGzip.set(url.href, 'invalid'));
            }
            continue;
          }
          try {
            if (url.href === validatedCompressedHref) { latest = url.href; continue; }
            let input;
            if (result.get('result_gz')) {
              const encoded = result.get('result_gz');
              if (!/^[A-Za-z0-9_-]+$/.test(encoded)) continue;
              const gzip = nodeZlib.gunzipSync(
                Buffer.from(encoded, 'base64url'), { maxOutputLength: 64 * 1024 * 1024 });
              input = JSON.parse(gzip.toString('utf8'));
            } else input = JSON.parse(result.get('result'));
            if (input?.version !== 1 || typeof input.repository !== 'string' || !Array.isArray(input.results)) continue;
            validatedCompressedHref = url.href;
          } catch { continue; } // Reject truncated or malformed encoded links before local execution.
        }
        latest = url.href;
      }
      if (mergeLaunch && !latest && !staging && stageAttemptRound !== formatPhase && !awaitingResponseChange && !generating) {
        // A compact, collapsed transport block is emitted ONLY when the
        // complete gzip URL exceeds the browser budget. It has no raw diff.
        const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]'),
          ...document.querySelectorAll('[data-markdown-text-style="assistant-message"]'),
          ...[...document.querySelectorAll('[data-conversation-role="assistant"]')]
            .map(node => node.parentElement).filter(Boolean)];
        const codes = new Set(messages.flatMap(node => [...node.querySelectorAll('pre code, pre, [data-testid="code-block"]')]));
        for (const code of codes) {
          const match = (code.textContent || '').match(/SWEETIEBOT_HANDOFF_GZIP_V1:([A-Za-z0-9_-]{20,})/);
          if (!match) continue;
          stageCompressed(match[1], claimedStagingId);
          break;
        }
      }
      if (mergeLaunch && !latest && !staging && !stagedUrl) {
        // A fenced final payload is sufficient even if ChatGPT omitted its
        // link. Restrict extraction to assistant code, never the launch prompt.
        // Support both current assistant Markdown and conversation-role markup.
        // Conversation-role markers label the header, while the assistant
        // response body is its sibling inside the same message container.
        const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]'),
          ...document.querySelectorAll('[data-markdown-text-style="assistant-message"]'),
          ...[...document.querySelectorAll('[data-conversation-role="assistant"]')]
            .map(node => node.closest?.('[data-testid^="conversation-turn-"], article') || node.parentElement).filter(Boolean)];
        const codes = new Set(messages.flatMap(node => [...node.querySelectorAll('pre code, pre, [data-testid="code-block"]')]));
        for (const code of codes) {
          try {
            const text = code.textContent || '';
            // Some ChatGPT code blocks include their language/copy toolbar
            // in pre.textContent and have no nested <code> element.
            const start = text.indexOf('{'), end = text.lastIndexOf('}');
            if (start < 0 || end < start) continue;
            const input = JSON.parse(text.slice(start, end + 1));
            if (input?.version !== 1 || typeof input.repository !== 'string' || !Array.isArray(input.results)) continue;
            // A last-resort fenced JSON fallback still becomes a short gzip
            // link automatically, without copying the raw diff into Lindsey.
            const raw = JSON.stringify(input);
            if (!nodeZlib) {
              if (!encodingFallback && !fallbackEncodingFailed && fallbackRaw !== raw && !encodedFallbackUrl) {
                fallbackRaw = raw;
                encodingFallback = true;
                void nativeTransport('compress', { raw }).then(encoded => {
                  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded))
                    throw Error('Invalid compressed fallback.');
                  const url = callback.href + '#result_gz=' + encoded;
                  if (url.length <= 80000) encodedFallbackUrl = url;
                  else stageCompressed(encoded, claimedStagingId);
                }).catch(() => { fallbackEncodingFailed = true; })
                  .finally(() => { encodingFallback = false; });
              }
              continue;
            }
            const encoded = nodeZlib.gzipSync(Buffer.from(raw), { level: 9 }).toString('base64url');
            const url = callback.href + '#result_gz=' + encoded;
            if (url.length <= 80000) latest = url;
            else if (stageAttemptRound !== formatPhase && !generating) stageCompressed(encoded, claimedStagingId);
          } catch { /* Incomplete code blocks remain in the chat until complete. */ }
        }
      }
      // A response can repeat its return link with a revised draft. Stabilize
      // the final candidate once, rather than resetting for every earlier link.
      if (latest !== previous) { previous = latest; stableSince = Date.now(); }
      if (latest && !generating && Date.now() - stableSince >= 2000) {
        finishRecovery(); window.location.assign(latest); return;
      }
      // If the first completed answer omitted its clickable compressed link,
      // ask once for the link, then request raw JSON only as a last resort.
      // Do not overwrite user input, retry Git, or act on an unsubmitted prompt.
      if (mergeLaunch && initialSubmitted && recoveryAllowed && !latest && !staging && !generating) {
        const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]'),
          ...document.querySelectorAll('[data-markdown-text-style="assistant-message"]'),
          ...[...document.querySelectorAll('[data-conversation-role="assistant"]')]
            .map(node => node.parentElement).filter(Boolean)];
        const responseText = assistantNodes.map(node => (node.textContent || '').slice(-4000))
          .filter(Boolean).at(-1) || '';
        if (responseText !== lastResponseText) {
          lastResponseText = responseText; responseStableSince = Date.now();
        }
        if (awaitingResponseChange && responseText !== awaitingResponseChange) awaitingResponseChange = undefined;
        const stable = responseText && !awaitingResponseChange &&
          Date.now() - responseStableSince >= 6000;
        if (stable && !followupPending && formatPhase < 2) {
          followupPending = formatPhase === 0
            ? 'The prepared response did not contain a complete usable Apply with Lindsey link. Retry once using the SAME complete serialized payload. If a gzip/Base64URL link fits 80 KB, return ONLY [Apply with Lindsey](<EXACT_CALLBACK#result_gz=COMPLETE_BASE64URL>). If larger, return ONLY [Apply with Lindsey](<EXACT_CALLBACK#result_id=SHA256_OF_GZIP_BYTES>) and a collapsed <details> block containing a text code fence with SWEETIEBOT_HANDOFF_GZIP_V1:COMPLETE_BASE64URL. Never shorten or omit the payload. Do not show raw Git diffs.'
            : 'The Apply with Lindsey link is still unavailable. As a last resort, output ONLY the COMPLETE versioned resolution object in a fenced json block, with every patch line intact. No abbreviated fields or truncated diffs; the local Sweetiebot browser will construct the Apply link from your JSON.';
        }
      }
      driveFollowup();
      // Recover only a visible response-stream failure in this nonce-bound
      // workflow. Never resend the prompt or retry a local Git handoff.
      let retry;
      if (recoveryAllowed && !latest && !generating) {
        retry = [...document.querySelectorAll('button')].reverse().find(button => {
          const label = button.getAttribute('aria-label') || button.textContent?.trim() || '';
          if (!/^(?:retry|try again)$/i.test(label) || button.disabled ||
              button.getAttribute('aria-disabled') === 'true' || !button.getClientRects().length) return false;
          let parent = button.parentElement;
          for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
            const text = parent.textContent || '';
            if (text.length > 3000) break;
            if (/Error in message stream|Something went wrong while generating the response/i.test(text)) return true;
          }
          return false;
        });
      }
      if (!retry) { errorSince = undefined; clearNotice(); }
      else {
        errorSince ??= Date.now();
        if (Date.now() - errorSince >= 2000 && Date.now() - lastRetry >= 10000) {
          if (!retryNotice) {
            retryNotice = document.createElement('span');
            retryNotice.setAttribute('role', 'status');
            retryNotice.style.cssText = 'display:block;margin-top:8px;font-size:12px';
            retry.insertAdjacentElement('afterend', retryNotice);
          }
          if (retries < 2) {
            retryNotice.textContent = 'Retrying response (' + (++retries) + '/2)…';
            lastRetry = Date.now();
            retry.click();
          } else retryNotice.textContent = 'Automatic retries stopped after two attempts. Retry to continue.';
        }
      }
      setTimeout(collect, 500);
    };
    collect();
  };
  // Collection also covers a deliberate manual Send; publication is owned by
  // the local receiver and its auto-publish preference.
  collectResult();
  if (collectOnly) return;

  // Collapse only the Sweetiebot launch's sidebar once, including delayed hydration.
  // Use the close control rather than changing ChatGPT's shared preferences.
  const sidebarDeadline = Date.now() + 60000;
  let sidebarTimer;
  let sidebarDone = false;
  const finishSidebar = () => {
    sidebarDone = true;
    clearTimeout(sidebarTimer);
    document.removeEventListener('click', onSidebarClick, true);
  };
  const sidebarLabels = new Set(['hide sidebar', 'close sidebar', 'collapse sidebar',
    'show sidebar', 'open sidebar', 'expand sidebar']);
  const onSidebarClick = event => {
    const button = event.target.closest?.('button');
    if (event.isTrusted && sidebarLabels.has((button?.getAttribute('aria-label') || '').toLowerCase())) {
      finishSidebar();
    }
  };
  const collapseSidebar = () => {
    if (sidebarDone) return;
    if (Date.now() >= sidebarDeadline || window.location.origin !== launch.origin) return finishSidebar();
    const button = document.querySelector(
      'button[aria-label="Hide sidebar"], button[aria-label="Close sidebar"], button[aria-label="Collapse sidebar"]'
    );
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length) {
      finishSidebar();
      button.click();
      return;
    }
    sidebarTimer = setTimeout(collapseSidebar, 250);
  };
  document.addEventListener('click', onSidebarClick, true);
  collapseSidebar();

  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const expected = normalize(prompt);
  const samePreparedText = text => text === expected || (inserted && text.replace(/\s/g, '') === expected.replace(/\s/g, ''));
  const deadline = Date.now() + 180000;
  let timer;
  let stopped = false;
  let inserted = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    globalThis.sweetiebotEnsureMaximumThinking?.cancel?.();
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('click', onClick, true);
  };
  const onInput = event => { if (event.isTrusted && !inserting) stop(); };
  const onClick = event => {
    const button = event.target.closest?.('button');
    const label = button?.getAttribute('aria-label') || '';
    if (event.isTrusted && /^(send|send prompt|stop|stop streaming|start voice)$/i.test(label)) stop();
  };
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onClick, true);
  const attempt = () => {
    if (stopped) return;
    if (Date.now() >= deadline || window.location.pathname !== launch.pathname) return stop();
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"].ProseMirror');
    const text = normalize(composer?.value ?? composer?.innerText ?? composer?.textContent);
    if (composerIsolated && composer && text && !samePreparedText(text) && !inserted && composer.getClientRects().length) {
      // Hydration can read its saved draft before preload isolation runs.
      // This is a newly created workflow tab; the shared draft is preserved.
      composer.focus();
      inserting = true;
      if (composer.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(composer, '');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
      inserting = false;
      timer = setTimeout(attempt, 250);
      return;
    }
    if (fragmentLaunch && composer && !text && !inserted && composer.getClientRects().length) {
      composer.focus();
      inserting = true;
      if (composer.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(composer, prompt);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        inserted = true;
      } else {
        // Editing through the browser updates ProseMirror's state as well as DOM.
        inserted = document.execCommand('insertText', false, prompt);
      }
      inserting = false;
      timer = setTimeout(attempt, 250);
      return;
    }
    const button = document.querySelector(
      'button#composer-submit-button, button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]'
    );
    const label = button?.getAttribute('aria-label') || '';
    if (composer && samePreparedText(text) && button && !button.disabled
        && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length && !/stop|voice/i.test(label)
        && button.getAttribute('data-testid') !== 'stop-button') {
      // Do not race Send against model/effort selection or silently submit at
      // Instant when a selector has not hydrated or could not be confirmed.
      if (!globalThis.sweetiebotEnsureMaximumThinking?.()) {
        timer = setTimeout(attempt, 250);
        return;
      }
      stop();
      // Remove the launch payload before sending so a reload cannot send it again.
      const clean = new URL(window.location.href);
      clean.searchParams.delete('q');
      clean.searchParams.delete('sweetiebot_pr');
      clean.searchParams.delete('sweetiebot_merge');
      clean.searchParams.delete('sweetiebot_launch');
      if (fragmentLaunch) clean.hash = '';
      history.replaceState(history.state, '', clean.href);
      initialSubmitted = true;
      button.click();
      return;
    }
    timer = setTimeout(attempt, 250);
  };
  attempt();
}
scmToolkitStartPullRequestWorkflow();

// Keep prompt bodies out of navigation URLs and browser-generated metadata.
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  const args = new URLSearchParams(launch.hash.slice(1));
  if (launch.origin !== 'https://chatgpt.com' || args.get('sweetiebot_merge') !== '1' || args.has('q')) return;
  if (!(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))) return;
  let callback;
  try {
    callback = new URL(args.get('return_to'));
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port
        || callback.username || callback.password || callback.search || callback.hash
        || !/^\/lindsey-merge\/[0-9a-f-]{36}$/.test(callback.pathname)) return;
  } catch { return; }
  const clean = new URL(launch.href); clean.hash = ''; clean.searchParams.delete('sweetiebot_launch');
  history.replaceState(history.state, '', clean.href);
  require('electron').ipcRenderer.invoke('sweetiebot:merge-prompt')
    .then(raw => {
      if (new TextEncoder().encode(raw).length > 100000) throw Error('Merge prompt exceeds transport limit.');
      const { prompt } = JSON.parse(raw);
      if (typeof prompt !== 'string' || !prompt.trim()) throw Error('Empty merge prompt.');
      args.set('q', prompt);
      launch.hash = args.toString();
      scmToolkitStartPullRequestWorkflow(launch.href);
    }).catch(error => console.error('Sweetiebot merge launch:', error.message));
})();
