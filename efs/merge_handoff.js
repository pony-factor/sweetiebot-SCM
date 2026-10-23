'use strict';

const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { validateSelection } = require('./merge_dashboard');
const { validateResolution, executeResolution } = require('./merge_resolution');

async function createMergeHandoff(rawSelection, { execute = executeResolution, validate = validateResolution,
  onResult = () => {}, ttlMs = 3600000 } = {}) {
  const selection = validateSelection(rawSelection);
  const route = '/lindsey-merge/' + randomUUID();
  const page = readFileSync(path.join(__dirname, 'merge_handoff.html'), 'utf8');
  let attempted = false, running = false, outcome, failure;
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(origin).host || request.url !== route) return json(404, { error: 'Unknown merge handoff.' });
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page); return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json') return json(403, { error: 'Use the local Lindsey handoff page.' });
    if (attempted) return json(running ? 409 : 200, outcome || { error: failure || 'Local merge already in progress.' });
    let input;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 100000) return json(413, { error: 'Complete handoff exceeds 100 KB.' });
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validate(input, selection);
    } catch (error) { return json(400, { error: error.message }); }
    // Claim synchronously after body validation: concurrent tabs cannot execute twice.
    if (attempted) return json(409, { error: 'Local merge already attempted.' });
    attempted = true; running = true;
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
  const expiry = setTimeout(() => server.close(), ttlMs);
  expiry.unref();
  return { url: 'http://127.0.0.1:' + server.address().port + route,
    dispose() { clearTimeout(expiry); server.close(); } };
}

module.exports = { createMergeHandoff };
