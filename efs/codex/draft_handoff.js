'use strict';
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const MAX_REQUEST_BYTES = 100000;
const DRAFT_IDLE_MS = 60 * 60 * 1000;
const DRAFT_MAX_AGE_MS = 12 * DRAFT_IDLE_MS;

function mergeFailure(error) {
  const message = String(error?.message || 'Merge failed. Check GitHub.');
  const kind = error?.code === 'SQUASH_AUTHOR_CHOICE_REQUIRED' ? 'method'
    : /resolve the overlapping edits|merge conflicts? detected|conflicting files/i.test(message) ? 'conflict' : 'blocked';
  return { kind, message };
}

// Each independent workflow returns through a same-origin local intake page.
// Collecting a result never calls the publisher; only the confirmation button does.
async function createDraftHandoff(publish) {
  // Load the PR-only asset when starting a handoff so an incomplete install
  // cannot prevent unrelated SCM commands from registering during activation.
  const page = readFileSync(join(__dirname, '../ui/draft_confirmation.html'), 'utf8')
    .replace('__MARKDOWN_RENDERER__', readFileSync(join(__dirname, '../merge/merge_dashboard_markdown.js'), 'utf8'));
  const { normalizeKefaniaClosePosition } = require('./kefania_close_position');
  const drafts = new Map();
  async function publishDraft(id, state) {
    if (state.result) return state.result;
    if (state.attempted) throw new Error('Publication was already attempted. Check GitHub before starting again.');
    state.attempted = true;
    state.publishing = true;
    try {
      const result = await publish({path: `/kefania-draft/${id}`, query: new URLSearchParams(state.draft).toString()});
      if (!result?.url) throw new Error('PR could not be published. Check the VS Code notification and GitHub.');
      state.result = result;
      return result;
    } catch (error) { state.errors.publish = error.message; throw error; }
    finally { state.publishing = false; }
  }
  const server = createServer({ maxHeaderSize: MAX_REQUEST_BYTES }, async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src https:; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, value) => { response.writeHead(code, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); };
    const fail = (code, error) => json(code, {error});
    const match = /^\/kefania-draft\/([0-9a-f-]{36})(?:\/(draft|pony|state|close|merge|merge-history|merge-help))?$/.exec(request.url);
    if (request.headers.host !== new URL(origin).host || !match) return fail(404, 'Unknown draft.');
    const kind = match[2];
    const state = drafts.get(match[1]);
    const now = Date.now();
    if (!state || (state.expires < now && kind !== 'close')) return fail(410, 'This confirmation page expired. Start the workflows again.');
    // The confirmation window polls /state while open. Keep a live workflow
    // usable during long-running commit/push and draft preparation, but still
    // expire unattended pages and enforce a hard cap on old capabilities.
    if (state && kind === 'state' && request.method === 'GET') {
      state.expires = Math.min(now + DRAFT_IDLE_MS, state.registeredAt + DRAFT_MAX_AGE_MS);
    }
    if (request.method === 'GET') {
      if (kind === 'state') return json(200, { draft: state.draft, pony: state.pony, profile: state.profile, result: state.result, mergeResult: state.mergeResult, merging: Boolean(state.merging), errors: state.errors, mergeChoice: state.mergeChoice, mergeIssue: state.mergeIssue, mergeHelpOpening: Boolean(state.mergeHelpOpening), mergeHelpOpened: Boolean(state.mergeHelpOpened), mergeHelpAvailable: typeof state.onMergeHelp === 'function', publishing: Boolean(state.publishing), attempted: Boolean(state.attempted), autoPublish: state.autoPublish, closeAfterMerge: (typeof state.closeAfterMerge === 'function' ? await state.closeAfterMerge() : state.closeAfterMerge) === true, ludicrousMode: (typeof state.ludicrousMode === 'function' ? await state.ludicrousMode() : state.ludicrousMode) === true, showKefaniaCloseButton: (typeof state.showKefaniaCloseButton === 'function' ? await state.showKefaniaCloseButton() : state.showKefaniaCloseButton) !== false, appearance: typeof state.appearance === 'function' ? await state.appearance() : state.appearance, kefaniaCloseButtonPosition: normalizeKefaniaClosePosition(typeof state.kefaniaCloseButtonPosition === 'function' ? await state.kefaniaCloseButtonPosition() : state.kefaniaCloseButtonPosition) });
      if (kind === 'close' || kind === 'merge' || kind === 'merge-history' || kind === 'merge-help') return fail(405, 'Use the confirmation page controls.');
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(page); return;
    }
    if (request.method !== 'POST' || kind === 'state' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return fail(403, 'Use the local confirmation page.');
    if (kind === 'merge' || kind === 'merge-history') {
      if (!state.result) return fail(409, 'Publish the pull request before merging.');
      if (state.mergeResult) return json(200, state.mergeResult);
      if (state.merging) return fail(409, 'Merge already in progress.');
      const merge = kind === 'merge-history' ? state.onMergePreservingCommits : state.onMerge;
      if (kind === 'merge-history' && state.mergeChoice !== 'SQUASH_AUTHOR_CHOICE_REQUIRED') return fail(409, 'Review the squash attribution choice first.');
      if (typeof merge !== 'function') return fail(503, 'Merging is unavailable in this confirmation window.');
      state.merging = true;
      try {
        const result = await merge(state.result);
        if (!result?.merged) throw new Error('GitHub did not confirm the merge. Check the pull request.');
        state.mergeResult = result;
        delete state.errors.merge;
        delete state.errors.mergeHelp;
        delete state.mergeIssue;
        return json(200, result);
      } catch (error) {
        if (error.code) state.mergeChoice = error.code;
        state.mergeIssue = mergeFailure(error);
        state.errors.merge = state.mergeIssue.message;
        return fail(409, state.errors.merge);
      } finally { state.merging = false; }
    }
    if (kind === 'merge-help') {
      if (!state.result || state.mergeResult || !state.mergeIssue) return fail(409, 'A merge blocker is required to review recovery options.');
      if (state.mergeHelpOpening) return fail(409, 'Merge recovery options are already opening.');
      if (typeof state.onMergeHelp !== 'function') return fail(503, 'Merge recovery is not available in this workspace.');
      state.mergeHelpOpening = true;
      delete state.errors.mergeHelp;
      try {
        const opened = await state.onMergeHelp(state.result);
        if (opened === false) throw new Error('The recovery view did not open.');
        state.mergeHelpOpened = true;
        return json(200, { opened: true });
      } catch (error) {
        state.errors.mergeHelp = error.message || 'Could not open the resolution options.';
        return fail(409, state.errors.mergeHelp);
      } finally { state.mergeHelpOpening = false; }
    }
    if (kind === 'close') {
      if (typeof state.onClose !== 'function') return fail(503, 'Cannot close the confirmation window automatically. Use its window controls.');
      try { await state.onClose(); return json(200, {closed:true}); }
      catch { return fail(503, 'Could not close the confirmation window. Use its window controls.'); }
    }
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) return fail(413, 'Result exceeds the 100 KB size limit.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (kind === 'pony') {
        if (typeof input.profile !== 'string' || !input.profile.trim() || Buffer.byteLength(input.profile) > 60000) return fail(400, 'Invalid pony profile.');
        state.profile ||= input.profile;
      } else if (kind === 'draft') {
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256 || typeof input.body !== 'string' || !input.body.trim() || Buffer.byteLength(input.body) > 60000) return fail(400, 'Invalid PR draft.');
        const draft = typeof state.decorateDraft === 'function'
          ? state.decorateDraft({ title: input.title, body: input.body })
          : { title: input.title, body: input.body };
        if (!draft || typeof draft.title !== 'string' || typeof draft.body !== 'string' ||
            Buffer.byteLength(draft.body) > 60000) return fail(400, 'PR description with source details exceeds the 60 KB limit.');
        state.draft ||= draft;
      } else {
        if (state.result) return json(200, state.result);
        if (state.attempted) return fail(409, 'Publication was already attempted. Check GitHub before starting again.');
        // Legacy prepared drafts still require the explicit POST publication action.
        const draft = state.draft || (typeof state.decorateDraft === 'function' ? state.decorateDraft(input) : input);
        if (!draft || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 256 || typeof draft.body !== 'string' || !draft.body.trim() || Buffer.byteLength(draft.body) > 60000) return fail(400, 'Wait for a valid PR draft.');
        state.draft = draft;
        return json(200, await publishDraft(match[1], state));
      }
      json(200, { collected: kind });
      Promise.resolve().then(() => state.onResult?.(kind, kind === 'pony' ? state.profile : undefined)).catch(() => {});
      if (kind === 'draft' && state.autoPublish && !state.attempted) void publishDraft(match[1], state).catch(() => {});
    } catch { fail(400, 'Request failed. Check the VS Code notification before retrying publication.'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  server.unref();
  // Draft writes expire, but the close control lives until this host is disposed.
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    register(id, {pony, profile, onResult, onClose, onMerge, decorateDraft, onMergePreservingCommits, onMergeHelp, autoPublish = false, closeAfterMerge = false, ludicrousMode = false, showKefaniaCloseButton = true, kefaniaCloseButtonPosition, kefaniaCloseButtonLeft = true, appearance} = {}) { const registeredAt = Date.now(); drafts.set(id, {pony, profile, onResult, onClose, onMerge, decorateDraft, onMergePreservingCommits, onMergeHelp, autoPublish, closeAfterMerge, ludicrousMode, showKefaniaCloseButton, kefaniaCloseButtonPosition: kefaniaCloseButtonPosition ?? (kefaniaCloseButtonLeft === false ? 'right' : 'left'), appearance, errors: {}, registeredAt, expires: registeredAt + DRAFT_IDLE_MS}); },
    reportError(id, kind, error) { const state = drafts.get(id); if (state) state.errors[kind] = String(error); },
    dispose() { drafts.clear(); server.close(); }
  };
}
module.exports = {createDraftHandoff, MAX_REQUEST_BYTES};
