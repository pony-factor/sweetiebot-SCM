'use strict';

const { createServer } = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { validateSelection } = require('./dashboard');
const { validateResolution, executeResolution } = require('./resolution');

async function createMergeHandoff(rawSelection, { execute = executeResolution, validate = validateResolution,
  onResult = () => {}, ttlMs = 6 * 3600000 } = {}) {
  const selection = validateSelection(rawSelection);
  const route = '/lindsey-merge/' + randomUUID();
  const page = readFileSync(path.join(__dirname, 'handoff.html'), 'utf8');
  let attempted = false, running = false, outcome, failure;
  let staged; // Only the rare oversized handoff occupies local memory.
  const maxBodyBytes = 64 * 1024 * 1024;
  async function readBody(request) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) throw Object.assign(Error('Complete handoff exceeds 64 MiB; nothing was applied.'), { status: 413 });
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(origin).host || ![route, route + '/status', route + '/stage'].includes(request.url)) return json(404, { error: 'Unknown merge handoff.' });
    if (request.url === route + '/status') {
      if (request.method !== 'GET') return json(405, { error: 'Read-only handoff status.' });
      return json(200, { phase: running ? (outcome ? 'continuing' : 'running') : failure ? 'failed' : outcome ? 'finished' : 'ready',
        ...(!running && outcome ? { result: outcome } : {}), ...(failure ? { error: failure } : {}) });
    }
    if (request.method === 'GET' && request.url === route) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page); return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json') return json(403, { error: 'Use the authorized local Lindsey handoff.' });
    if (request.url === route + '/stage') {
      // Staging never performs Git operations. A digest-only link works only
      // after the nonce-bound browser preload has supplied and verified bytes.
      if (attempted) return json(409, { error: 'This handoff has already run.' });
      try {
        const body = await readBody(request);
        if (typeof body?.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.data) ||
            typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id)) throw Error('Invalid staged handoff.');
        if (staged && staged.id !== body.id) return json(409, { error: 'This handoff has a different staged resolution.' });
        if (staged) return json(200, { id: staged.id });
        const bytes = Buffer.from(body.data, 'base64url');
        if (bytes.toString('base64url') !== body.data ||
            createHash('sha256').update(bytes).digest('hex') !== body.id) throw Error('Staged payload digest mismatch.');
        // Decode once, only in this exceptional oversized case; do not unzip
        // again on the Apply page or during Git execution.
        const input = JSON.parse(gunzipSync(bytes, { maxOutputLength: maxBodyBytes }).toString('utf8'));
        validate(input, selection);
        staged = { id: body.id, input };
        return json(201, { id: body.id });
      } catch (error) { return json(error.status || 400, { error: error.message }); }
    }
    if (request.url !== route) return json(404, { error: 'Unknown merge handoff.' });
    if (attempted) return json(running ? 409 : 200, outcome || { error: failure || 'Local merge already in progress.' });
    let input;
    try {
      const received = await readBody(request);
      if (typeof received?.handoffId === 'string') {
        if (!/^[a-f0-9]{64}$/.test(received.handoffId) ||
            Object.keys(received).length !== 1 || received.handoffId !== staged?.id)
          throw Error('Staged handoff missing or mismatched; nothing was applied.');
        input = staged.input;
      } else input = received;
      validate(input, selection);
    } catch (error) { return json(error.status || 400, { error: error.message }); }
    // Claim synchronously after body validation: concurrent tabs cannot execute twice.
    if (attempted) return json(409, { error: 'Local merge already attempted.' });
    attempted = true; running = true; staged = undefined;
    try {
      outcome = await execute(input, selection);
      // A closed dashboard must not turn a verified merge into an apparent failure.
      try {
        const continuation = await onResult(outcome);
        if (continuation && typeof continuation === 'object') outcome = { ...outcome, ...continuation };
      } catch (error) { outcome = { ...outcome, continuationError: error.message }; }
      json(200, outcome);
    } catch (error) {
      failure = error.message;
      json(409, { error: failure });
    } finally { running = false; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  // An accepted local operation must remain observable until it finishes.
  const expire = () => {
    if (!running) { server.close(); return; }
    expiry = setTimeout(expire, 30000);
    expiry.unref();
  };
  let expiry = setTimeout(expire, ttlMs);
  expiry.unref();
  return { url: 'http://127.0.0.1:' + server.address().port + route,
    dispose() { clearTimeout(expiry); server.close(); } };
}

module.exports = { createMergeHandoff };
