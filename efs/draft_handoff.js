'use strict';
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const MAX_REQUEST_BYTES = 100000;

// Each independent workflow returns through a same-origin local intake page.
// Collecting a result never calls the publisher; only the confirmation button does.
async function createDraftHandoff(publish) {
  // Load the PR-only asset when starting a handoff so an incomplete install
  // cannot prevent unrelated SCM commands from registering during activation.
  const page = readFileSync(join(__dirname, 'draft_confirmation.html'), 'utf8')
    .replace('__MARKDOWN_RENDERER__', readFileSync(join(__dirname, 'merge_dashboard_markdown.js'), 'utf8'));
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
    const match = /^\/kefania-draft\/([0-9a-f-]{36})(?:\/(draft|pony|state|close|merge|merge-history))?$/.exec(request.url);
    if (request.headers.host !== new URL(origin).host || !match) return fail(404, 'Unknown draft.');
    const state = drafts.get(match[1]);
    if (!state || state.expires < Date.now()) return fail(410, 'This confirmation page expired. Start the workflows again.');
    const kind = match[2];
    if (request.method === 'GET') {
      if (kind === 'state') return json(200, { draft: state.draft, pony: state.pony, profile: state.profile, result: state.result, mergeResult: state.mergeResult, merging: Boolean(state.merging), errors: state.errors, mergeChoice: state.mergeChoice, publishing: Boolean(state.publishing), attempted: Boolean(state.attempted), autoPublish: state.autoPublish, closeAfterMerge: (typeof state.closeAfterMerge === 'function' ? await state.closeAfterMerge() : state.closeAfterMerge) === true, ludicrousMode: (typeof state.ludicrousMode === 'function' ? await state.ludicrousMode() : state.ludicrousMode) === true, showKefaniaCloseButton: (typeof state.showKefaniaCloseButton === 'function' ? await state.showKefaniaCloseButton() : state.showKefaniaCloseButton) !== false, appearance: typeof state.appearance === 'function' ? await state.appearance() : state.appearance, kefaniaCloseButtonPosition: normalizeKefaniaClosePosition(typeof state.kefaniaCloseButtonPosition === 'function' ? await state.kefaniaCloseButtonPosition() : state.kefaniaCloseButtonPosition) });
      if (kind === 'close' || kind === 'merge' || kind === 'merge-history') return fail(405, 'Use the confirmation page controls.');
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
        return json(200, result);
      } catch (error) {
        state.mergeChoice = error.code;
        state.errors.merge = error.message || 'Merge failed. Check GitHub.';
        return fail(409, state.errors.merge);
      } finally { state.merging = false; }
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
        state.draft ||= { title: input.title, body: input.body };
      } else {
        if (state.result) return json(200, state.result);
        if (state.attempted) return fail(409, 'Publication was already attempted. Check GitHub before starting again.');
        // Legacy prepared drafts still require the explicit POST publication action.
        const draft = state.draft || input;
        if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 256 || typeof draft.body !== 'string' || !draft.body.trim() || Buffer.byteLength(draft.body) > 60000) return fail(400, 'Wait for a valid PR draft.');
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
  const expiry = setTimeout(() => server.close(), 3600000);
  expiry.unref();
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    register(id, {pony, profile, onResult, onClose, onMerge, onMergePreservingCommits, autoPublish = false, closeAfterMerge = false, ludicrousMode = false, showKefaniaCloseButton = true, kefaniaCloseButtonPosition, kefaniaCloseButtonLeft = true, appearance} = {}) { drafts.set(id, {pony, profile, onResult, onClose, onMerge, onMergePreservingCommits, autoPublish, closeAfterMerge, ludicrousMode, showKefaniaCloseButton, kefaniaCloseButtonPosition: kefaniaCloseButtonPosition ?? (kefaniaCloseButtonLeft === false ? 'right' : 'left'), appearance, errors: {}, expires: Date.now() + 3600000}); },
    reportError(id, kind, error) { const state = drafts.get(id); if (state) state.errors[kind] = String(error); },
    dispose() { clearTimeout(expiry); drafts.clear(); server.close(); }
  };
}
module.exports = {createDraftHandoff, MAX_REQUEST_BYTES};
