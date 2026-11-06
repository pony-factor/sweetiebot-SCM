"""First-run Sweetiebot welcome tour, wired to the real settings form."""

WELCOME_MARKUP = """
<button type="button" id="welcome-reopen" class="welcome-reopen">Welcome tour</button>
<div id="welcome-shade" class="welcome-shade" hidden></div>
<aside id="welcome-tour" class="welcome-tour" role="dialog" aria-modal="false"
      aria-labelledby="welcome-heading" aria-describedby="welcome-description" data-step="0" hidden>
  <div class="welcome-topline"><span class="welcome-eyebrow">SWEETIEBOT · GETTING STARTED</span>
    <button type="button" id="welcome-close" class="welcome-close" aria-label="Close welcome tour">×</button></div>
  <div class="welcome-progress" aria-label="Tour progress"><span id="welcome-progress-fill"></span></div>
  <span id="welcome-counter" class="welcome-counter" aria-live="polite">Step 1 of 6</span>
  <div class="welcome-body">
    <section class="welcome-step" data-welcome-step="0">
      <div class="welcome-symbol" aria-hidden="true">✦</div>
      <h2 id="welcome-heading">Welcome to Sweetiebot</h2>
      <p id="welcome-description">Make your workspace your own. We'll choose your controls, arrange what goes where, and add your colors.</p>
      <div class="welcome-overview"><span>01 · Interface</span><span>02 · Message bar</span><span>03 · Codex</span><span>04 · Colors</span></div>
      <p class="welcome-note">You can skip or return to this tour from Magic Settings at any time. Changes save in your existing settings.</p>
    </section>
    <section class="welcome-step" data-welcome-step="1" hidden>
      <h2>Choose your interface</h2>
      <p>Turn on the elements you want. These controls update the same settings as the full editor.</p>
      <label class="welcome-choice"><span><strong>Branch picker</strong><small>Pick a branch from Source Control.</small></span><input type="checkbox" data-welcome-setting="branchPicker"></label>
      <label class="welcome-choice"><span><strong>Compact window</strong><small>Show the compact/restore shortcut.</small></span><input type="checkbox" data-welcome-setting="compactWindowButton"></label>
      <label class="welcome-choice"><span><strong>New workspace window</strong><small>Open a second workspace window.</small></span><input type="checkbox" data-welcome-setting="newWorkspaceWindowButton"></label>
      <label class="welcome-choice"><span><strong>Accent-filled buttons</strong><small>Use your theme accent for SCM actions.</small></span><input type="checkbox" data-welcome-setting="filledButtons"></label>
      <label class="welcome-choice"><span><strong>Pegasus Send/Stop</strong><small>Use Sweetiebot's wing icons in Codex.</small></span><input type="checkbox" data-welcome-setting="codexSendWing"></label>
    </section>
    <section class="welcome-step" data-welcome-step="2" hidden>
      <h2>Arrange your message bar</h2>
      <p>The Message bar editor is open behind this guide. Drag controls between <em>Before message</em>, <em>After message</em>, and <em>Available buttons</em> to show, hide, or reorder them.</p>
      <p class="welcome-tip">The message input stays fixed. You can also move a focused button with the editor's keyboard controls.</p>
      <button type="button" class="welcome-open-editor" data-welcome-section="Message bar">Go to message bar editor</button>
    </section>
    <section class="welcome-step" data-welcome-step="3" hidden>
      <h2>Arrange your Codex composer</h2>
      <p>Move the input, attachment and usage controls, permissions, location, clipboard actions, and Send/Stop into the layout you prefer.</p>
      <p class="welcome-tip">Use the actual Codex composer editor behind this guide. Hidden native buttons remain accessible through More composer controls.</p>
      <button type="button" class="welcome-open-editor" data-welcome-section="Codex">Go to Codex editor</button>
    </section>
    <section class="welcome-step" data-welcome-step="4" hidden>
      <h2>Pick your colors</h2>
      <p>Sweetiebot follows your VS Code theme by default. Choose optional Codex accents below or restore theme defaults.</p>
      <div class="welcome-color-preview" id="welcome-color-preview" aria-hidden="true"><span>Send</span><span>●</span></div>
      <label class="welcome-color"><span>Send background</span><input type="color" data-welcome-color="codexSendBackground" value="#2f81f7"></label>
      <label class="welcome-color"><span>Send icon</span><input type="color" data-welcome-color="codexSendForeground" value="#ffffff"></label>
      <label class="welcome-color"><span>Composer controls</span><input type="color" data-welcome-color="codexComposerLabelColor" value="#8b949e"></label>
      <label class="welcome-color"><span>Drop highlight</span><input type="color" data-welcome-color="codexDropAccent" value="#2f81f7"></label>
      <button type="button" id="welcome-use-theme" class="welcome-secondary">Use VS Code theme defaults</button>
      <p class="welcome-note">Color overrides apply after rebuilding the app. Other parts of Sweetiebot continue to follow the active VS Code theme.</p>
    </section>
    <section class="welcome-step" data-welcome-step="5" hidden>
      <div class="welcome-symbol" aria-hidden="true">✓</div>
      <h2>You're ready to go</h2>
      <p>Your choices use Sweetiebot's normal autosave. Rebuild the app to apply workbench and Codex customizations, then reload VS Code if requested.</p>
      <p class="welcome-note">You can always return to Magic Settings to refine the layout, colors, and advanced options.</p>
    </section>
  </div>
  <div class="welcome-bottom">
    <output id="welcome-status" role="status" aria-live="polite"></output>
    <div class="welcome-buttons"><button type="button" id="welcome-skip" class="welcome-secondary">Skip tour</button>
      <button type="button" id="welcome-back" class="welcome-secondary" hidden>Back</button>
      <button type="button" id="welcome-next" class="welcome-primary">Get started</button></div>
  </div>
</aside>
"""

WELCOME_STYLE = """
.welcome-reopen{margin:0 0 16px;padding:7px 13px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--text);font:inherit;cursor:pointer}
.welcome-reopen:hover{border-color:var(--accent)}
.welcome-shade{position:fixed;inset:0;z-index:1390;background:#000a;backdrop-filter:blur(3px)}
.welcome-tour{position:fixed;z-index:1400;top:24px;right:24px;width:min(410px,calc(100vw - 28px));max-height:calc(100vh - 36px);display:flex;flex-direction:column;overflow:auto;padding:19px;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:18px;background:var(--panel);color:var(--text);box-shadow:0 18px 65px #0009;font:inherit}
.welcome-tour[hidden],.welcome-shade[hidden],.welcome-step[hidden],.welcome-tour button[hidden]{display:none}
.welcome-tour[data-step="0"]{left:50%;top:50%;right:auto;bottom:auto;transform:translate(-50%,-50%);width:min(480px,calc(100vw - 28px))}
.welcome-tour[data-step="2"],.welcome-tour[data-step="3"],.welcome-tour[data-step="4"]{top:auto;right:auto;left:18px;bottom:18px}
.welcome-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}
.welcome-eyebrow{font-size:10px;font-weight:750;letter-spacing:.12em;color:var(--muted)}
.welcome-close{font-size:24px;line-height:1;border:0;background:transparent;color:var(--muted);cursor:pointer}
.welcome-progress{height:4px;border-radius:5px;background:var(--line);margin:14px 0 7px;overflow:hidden}
#welcome-progress-fill{display:block;height:100%;width:16.67%;background:var(--accent);transition:width .18s}
.welcome-counter{font-size:11px;color:var(--muted)}
.welcome-body{overflow:auto;min-height:0;padding:3px 1px 6px}
.welcome-step h2{font-size:21px;margin:7px 0 10px}
.welcome-step p{margin:0 0 13px;color:var(--muted);line-height:1.5}
.welcome-symbol{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:color-mix(in srgb,var(--accent) 16%,var(--bg));color:var(--accent);font-size:29px;margin:12px 0}
.welcome-overview{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:20px 0}
.welcome-overview span{padding:12px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);font-size:12px}
.welcome-note,.welcome-tip{padding:10px;border:1px dashed var(--line);border-radius:10px;font-size:12px}
.welcome-choice{display:flex;align-items:center;justify-content:space-between;gap:15px;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:10px;margin:8px 0;cursor:pointer}
.welcome-choice strong{font-size:13px}.welcome-choice small{font-size:11px}
.welcome-choice input{width:18px;height:18px;accent-color:var(--accent);flex:none}
.welcome-open-editor,.welcome-secondary,.welcome-primary{padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:inherit;cursor:pointer}
.welcome-open-editor{width:100%;border-color:var(--accent)}
.welcome-primary{border-color:var(--accent);background:var(--accent);color:#fff;font-weight:650}
.welcome-color{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:9px 0}
.welcome-color input{width:56px;height:34px;border:1px solid var(--line);border-radius:8px;background:var(--bg);cursor:pointer}
.welcome-color-preview{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:10px;background:#2f81f7;color:#fff;font-weight:650}
#welcome-use-theme{margin-top:12px;width:100%}
.welcome-bottom{border-top:1px solid var(--line);padding-top:13px}
.welcome-buttons{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
#welcome-status{display:block;min-height:17px;margin-bottom:4px;color:var(--muted);font-size:11px}
.welcome-tour button:focus-visible,.welcome-reopen:focus-visible,.welcome-tour input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:620px){.welcome-tour,.welcome-tour[data-step="2"],.welcome-tour[data-step="3"],.welcome-tour[data-step="4"]{left:14px;right:14px;bottom:12px;top:auto;transform:none;width:auto;max-height:min(65vh,620px)}.welcome-tour[data-step="0"]{left:14px;right:14px;top:50%;bottom:auto;transform:translateY(-50%);width:auto;max-height:90vh}}
@media(prefers-reduced-motion:reduce){#welcome-progress-fill{transition:none}}
"""

WELCOME_SCRIPT = r"""
const welcomeTour = document.getElementById('welcome-tour');
const welcomeShade = document.getElementById('welcome-shade');
const welcomeSteps = [...document.querySelectorAll('[data-welcome-step]')];
const welcomeStatus = document.getElementById('welcome-status');
const welcomeBack = document.getElementById('welcome-back');
const welcomeNext = document.getElementById('welcome-next');
const welcomeSkip = document.getElementById('welcome-skip');
let welcomeStep = 0;

const welcomeColorDefaults = {
  codexSendBackground: '#2f81f7',
  codexSendForeground: '#ffffff',
  codexComposerLabelColor: '#8b949e',
  codexDropAccent: '#2f81f7'
};
function welcomeField(name) {
  return settingsForm.querySelector('[name="' + name + '"]');
}
function welcomeHex(value, fallback) {
  const match = /^#([a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.exec(value || '');
  if (!match) return fallback;
  const raw = match[1];
  return '#' + (raw.length <= 4 ? [...raw.slice(0, 3)].map(x => x + x).join('') : raw.slice(0, 6));
}
function syncWelcomeControls() {
  for (const input of welcomeTour.querySelectorAll('[data-welcome-setting]')) {
    const field = welcomeField(input.dataset.welcomeSetting);
    input.checked = Boolean(field?.checked);
    input.disabled = !field;
  }
  for (const input of welcomeTour.querySelectorAll('[data-welcome-color]')) {
    const name = input.dataset.welcomeColor;
    input.value = welcomeHex(welcomeField(name)?.value, welcomeColorDefaults[name]);
  }
  const preview = document.getElementById('welcome-color-preview');
  preview.style.background = document.querySelector('[data-welcome-color="codexSendBackground"]').value;
  preview.style.color = document.querySelector('[data-welcome-color="codexSendForeground"]').value;
}
function welcomeOpenSection(section) {
  const tab = settingsTabs.find(item => item.textContent.trim() === section);
  if (!tab) return;
  activateSettingsCategory(tab);
  const selector = section === 'Message bar' ? '.message-bar-setting' : '.codex-layout-editor';
  const editor = document.querySelector(selector);
  (editor || document.querySelector('#' + tab.getAttribute('aria-controls')))?.scrollIntoView({block: 'start', behavior: 'smooth'});
}
function setWelcomeStep(index) {
  welcomeStep = Math.max(0, Math.min(welcomeSteps.length - 1, index));
  welcomeTour.dataset.step = String(welcomeStep);
  welcomeShade.hidden = welcomeStep !== 0;
  for (const step of welcomeSteps) step.hidden = Number(step.dataset.welcomeStep) !== welcomeStep;
  document.getElementById('welcome-counter').textContent = 'Step ' + (welcomeStep + 1) + ' of ' + welcomeSteps.length;
  document.getElementById('welcome-progress-fill').style.width = ((welcomeStep + 1) * 100 / welcomeSteps.length) + '%';
  welcomeBack.hidden = welcomeStep === 0;
  welcomeNext.textContent = welcomeStep === 0 ? 'Get started' : welcomeStep === welcomeSteps.length - 1 ? 'Finish' : 'Next';
  welcomeStatus.textContent = '';
  if (welcomeStep === 2) welcomeOpenSection('Message bar');
  if (welcomeStep === 3 || welcomeStep === 4) welcomeOpenSection('Codex');
  if (welcomeStep === 4) syncWelcomeControls();
}
function openWelcomeTour() {
  syncWelcomeControls();
  welcomeTour.hidden = false;
  setWelcomeStep(0);
  welcomeNext.focus();
}
function closeWelcomeTour() {
  welcomeTour.hidden = true;
  welcomeShade.hidden = true;
  const url = new URL(location.href);
  url.searchParams.delete('welcome');
  history.replaceState(null, '', url.pathname + url.search);
  document.getElementById('welcome-reopen').focus();
}
for (const input of welcomeTour.querySelectorAll('[data-welcome-setting]')) {
  input.addEventListener('change', () => {
    const field = welcomeField(input.dataset.welcomeSetting);
    if (!field) return;
    field.checked = input.checked;
    field.dispatchEvent(new Event('change', {bubbles: true}));
  });
}
for (const input of welcomeTour.querySelectorAll('[data-welcome-color]')) {
  input.addEventListener('input', () => {
    const field = welcomeField(input.dataset.welcomeColor);
    if (!field) return;
    field.value = input.value;
    field.dispatchEvent(new Event('input', {bubbles: true}));
    syncWelcomeControls();
  });
}
document.getElementById('welcome-use-theme').addEventListener('click', () => {
  for (const name of [...Object.keys(welcomeColorDefaults), 'codexNewChatDotColor']) {
    const field = welcomeField(name);
    if (!field) continue;
    field.value = '';
    field.dispatchEvent(new Event('input', {bubbles: true}));
  }
  syncWelcomeControls();
  welcomeStatus.textContent = 'Color overrides cleared; VS Code theme will be used.';
});
for (const button of document.querySelectorAll('[data-welcome-section]')) {
  button.addEventListener('click', () => welcomeOpenSection(button.dataset.welcomeSection));
}
welcomeBack.addEventListener('click', () => setWelcomeStep(welcomeStep - 1));
welcomeNext.addEventListener('click', async () => {
  if (welcomeStep < welcomeSteps.length - 1) {
    setWelcomeStep(welcomeStep + 1);
    return;
  }
  welcomeNext.disabled = true;
  welcomeStatus.textContent = 'Saving your choices…';
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const saved = await queueAutosave();
  welcomeNext.disabled = false;
  if (!saved) {
    welcomeStatus.textContent = 'Could not save. Check the settings status and try again.';
    return;
  }
  closeWelcomeTour();
});
welcomeSkip.addEventListener('click', closeWelcomeTour);
document.getElementById('welcome-close').addEventListener('click', closeWelcomeTour);
document.getElementById('welcome-reopen').addEventListener('click', openWelcomeTour);
if (new URLSearchParams(location.search).get('welcome') === '1') openWelcomeTour();
"""
