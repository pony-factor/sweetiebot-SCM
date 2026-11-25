'use strict';

// Resolve canonical and legacy repository settings using Git's scope ordering.
// A legacy local/worktree override must not be masked by a migrated global key.
// Within the same scope, the new key always wins.
const ranks = { system: 0, global: 1, local: 2, worktree: 3, command: 4 };

async function readRepositoryGitSetting(run, key, options = []) {
  const read = async name => {
    try {
      const output = await run(['config', ...options, '--show-scope', '--get', name]);
      const separator = output.indexOf('\t');
      const scope = output.slice(0, separator);
      if (separator < 0 || !Object.hasOwn(ranks, scope)) return { rank: -1, value: output };
      return { rank: ranks[scope], value: output.slice(separator + 1) };
    } catch (error) {
      if (error.code !== 1) throw error;
      return null;
    }
  };
  const current = await read(key);
  const legacy = key.startsWith('sweetiebot.')
    ? await read('scm-toolkit.' + key.slice('sweetiebot.'.length)) : null;
  const selected = current && (!legacy || current.rank >= legacy.rank) ? current : legacy;
  if (selected) return selected.value;
  throw Object.assign(new Error('Git configuration key is not set'), { code: 1 });
}

module.exports = { readRepositoryGitSetting };
