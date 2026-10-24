'use strict';

function rateLimitMessage(retryAt, mode = 'clock', now = Date.now()) {
  if (mode === 'relative') {
    const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (!seconds) return 'GitHub API rate-limit pause ended. Ready to retry.';
    const minutes = Math.ceil(seconds / 60);
    const duration = seconds < 60 ? seconds + 's' : minutes < 60 ? minutes + 'm' : Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    return 'GitHub API rate limit reached. Requests are paused for ' + duration + '.';
  }
  return 'GitHub API rate limit reached. Requests are paused until ' + new Date(retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) + '.';
}

function rateLimitError({ status, headers, message = '' }, now = Date.now()) {
  const header = name => headers?.get?.(name) ?? headers?.[name];
  const remaining = header('x-ratelimit-remaining');
  const retry = header('retry-after');
  if (status !== 429 && !(status === 403 && (remaining === '0' || retry || /rate.?limit|abuse detection/i.test(message)))) return null;
  const reset = Number(header('x-ratelimit-reset')) * 1000;
  const retryDelay = retry && /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry || '');
  const deadlines = [remaining === '0' && reset, retryDelay].filter(value => Number.isFinite(value) && value > now);
  const retryAt = deadlines.length ? Math.max(...deadlines) + 1000 : now + 60000;
  const error = Error(rateLimitMessage(retryAt));
  Object.assign(error, { code: 'GITHUB_RATE_LIMIT', rateLimited: true, retryAt, status, configured: deadlines.length > 0 });
  return error;
}

async function githubResponseError(response, fallback) {
  let message = '';
  try { message = String((await response.json())?.message || '').slice(0, 500); } catch { /* Empty or non-JSON error. */ }
  return rateLimitError({ status: response.status, headers: response.headers, message }) || Error(fallback);
}

const notices = new WeakMap();
const cooldowns = new WeakMap();
async function promptRateLimit(vscode, error, { retry, context, retryPriority = 0, schedule = setTimeout } = {}) {
  if (!error?.rateLimited) return false;
  if (!error.configured && error.retryAt <= Date.now() + 61000) {
    const seconds = Number(vscode.workspace?.getConfiguration?.('scmToolkit')?.get('githubRateLimitCooldownSeconds', 900));
    error.retryAt = Math.max(error.retryAt, Date.now() + Math.max(60, Math.min(3600, seconds || 900)) * 1000);
    error.message = 'GitHub API rate limit reached. Requests are paused until ' + new Date(error.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) + '.';
  }
  const prior = cooldowns.get(vscode.window);
  if (prior?.retryAt > error.retryAt) error.retryAt = prior.retryAt;
  error.message = rateLimitMessage(error.retryAt, vscode.workspace?.getConfiguration?.('scmToolkit')?.get('mergeTimelineTimestampMode', 'hidden'));
  error.configured = true;
  cooldowns.set(vscode.window, error);
  const pending = notices.get(vscode.window);
  if (pending?.retryAt >= error.retryAt && (pending.retry || !retry)) {
    if (retry && retryPriority >= pending.priority) { pending.retry = retry; pending.priority = retryPriority; }
    return true;
  }
  const notice = { retryAt: error.retryAt, retry, priority: retryPriority };
  notices.set(vscode.window, notice);
  const action = 'Retry after reset';
  const choice = await vscode.window.showWarningMessage?.(error.message, ...(retry ? [action] : []));
  if (choice === action && notice.retry) {
    const timer = schedule(() => { Promise.resolve().then(() => notice.retry()).catch(failure => vscode.window.showErrorMessage?.(failure.message)); }, Math.max(0, notice.retryAt - Date.now()));
    timer?.unref?.();
    context?.subscriptions?.push({ dispose() { clearTimeout(timer); } });
    vscode.window.showInformationMessage?.('GitHub retry scheduled after the rate-limit pause.');
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

function activeRateLimit(vscode) { const error = cooldowns.get(vscode.window); return error?.retryAt > Date.now() ? error : null; }

module.exports = { rateLimitMessage, activeRateLimit, rateLimitError, githubResponseError, promptRateLimit, parseCLIResponse };
