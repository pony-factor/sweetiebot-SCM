"""App setup controls excluded from ordinary settings autosave."""

APP_PANEL = '''
<p>Install both Apps on your organization and include the repositories they will use.
Save each App’s ID and PEM private key below. Keys stay in macOS Keychain and
are never displayed again. Environment variables override saved settings.</p>
<div class="setting field-row"><span><strong>Repository to check</strong>
<small>Checks authenticate without creating a PR, comment or merge.</small></span>
<input id="app-repository" aria-label="Repository to check" value="pony-factor/sweetiebot-SCM"></div>
<p><a id="app-installations" target="_blank" rel="noopener noreferrer">Manage organization installations</a></p>
<div id="app-cards"></div>
<div class="setting field-row"><span><strong>Local App identities</strong>
<small>Local Kefania PRs and Lindsey’s headless runner. Hosted services and
ChatGPT connectors require separate setup.</small></span>
<select id="app-mode" aria-label="Local App identities">
<option value="legacy">Legacy (Codex Pony)</option>
<option value="separate-apps">Separate Kefania and Lindsey Apps</option></select>
<button type="button" id="app-mode-save">Apply mode</button></div>
<output id="app-status" role="status" aria-live="polite"></output>
'''

APP_SCRIPT = r'''
const appRepository = document.getElementById('app-repository');
async function appRequest(path, values) {
  const response = await fetch('/github-apps' + path + location.search, values ? {
    method:'POST', body:new URLSearchParams(values)
  } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'App settings request failed.');
  return result;
}
function installationLink() {
  const owner = appRepository.value.trim().split('/')[0];
  const link = document.getElementById('app-installations');
  if (/^[A-Za-z0-9-]+$/.test(owner)) {
    link.href = 'https://github.com/organizations/' + owner + '/settings/installations';
  } else link.removeAttribute('href');
}
appRepository.addEventListener('input', installationLink);
installationLink();
async function loadApps() {
  try {
    const status = await appRequest('');
    document.getElementById('app-mode').value = status.mode;
    const cards = document.getElementById('app-cards');
    cards.replaceChildren();
    for (const role of ['kefania', 'lindsey']) {
      const app = status.apps[role];
      const card = document.createElement('fieldset');
      card.className = 'pack-picker';
      // Saved values enter DOM properties, never HTML interpolation.
      card.innerHTML = `<legend>${role === 'kefania' ? 'Kefania' : 'Lindsey'}</legend>
        <label class="setting field-row"><span>App ID</span><input data-id inputmode="numeric"></label>
        <label class="setting field-row"><span>App slug</span><input data-slug autocomplete="off"></label>
        <label class="setting field-row"><span>Private key (.pem)<small data-key-status></small></span>
          <input type="file" data-key accept=".pem" autocomplete="off"></label>
        <p><a data-install target="_blank" rel="noopener noreferrer">Install App</a></p>
        <button type="button" data-save>Save App</button>
        <button type="button" data-check>Check connection</button>
        <output data-result role="status" aria-live="polite"></output>`;
      const id = card.querySelector('[data-id]');
      const slug = card.querySelector('[data-slug]');
      const key = card.querySelector('[data-key]');
      const save = card.querySelector('[data-save]');
      const check = card.querySelector('[data-check]');
      const output = card.querySelector('[data-result]');
      id.value = app.id;
      slug.value = app.slug;
      key.disabled = !status.keychainAvailable;
      const keyStatus = card.querySelector('[data-key-status]');
      keyStatus.textContent = !status.keychainAvailable ? 'Key import requires macOS; environment configuration is supported.'
        : app.keyStored ? 'Saved in Keychain. Choose a PEM to replace it.' : 'No key saved yet.';
      function installLink() {
        const link = card.querySelector('[data-install]');
        if (/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug.value)) {
          link.href = 'https://github.com/apps/' + slug.value + '/installations/new';
        } else link.removeAttribute('href');
      }
      slug.addEventListener('input', installLink);
      installLink();
      save.addEventListener('click', async () => {
        save.disabled = check.disabled = true;
        output.textContent = 'Saving…';
        let pem = '';
        try {
          if (key.files[0]) {
            if (key.files[0].size > 32768) throw new Error('The PEM file is too large.');
            pem = await key.files[0].text();
          }
          const result = await appRequest('/save', {role, id:id.value, slug:slug.value, key:pem});
          key.value = '';
          keyStatus.textContent = result.apps[role].keyStored ? 'Saved in Keychain. Choose a PEM to replace it.' : 'No key saved yet.';
          output.textContent = result.message;
        } catch (error) { output.textContent = error.message; }
        finally { pem = ''; save.disabled = check.disabled = false; }
      });
      check.addEventListener('click', async () => {
        save.disabled = check.disabled = true;
        output.textContent = 'Checking saved credentials and installation…';
        try {
          const result = await appRequest('/check', {role, repository:appRepository.value.trim()});
          output.textContent = result.message;
        } catch (error) { output.textContent = error.message; }
        finally { save.disabled = check.disabled = false; }
      });
      cards.append(card);
    }
  } catch (error) { document.getElementById('app-status').textContent = error.message; }
}
document.getElementById('app-mode-save').addEventListener('click', async event => {
  event.target.disabled = true;
  const output = document.getElementById('app-status');
  try {
    const result = await appRequest('/mode', {mode:document.getElementById('app-mode').value});
    output.textContent = result.message;
  } catch (error) { output.textContent = error.message; }
  finally { event.target.disabled = false; }
});
void loadApps();
'''
