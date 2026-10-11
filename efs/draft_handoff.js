'use strict';
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const MAX_REQUEST_BYTES = 100000;
const page = readFileSync(join(__dirname, 'draft_confirmation.html'), 'utf8');

// Each independent workflow returns through a same-origin local intake page.
// Collecting a result never calls the publisher; only the confirmation button does.
async function createDraftHandoff(publish) {
  const drafts = new Map();
  const server = createServer({ maxHeaderSize: MAX_REQUEST_BYTES }, async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src https:; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, value) => { response.writeHead(code, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); };
    const fail = (code, error) => json(code, {error});
    const match = /^\/kefania-draft\/([0-9a-f-]{36})(?:\/(draft|pony|state))?$/.exec(request.url);
    if (request.headers.host !== new URL(origin).host || !match) return fail(404, 'Unknown draft.');
    const state = drafts.get(match[1]);
    if (!state || state.expires < Date.now()) return fail(410, 'This confirmation page expired. Start the workflows again.');
    const kind = match[2];
    if (request.method === 'GET') {
      if (kind === 'state') return json(200, { draft: state.draft, pony: state.pony, profile: state.profile, result: state.result, errors: state.errors, publishing: Boolean(state.publishing), attempted: Boolean(state.attempted) });
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(page); return;
    }
    if (request.method !== 'POST' || kind === 'state' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return fail(403, 'Use the local confirmation page.');
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
        state.attempted = true;
        state.publishing = true;
        try {
          const result = await publish({path: `/kefania-draft/${match[1]}`, query: new URLSearchParams(draft).toString()});
          if (!result?.url) return fail(409, 'PR could not be published. Check the VS Code notification and GitHub.');
          state.result = result;
          return json(200, result);
        } finally { state.publishing = false; }
      }
      json(200, { collected: kind });
      Promise.resolve().then(() => state.onResult?.(kind)).catch(() => {});
    } catch { fail(400, 'Request failed. Check the VS Code notification before retrying publication.'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  server.unref();
  const expiry = setTimeout(() => server.close(), 3600000);
  expiry.unref();
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    register(id, {pony, onResult} = {}) { drafts.set(id, {pony, onResult, errors: {}, expires: Date.now() + 3600000}); },
    reportError(id, kind, error) { const state = drafts.get(id); if (state) state.errors[kind] = String(error); },
    dispose() { clearTimeout(expiry); drafts.clear(); server.close(); }
  };
}
module.exports = {createDraftHandoff, MAX_REQUEST_BYTES};
