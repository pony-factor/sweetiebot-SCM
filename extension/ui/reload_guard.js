'use strict';

// Per-workspace state survives Reload Window; in-memory guards do not.
const RELOAD_HISTORY_KEY = 'sweetiebot.automaticWindowReloads';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_RELOADS = 2;

function recentReloads(context, now) {
  const history = context.workspaceState?.get(RELOAD_HISTORY_KEY, []);
  if (!Array.isArray(history)) return [];
  return history.filter(entry => entry && typeof entry.revision === 'string' &&
    Number.isFinite(entry.at) && entry.at <= now && now - entry.at < WINDOW_MS);
}

function reloadBlockReason(context, revision, now = Date.now()) {
  const recent = recentReloads(context, now);
  if (recent.some(entry => entry.revision === revision)) {
    return 'the same update already requested a reload recently';
  }
  if (recent.length >= MAX_RELOADS) {
    return 'too many reloads in a short period';
  }
  return '';
}

async function rememberAutomaticReload(context, revision, now = Date.now()) {
  if (!context.workspaceState) return;
  await context.workspaceState.update(RELOAD_HISTORY_KEY, [
    ...recentReloads(context, now), { revision, at: now }
  ]);
}

module.exports = { reloadBlockReason, rememberAutomaticReload, RELOAD_HISTORY_KEY };
