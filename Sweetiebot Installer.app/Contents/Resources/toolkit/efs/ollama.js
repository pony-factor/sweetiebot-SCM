'use strict';

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalizeVector } = require('./core');

const execFileAsync = promisify(execFile);

function normalizeBaseUrl(raw) {
  const url = new URL(String(raw || 'http://127.0.0.1:11434'));
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('Workspace Search only connects to a local Ollama server.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must use http or https.');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

function requestJson(baseUrl, endpoint, payload, timeoutMs = 120000) {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(endpoint, `${base.toString().replace(/\/$/, '')}/`);
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = clientFor(url).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: timeoutMs
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Ollama returned ${response.statusCode}: ${text.slice(0, 400)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`Ollama returned invalid JSON: ${error.message}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Ollama request timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}

function getJson(baseUrl, endpoint, timeoutMs = 5000) {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(endpoint, `${base.toString().replace(/\/$/, '')}/`);
  return new Promise((resolve, reject) => {
    const request = clientFor(url).get(url, { timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Ollama returned ${response.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Ollama request timed out.')));
    request.on('error', reject);
  });
}

async function embedTexts(settings, texts) {
  const response = await requestJson(settings.ollamaUrl, '/api/embed', {
    model: settings.embeddingModel,
    input: texts,
    truncate: true,
    keep_alive: '30m'
  });
  if (!Array.isArray(response.embeddings) || response.embeddings.length !== texts.length) {
    throw new Error(`Ollama model ${settings.embeddingModel} did not return one embedding per input.`);
  }
  return response.embeddings.map(normalizeVector);
}

async function readGitConfig(key) {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--get', key], { timeout: 3000, encoding: 'utf8' });
    return String(stdout || '').trim();
  } catch { return ''; }
}

async function resolveChatModel(settings) {
  if (settings.chatModel) return settings.chatModel;
  try {
    const running = await getJson(settings.ollamaUrl, '/api/ps');
    const candidates = (Array.isArray(running.models) ? running.models : []).filter(item => {
      const name = String(item.name || item.model || '').toLowerCase();
      return name && !name.includes('embed');
    });
    candidates.sort((a, b) => (b.size_vram || b.size || 0) - (a.size_vram || a.size || 0));
    const loaded = candidates[0]?.name || candidates[0]?.model;
    if (loaded) return loaded;
  } catch {
    // Fall through to the SCM toolkit's configured commit model.
  }
  return (await readGitConfig('scm-toolkit.ai-commit-model')) || 'qwen2.5-coder:7b';
}

async function ask(settings, model, query, results) {
  const context = results.slice(0, 8).map((result, index) => (
    `[${index + 1}] ${result.relative}:${(result.line || 0) + 1}\n${result.text}`
  )).join('\n\n');
  const response = await requestJson(settings.ollamaUrl, '/api/chat', {
    model,
    stream: false,
    keep_alive: '30m',
    messages: [
      { role: 'system', content: 'Answer only from the supplied workspace search passages. Cite passages with [n]. If the passages do not answer the question, say so.' },
      { role: 'user', content: `Question: ${query}\n\nWorkspace passages:\n${context}` }
    ]
  });
  return String(response.message?.content || '').trim();
}

module.exports = { normalizeBaseUrl, requestJson, getJson, embedTexts, resolveChatModel, ask };
