'use strict';

function rateLimitError({ status, headers, message = '' }, now = Date.now()) {
  const header = name => headers?.get?.(name) ?? headers?.[name];
  const remaining = header('x-ratelimit-remaining');
  const retry = header('retry-after');
  if (status !== 429 && !(status === 403 && (remaining === '0' || retry || /rate.?limit|abuse detection/i.test(message)))) return null;
  const reset = Number(header('x-ratelimit-reset')) * 1000;
  const retryDelay = retry && /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry || '');
  const deadlines = [remaining === '0' && reset, retryDelay].filter(value => Number.isFinite(value) && value > now);
  const retryAt = deadlines.length ? Math.max(...deadlines) + 1000 : now + 60000;
  const time = new Date(retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const error = Error('GitHub API rate limit reached. Requests are paused until ' + time + '.');
  Object.assign(error, { code: 'GITHUB_RATE_LIMIT', rateLimited: true, retryAt, status });
  return error;
}

async function githubResponseError(response, fallback) {
  let message = '';
  try { message = String((await response.json())?.message || '').slice(0, 500); } catch { /* Empty or non-JSON error. */ }
  return rateLimitError({ status: response.status, headers: response.headers, message }) || Error(fallback);
}

const notices = new WeakMap();
async function promptRateLimit(vscode, error, { retry, context, schedule = setTimeout } = {}) {
  if (!error?.rateLimited) return false;
  if (notices.get(vscode.window) >= error.retryAt) return true;
  notices.set(vscode.window, error.retryAt);
  const action = 'Retry after reset';
  const choice = await vscode.window.showWarningMessage?.(error.message, ...(retry ? [action] : []));
  if (choice === action && retry) {
    const timer = schedule(() => { Promise.resolve().then(retry).catch(failure => vscode.window.showErrorMessage?.(failure.message)); }, Math.max(0, error.retryAt - Date.now()));
    timer?.unref?.();
    context?.subscriptions?.push({ dispose() { clearTimeout(timer); } });
  }
  return true;
}

function parseCLIResponse(output) {
  let body = output, status, headers = {};
  while (body.startsWith('HTTP/')) {
    const separator = /\r?\n\r?\n/.exec(body);
    if (!separator) break;
    const lines = body.slice(0, separator.index).split(/\r?\n/);
    status = Number(/^HTTP\/\S+ (\d+)/.exec(lines.shift())?.[1]);
    headers = Object.fromEntries(lines.map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]; }));
    body = body.slice(separator.index + separator[0].length);
  }
  return { body, status, headers };
}

module.exports = { rateLimitError, githubResponseError, promptRateLimit, parseCLIResponse };
