'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  codexConversationUrl,
  githubRepository,
  kefaniaRulesPath,
  matchSweetiebotPonyCatalog,
  normalizeConversationSource,
  pullRequestPrompt,
  readSweetiebotPony,
  readLudicrousMode,
  registerPullRequestCommand,
} = require('../efs/pull_request');

async function run() {
  assert.equal(await readLudicrousMode(async (_git, args) => {
    assert.deepEqual(args, ['config', '--global', '--type=bool', '--get', 'scm-toolkit.ludicrous-mode']);
    return {stdout:'true\n'};
  }), true);
  assert.equal(await readLudicrousMode(async () => ({stdout:'false\n'})), false);
  assert.equal(await readLudicrousMode(async () => {throw new Error('Unset preference');}), false);

  for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
    assert.equal(githubRepository(remote), 'https://github.com/owner/repo');
  }
  for (const remote of ['https://github.com.attacker.test/owner/repo', 'https://user:password@github.com/owner/repo', 'file:///local', undefined]) {
    assert.equal(githubRepository(remote), undefined);
  }

  assert.equal(
    kefaniaRulesPath('/workspace/project'),
    path.join('/workspace', 'kefania', 'PULL_REQUEST.md')
  );

  const ponyCatalog = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../scripts/branch_name_packs.json'), 'utf8')
  );
  const berryPunch = matchSweetiebotPonyCatalog('berry-punch', ponyCatalog);
  assert.equal(berryPunch.packId, 'g4-mares');
  assert.equal(berryPunch.packLabel, 'G4 mares');
  const celena = matchSweetiebotPonyCatalog('celena', ponyCatalog);
  assert.equal(celena.packId, 'idw-comics');
  assert.equal(celena.source, undefined, 'Built-in source URLs now live in Kefania');
  assert(ponyCatalog.packs.every(pack => !pack.sources), 'Migrated catalog sources must not remain duplicated');
  const legacyCelena = matchSweetiebotPonyCatalog('magical-ponycelena', ponyCatalog);
  assert.equal(legacyCelena.slug, 'magical-ponycelena');
  assert.equal(legacyCelena.canonicalSlug, 'celena');
  assert.equal(legacyCelena.name, 'Celena');
  assert.equal(legacyCelena.source, celena.source);
  assert.equal((await readSweetiebotPony('magical-ponycelena')).name, 'Celena');
  assert.equal(ponyCatalog.packs.flatMap(pack => pack.names).filter(name => name === 'celena').length, 1);
  // Every corrected branch remains recognizable without appearing as a new branch option.
  const legacyNames = {
    'athletic-dancerflashdancer': 'flashdancer',
    'builder-ponyambrosia': 'ambrosia',
    'clerkraspberry-vinaigrette': 'raspberry-vinaigrette',
    'inquisitive-shopperrainbowshine': 'rainbowshine',
    'librarianamethyst-maresbury': 'amethyst-maresbury',
    'masseuse-ponyquake': 'quake-masseuse',
    'nasal-ponypretzel': 'pretzel',
    'posh-ponycayenne': 'cayenne-canterlot',
    'pushy-ponyturf': 'turf',
    'salesponyjasmine-leaf': 'jasmine-leaf',
    'serene-dignitaryimmemoria': 'immemoria',
    'announcer-ponymadden': 'madden',
    'astro-ponyneptunio': 'neptunio',
    'caballerons-bandolerobiff': 'biff',
    'caballerons-brigandrogue': 'rogue',
    'caballerons-thugwithers': 'withers',
    'clumsy-clownsponypratfall': 'pratfall',
    'coloraturas-stylistlimelight': 'limelight',
    'dancing-clownsponycaramel': 'caramel',
    'elite-ponyponet': 'ponet',
    'emt-ponyhermes': 'hermes',
    'eyeshade-ponykarat': 'karat',
    'henchponypickpocket': 'pickpocket',
    'horticultural-pegasusevergreen': 'evergreen',
    'messy-stallionpigpen': 'pigpen',
    'pegasus-dadnightjar': 'nightjar',
    'sandbars-dadbeachcomber': 'beachcomber',
    'security-guardlockdown': 'lockdown',
    'snide-bullyscore': 'score',
    'train-conductorsteamer': 'steamer',
    'clever-schoolponyboysenberry': 'boysenberry',
    'rookie-archaeologistgentiana': 'gentiana',
    'the-great-and-powerfultwily': 'twily',
  };
  assert.equal(Object.keys(legacyNames).length + 1, 34); // Celena is tested above.
  const allSelectableNames = ponyCatalog.packs.flatMap(pack => pack.names);
  const correctedNames = new Set([...Object.values(legacyNames), 'celena']);
  assert.equal(correctedNames.size, 34);
  for (const name of correctedNames) {
    assert.equal(allSelectableNames.filter(candidate => candidate === name).length, 1,
      `${name} must be offered in exactly one built-in pony pack`);
  }
  for (const [old, target] of Object.entries(legacyNames)) {
    const legacy = matchSweetiebotPonyCatalog(old, ponyCatalog);
    const canonical = matchSweetiebotPonyCatalog(target, ponyCatalog);
    assert(canonical, `Missing target: ${target}`);
    assert(legacy, `Missing legacy alias: ${old}`);
    assert.equal(legacy.slug, old);
    assert.equal(legacy.packId, canonical.packId);
    assert.equal(legacy.name, canonical.name || target.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' '));
    assert.equal(legacy.source, canonical.source);
    assert(!ponyCatalog.packs.some(pack => pack.names.includes(old)));
  }
  assert.equal(matchSweetiebotPonyCatalog('quake-masseuse', ponyCatalog).name, 'Quake');
  assert.equal(matchSweetiebotPonyCatalog('cayenne-canterlot', ponyCatalog).name, 'Cayenne');
  assert.equal(matchSweetiebotPonyCatalog('quake', ponyCatalog).packId, 'g4-stallions');
  assert.equal(matchSweetiebotPonyCatalog('cayenne', ponyCatalog).packId, 'fallout-equestria');
  assert.equal(matchSweetiebotPonyCatalog('not-a-sweetiebot-pony', ponyCatalog), undefined);
  assert.equal((await readSweetiebotPony('berry-punch')).packId, 'g4-mares');
  const honeyDrop = matchSweetiebotPonyCatalog('honey-drop', ponyCatalog);
  assert.equal(honeyDrop.packId, 'g4-fillies');
  assert.deepEqual(honeyDrop.images, [{
    url: 'https://www.twibooru.org/107469',
    label: 'Twibooru #107469',
    kind: 'show screenshot'
  }]);
  assert.equal((await readSweetiebotPony('honey-drop')).images[0].url, 'https://www.twibooru.org/107469');

  const chatSource = {
    kind: 'chatgpt',
    uuid: '11111111-2222-4333-8444-555555555555',
    url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555'
  };
  assert.deepEqual(normalizeConversationSource(chatSource), chatSource);
  assert.equal(normalizeConversationSource({ ...chatSource, uuid: 'not-a-uuid' }), undefined);
  assert.equal(normalizeConversationSource({ ...chatSource, url: 'file:///tmp/source' }), undefined);

  const codexUrl = codexConversationUrl('019c56c3-06fc-7db3-a928-9c3607e17129');
  assert.match(codexUrl, /^https:\/\/vscode\.dev\/redirect\?url=/);
  assert(codexUrl.includes('019c56c3-06fc-7db3-a928-9c3607e17129'));

  const rules = '# Canonical Kafania rules\n\nExplain the actual diff.';
  const prompt = pullRequestPrompt({
    branch: 'draft',
    repositoryPath: '/repo with spaces',
    repositoryUrl: 'https://github.com/owner/repo',
    base: 'main',
    instructions: rules,
    source: chatSource,
    conversationContext: 'The conversation wanted to preserve provenance.',
    pony: berryPunch,
    mcpServer: 'codex-drafter',
    mcpTool: 'github_create_pull_request'
  });
  assert(prompt.includes('in repository https://github.com/owner/repo, against'));
  assert(!prompt.includes('/repo with spaces'));
  assert(prompt.includes(rules));
  assert.match(prompt, /Prefer Kafania's connected MCP server "codex-drafter"/);
  assert.match(prompt, /"github_create_pull_request"/);
  assert.match(prompt, /github_get_pull_request_context/);
  assert.match(prompt, /expectedHeadSha/);
  assert.match(prompt, /continue using the authenticated GitHub fallback/);
  assert.match(prompt, /A VS Code stdio registration alone does not expose tools to ChatGPT/);
  assert(!prompt.includes('instead of substituting a different GitHub writer'));
  assert(!prompt.includes('If the Kefania tools are unavailable here, stop'));
  assert.match(prompt, /Do not claim publication succeeded/);
  assert(prompt.includes(chatSource.uuid));
  assert(prompt.includes(chatSource.url));
  assert.match(prompt, /intentSummary/);
  assert.match(prompt, /provenance summary may differ from the final diff/);
  assert.match(prompt, /Conversation context for the optional intent summary only/);
  assert.match(prompt, /Local Sweetiebot pony profile/);
  assert(prompt.includes('berry-punch'));
  assert.match(prompt, /Place every GitHub pull-request, issue, and commit cross-reference in a Markdown bullet-list item/);
  assert.match(prompt, /Keep each reference as a complete raw HTTPS URL/);
  const browserPrompt = pullRequestPrompt({
    branch: 'draft', repositoryPath: '/repo', repositoryUrl: 'https://github.com/owner/repo',
    base: 'main', instructions: rules,
    browserDraft: { evidence: { files: [] }, callback: 'http://127.0.0.1:1234/kefania-draft/test' },
  });
  assert.match(browserPrompt, /Place every GitHub pull-request, issue, and commit cross-reference in a Markdown bullet-list item/);
  assert.match(browserPrompt, /Keep each reference as a complete raw HTTPS URL/);
  assert(browserPrompt.indexOf(rules) < browserPrompt.indexOf('Place every GitHub pull-request'),
    'Cross-reference placement overrides older canonical layout instructions');
  assert(!browserPrompt.includes('Weave each GitHub reference into the same sentence'),
    'The browser instructions should not retain the older paragraph-placement wording');
  assert.match(prompt, /local chat context only/);
  assert(!prompt.includes('2d5481b8-54dc-48c6-87e5-b67927d630bd'));

  for (const repositoryUrl of [undefined, null, '', '   ', 'invalid', 'https://gitlab.com/owner/repo']) {
    const fallback = pullRequestPrompt({
      branch: 'draft',
      repositoryPath: '/repo with spaces',
      repositoryUrl,
      base: 'main',
      instructions: rules
    });
    assert(fallback.includes('in repository "/repo with spaces", against'));
    assert.match(fallback, /Do not invent a source UUID/);
  }

  let callback;
  let eligibilityCallback;
  let setupCallback;
  let uriHandler;
  let browserAvailable = true;
  let codexSnapshot;
  const calls = [];
  let launchInSeparateWorkspace = false;
  const sessionLaunches = [];
  const shownPonies = [];
  const uri = { scheme: 'file', fsPath: '/workspace/project' };
  const repository = {
    rootUri: uri,
    state: { HEAD: { name: 'draft' }, remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }] },
    async status() {}
  };
  const gitExtension = { async activate() {
    return { getAPI: () => ({ getRepository(root) { assert.equal(root, uri); return repository; } }) };
  } };
  const codexExtension = { isActive: true, async activate() {} };
  let configuredProject = '';
  let ludicrousMode = false;
  let commitWait;
  let contextReads = 0;
  let contextFailure;
  let aheadBy = 1;
  const ponyLookups = [];
  let cachedProfile;
  const referencePages = [
    { url: 'https://x.com/cheekibat/status/2111134531751493961', label: 'Character source' },
    { url: 'https://x.com/cheekibat/status/2111066237820133658', label: 'Artwork and context' },
  ];
  const cacheOperations = [];
  let publicationFailure;
  let existingPullRequest;
  let repeatedStartingBase = false;
  const informationMessages = [];
  const vscode = {
    workspace: { getConfiguration(section) {
      assert.equal(section, 'scmToolkit');
      return { get(key, fallback) { if (key === 'kefaniaUseThemeColors' || key === 'kefaniaShowCloseButton' || key === 'kefaniaCloseButtonLeft' || key === 'kefaniaCloseButtonPosition') return fallback; if (key === 'autoPublishPullRequests') return true; assert.equal(key, 'chatgptProjectUrl'); return configuredProject || fallback; } };
    } },
    Uri: {
      from: components => components,
      parse: value => ({ value })
    },
    window: {
      registerUriHandler(handler) { uriHandler = handler; return { dispose() {} }; },
      async withProgress(_options, task) { return task(); },
      async showInformationMessage(message) { informationMessages.push(message); },
      async showWarningMessage() {},
      showErrorMessage() { return new Promise(() => {}); },
    },
    ProgressLocation: { Notification: 1 },
    extensions: {
      getExtension(id) {
        if (id === 'vscode.git') return gitExtension;
        if (id === 'openai.chatgpt') return codexSnapshot ? codexExtension : undefined;
        return undefined;
      }
    },
    commands: {
      registerCommand(id, handler) {
        if (id === 'sweetiebot.openPullRequestChat') callback = handler;
        else if (id === 'sweetiebot.pullRequestEligibility') eligibilityCallback = handler;
        else if (id === 'sweetiebot.explainPullRequestSetup') setupCallback = handler;
        else assert.fail('Unexpected command: ' + id);
        return { dispose() {} };
      },
      async getCommands() {
        return browserAvailable
          ? ['workbench.action.browser.open', 'workbench.action.moveEditorToNewWindow', ...(codexSnapshot ? ['sweetiebot.readCodexConversation'] : [])]
          : [];
      },
      async executeCommand(id, ...args) {
        if (id === 'sweetiebot.readCodexConversation') return codexSnapshot;
        calls.push({ id, args });
      }
    }
  };
  registerPullRequestCommand(vscode, { subscriptions: [] }, {
    pendingPRCommits: async () => commitWait,
    readLudicrousMode: async () => ludicrousMode,
    async launchPRSession(_vscode, _context, root, options) {
      if (!launchInSeparateWorkspace) return false;
      sessionLaunches.push({ root, options });
      return true;
    },
    async runKefania(repositoryPath, input, options) {
      assert.equal(repositoryPath, uri.fsPath);
      assert.equal(options.botOnly, true);
      if (input.contextOnly) {
        contextReads++;
        if (contextFailure) throw contextFailure;
        return { aheadBy, headSha: 'a'.repeat(40), files: [],
          newPullRequest: existingPullRequest
            ? { allowed: false, reason: 'open-pr', pullRequest: existingPullRequest }
            : repeatedStartingBase
              ? { allowed: false, reason: 'same-starting-base',
                pullRequest: { number: 41, url: 'https://github.com/owner/repo/pull/41' } }
              : { allowed: aheadBy > 0, reason: aheadBy > 0 ? 'new-starting-base' : 'no-commits' },
          ...(existingPullRequest ? { existingPullRequest } : {}) };
      }
      if (publicationFailure) throw publicationFailure;
      assert.equal(input.head, 'draft', 'Publish the branch captured before checkout changed');
      assert.equal(input.expectedHeadSha, 'a'.repeat(40));
      assert.deepEqual(input.preparedDraft, { title: '🔧 Improve setup', body: 'Keep the verified source reference.' });
      return { url: 'https://github.com/owner/repo/pull/1' };
    },
    readInstructions: async repositoryPath => {
      assert.equal(repositoryPath, uri.fsPath);
      return rules;
    },
    readPony: async branch => {
      ponyLookups.push(branch);
      return branch === 'draft'
        ? { slug: 'draft', packId: 'test-pack', packLabel: 'Test ponies', packDescription: 'Test only.' }
        : undefined;
    },
    showPony: async input => { shownPonies.push(input); },
    cachePony: async input => {
      cacheOperations.push(input);
      if (input.action === 'get') return cachedProfile
        ? { hit: true, profile: cachedProfile, sources: referencePages }
        : { hit: false, sources: referencePages };
      if (input.action === 'put') { cachedProfile = input.profile; return { stored: true }; }
      return { hit: false };
    }
  });

  launchInSeparateWorkspace = true;
  const sessionResult = await callback({ rootUri: uri }, {
    branch: 'draft', remote: 'origin', base: 'main', source: chatSource,
  });
  assert.equal(sessionResult.launched, true);
  assert.equal(sessionLaunches[0].root, uri);
  assert.equal(sessionLaunches[0].options.branch, 'draft');
  assert.deepEqual(sessionLaunches[0].options.source, chatSource);
  assert.equal(calls.length, 0, 'Source host must not own any PR browser or confirmation window');
  launchInSeparateWorkspace = false;

  await callback({ rootUri: uri }, {
    branch: 'draft',
    remote: 'origin',
    base: 'main',
    mcpServer: 'codex-drafter',
    mcpTool: 'github_create_pull_request',
    source: chatSource
  });
  assert.equal(shownPonies.length, 0, 'Pony information appears only in the confirmation window');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].id, 'workbench.action.browser.open');
  assert.equal(calls[2].id, 'workbench.action.browser.open');
  const browserOptions = calls[1].args[0];
  const url = new URL(browserOptions.url);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.search, '', 'PR prompt must not enter the HTTP request target');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('sweetiebot_pr'), '1');
  const openedPrompt = new URLSearchParams(url.hash.slice(1)).get('q');
  assert.match(openedPrompt, /"draft"/);
  assert(openedPrompt.includes(rules));
  assert(openedPrompt.includes(chatSource.uuid));
  assert(!openedPrompt.includes('test-pack'), 'PR drafting must not receive pony metadata');
  const profileUrl = new URL(calls[2].args[0].url);
  const profilePrompt = new URLSearchParams(profileUrl.hash.slice(1)).get('q');
  assert(profilePrompt.includes('test-pack'));
  assert(profilePrompt.includes(referencePages[0].url));
  assert(profilePrompt.includes(referencePages[1].url), 'Source-only cache misses retain both context pages');
  assert(!profilePrompt.includes('headSha'), 'Pony research must not receive repository evidence');
  assert.match(profilePrompt, /independently/);
  assert.equal(new URLSearchParams(profileUrl.hash.slice(1)).get('return_to').endsWith('/pony'), true);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('return_to').endsWith('/draft'), true);
  assert.match(calls[0].args[0].url, /^http:\/\/127\.0\.0\.1:/);
  assert.match(openedPrompt, /Do not publish through any GitHub connector/);
  assert.match(openedPrompt, /primary sources/);
  assert.match(openedPrompt, /codex-pony\[bot\]/);
  assert.equal(calls[2].args[0].openToSide, true, 'Pony research opens beside the PR draft');
  const firstConfirmation = calls[0].args[0].url;
  const savedProfile = 'Berry Punch — sourced profile with https://example.org/pony';
  await fetch(firstConfirmation + '/pony', { method: 'POST',
    headers: { Origin: new URL(firstConfirmation).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: savedProfile }) });
  for (let i = 0; i < 20 && cachedProfile !== savedProfile; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(cachedProfile, savedProfile, 'A completed pony lookup is cached separately from its PR');
  assert(cacheOperations.some(item => item.action === 'put' && item.pony.packId === 'test-pack'
    && item.pony.references?.length === 2), 'Collected profile retains its indexed references');
  calls.length = 0;
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.deepEqual(calls.map(call => call.id), [
    'workbench.action.browser.open', 'workbench.action.browser.open'
  ], 'Cache hits omit the independent pony research ChatGPT tab');
  const cachedConfirmation = calls[0].args[0].url;
  const cachedState = await (await fetch(cachedConfirmation + '/state')).json();
  assert.equal(cachedState.profile, savedProfile, 'Cached results immediately appear in the new confirmation');
  assert.equal(cachedState.ludicrousMode, false);
  ludicrousMode = true;
  assert.equal((await (await fetch(cachedConfirmation + '/state')).json()).ludicrousMode, true, 'The Kefania dialog reads the current magic-wand preference');
  ludicrousMode = false;
  assert.equal(cachedState.draft, undefined, 'PR drafting remains independent');
  cachedProfile = undefined;
  const draftPath = openedPrompt.match(/http:\/\/127\.0\.0\.1:\d+(\/kefania-draft\/[0-9a-f-]{36})/)[1];
  assert.equal(browserOptions.openToSide, false);
  calls.length = 0;
  repository.state.HEAD.name = 'main';
  const messagesBeforePublication = informationMessages.length;
  await uriHandler.handleUri({ path: draftPath, query: new URLSearchParams({ title: '🔧 Improve setup', body: 'Keep the verified source reference.' }).toString() });
  repository.state.HEAD.name = 'draft';
  assert.equal(calls.length, 0, 'Publication stays on the confirmation page');
  assert.equal(informationMessages.length, messagesBeforePublication, 'Publication does not interrupt the independent confirmation window with a success toast');
  calls.length = 0;
  await uriHandler.handleUri({ path: draftPath, query: 'title=Replay&body=Replay' });
  assert.equal(calls.length, 0, 'A consumed draft must never publish twice');

  assert.equal((await eligibilityCallback(uri, {
    branch: 'draft', base: 'main', remote: 'origin',
  })).allowed, true, 'The button permits a new starting base');

  let warning, warningChoice;
  const openedSetup = [];
  vscode.window.showWarningMessage = async (...args) => { warning = args; return warningChoice; };
  vscode.env = { async openExternal(url) { openedSetup.push(url.value); } };
  warningChoice = 'Manage app access';
  assert.equal(await setupCallback('Install codex-pony on this repository before creating a bot PR.'), false);
  assert.match(warning[0], /include this repository/);
  assert.deepEqual(openedSetup, ['https://github.com/settings/apps/codex-pony/installations']);
  warningChoice = 'Retry';
  assert.equal(await setupCallback('GitHub request failed (HTTP 503).'), true);
  assert.deepEqual(warning.slice(1), ['Retry'], 'Other failures must not claim the app needs installation');

  // Repeated clicks must reuse an open PR for the head even if its base differs.
  existingPullRequest = { number: 42, url: 'https://github.com/owner/repo/pull/42', head: 'draft', base: 'release' };
  calls.length = 0;
  const existingResult = await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.equal(existingResult.existing, true);
  assert.equal(existingResult.base, 'release');
  assert.deepEqual(calls.map(call => call.id), ['vscode.open']);
  assert.equal(calls[0].args[0].value, existingPullRequest.url);
  assert.match(informationMessages.at(-1), /already exists/);
  browserAvailable = false;
  calls.length = 0;
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.deepEqual(calls.map(call => call.id), ['vscode.open'],
    'Existing PR must open even without the Integrated Browser');
  browserAvailable = true;
  existingPullRequest = undefined;
  repeatedStartingBase = true;
  calls.length = 0;
  assert.equal((await eligibilityCallback(uri, {
    branch: 'draft', base: 'main', remote: 'origin',
  })).reason, 'same-starting-base');
  const skippedRepeatedBase = await callback(uri, {
    branch: 'draft', remote: 'origin', base: 'main', source: chatSource,
  });
  assert.equal(skippedRepeatedBase.reason, 'same-starting-base');
  assert.equal(calls.length, 0, 'A previously used starting base must not open ChatGPT');
  assert.match(informationMessages.at(-1), /already used the starting base/);
  repeatedStartingBase = false;

  // An unmodified published branch must not launch a PR draft, pony research,
  // or even the confirmation window. Existing PR reuse is tested above.
  aheadBy = 0;
  calls.length = 0;
  const lookupCount = ponyLookups.length;
  const noCommits = await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.deepEqual(noCommits, { skipped: true, reason: 'no-commits', repositoryUrl: 'https://github.com/owner/repo' });
  assert.equal(calls.length, 0, 'No browser or workflow may open when there are zero published commits');
  assert.equal(ponyLookups.length, lookupCount, 'Do not even look up pony metadata for an empty branch');
  assert.match(informationMessages.at(-1), /No published commits.*Commit and push changes/);
  aheadBy = 1;

  configuredProject = 'https://chatgpt.com/g/g-p-test123/project';
  calls.length = 0;
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.equal(new URL(calls[1].args[0].url).pathname, '/g/g-p-test123/project');
  assert.equal(new URLSearchParams(new URL(calls[1].args[0].url).hash.slice(1)).get('sweetiebot_pr'), '1');
  assert.match(new URLSearchParams(new URL(calls[1].args[0].url).hash.slice(1)).get('q'), /"draft"/);
  configuredProject = '';

  const failedPublicationUrl = calls[0].args[0].url;
  publicationFailure = new Error('Remote head changed');
  await fetch(failedPublicationUrl + '/draft', { method: 'POST', headers: { Origin: new URL(failedPublicationUrl).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '🔧 Improve setup', body: 'Keep the verified source reference.' }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const publicationState = await (await fetch(failedPublicationUrl + '/state')).json();
  assert.equal(publicationState.publishing, false, 'Unanswered error notifications cannot block completion');
  assert.equal(publicationState.errors.publish, publicationFailure.message);
  publicationFailure = undefined;

  contextFailure = new Error('Published comparison unavailable');
  calls.length = 0;
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.equal(calls.length, 2, 'Pony research and confirmation still open when PR preparation fails');
  const independentPrompt = new URLSearchParams(new URL(calls[1].args[0].url).hash.slice(1)).get('q');
  assert(independentPrompt.includes('test-pack'));
  const failedState = await (await fetch(calls[0].args[0].url + '/state')).json();
  assert.equal(failedState.errors.draft, contextFailure.message);
  contextFailure = undefined;

  calls.length = 0;
  codexSnapshot = {
    text: 'The Codex conversation asked for provenance separate from the implementation.',
    source: {
      kind: 'codex',
      uuid: '019c56c3-06fc-7db3-a928-9c3607e17129',
      url: codexUrl
    }
  };
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main' });
  const codexLaunchUrl = new URL(calls.find(call => call.id === 'workbench.action.browser.open' && call.args[0].url.startsWith('https://chatgpt.com')).args[0].url);
  assert.equal(new URLSearchParams(codexLaunchUrl.hash.slice(1)).get('sweetiebot_pr'), '1');
  const codexPrompt = new URLSearchParams(codexLaunchUrl.hash.slice(1)).get('q');
  assert(codexPrompt.includes(codexSnapshot.source.uuid));
  assert(codexPrompt.includes(codexSnapshot.text));

  calls.length = 0;
  await uriHandler.handleUri({ path: '/codex/019c56c3-06fc-7db3-a928-9c3607e17129' });
  assert.equal(calls[0].id, 'vscode.openWith');
  assert.equal(calls[0].args[0].value, 'openai-codex:/local/019c56c3-06fc-7db3-a928-9c3607e17129');
  assert.equal(calls[0].args[1], 'chatgpt.conversationEditor');

  browserAvailable = false;
  await assert.rejects(callback(uri, { branch: 'draft', remote: 'origin', base: 'main' }), /Update VS Code/);
  browserAvailable = true;
  // Checkout changes during the asynchronous startup must not cancel or
  // redirect a PR launched for the picker-selected branch.
  const originalStatus = repository.status;
  repository.state.HEAD.name = 'draft';
  repository.status = async () => { repository.state.HEAD.name = 'other'; };
  calls.length = 0;
  await callback(uri, { branch: 'draft', base: 'main', remote: 'origin' });
  const switchedConfirmation = calls.find(call => call.id === 'workbench.action.browser.open'
    && call.args[0].url.startsWith('http://127.0.0.1:')).args[0].url;
  const draftResponse = await fetch(switchedConfirmation + '/draft', {
    method: 'POST',
    headers: { Origin: new URL(switchedConfirmation).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '🔧 Improve setup', body: 'Keep the verified source reference.' })
  });
  assert.equal(draftResponse.status, 200);
  let switchedState;
  for (let attempt = 0; attempt < 20; attempt++) {
    switchedState = await (await fetch(switchedConfirmation + '/state')).json();
    if (switchedState.result) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(switchedState.result?.url, 'https://github.com/owner/repo/pull/1',
    'A background PR publishes the captured branch after checkout switches');
  assert.equal(repository.state.HEAD.name, 'other', 'Publication does not switch the worktree back');
  repository.status = originalStatus;
  await assert.rejects(callback(uri, { branch: 'main', base: 'main' }), /other than/);
  repository.state.HEAD.name = 'draft';

  calls.length = 0;
  cachedProfile = undefined;
  const beforeWaitReads = contextReads;
  let releaseCommits;
  commitWait = () => new Promise(resolve => { releaseCommits = resolve; });
  const waitingPR = callback(uri, { branch: 'draft', base: 'main', remote: 'origin', source: chatSource });
  for (let attempt = 0; attempt < 100 && !releaseCommits; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof releaseCommits, 'function');
  assert.equal(contextReads, beforeWaitReads, 'Do not capture provisional commit evidence');
  assert.equal(calls.length, 2, 'Confirmation and independent pony research open before commit naming finishes');
  const waitingPrompt = new URLSearchParams(new URL(calls[1].args[0].url).hash.slice(1)).get('q');
  assert(waitingPrompt.includes('test-pack'));
  releaseCommits();
  await waitingPR;
  assert.equal(contextReads, beforeWaitReads + 1, 'Read fresh published evidence after commit naming and push');
  assert.equal(calls.length, 3, 'Launch PR drafting once the commit is ready');
  const readyPrompt = new URLSearchParams(new URL(calls[2].args[0].url).hash.slice(1)).get('q');
  assert(readyPrompt.includes('headSha'));
  calls.length = 0;
  commitWait = async () => { throw new Error('Commit naming paused'); };
  const failedWaitReads = contextReads;
  await callback(uri, { branch: 'draft', base: 'main', remote: 'origin', source: chatSource });
  assert.equal(contextReads, failedWaitReads, 'A failed commit never starts drafting from provisional evidence');
  assert.equal(calls.length, 2, 'Keep confirmation and independent pony research on a paused commit');
  const pausedState = await (await fetch(calls[0].args[0].url + '/state')).json();
  assert.equal(pausedState.errors.draft, 'Commit naming paused');
  commitWait = undefined;

  const packageJson = require('../efs/package.json');
  assert(packageJson.activationEvents.includes('onCommand:sweetiebot.openPullRequestChat'));
  assert(packageJson.activationEvents.includes('onUri'));

  const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
  const preflightSource = source.match(/async function scmToolkitCheckPullRequestMcp\([\s\S]*?\n\}/)[0];
  let statusResult = { content: [{ type: 'text', text: '{"ready":true}' }] };
  let missingTool;
  const preflightCalls = [];
  const preflightContext = vm.createContext({
    async scmToolkitKafaniaTool(_doc, _service, server, name) {
      assert.equal(server, 'codex-drafter');
      preflightCalls.push(name);
      return name === missingTool ? undefined : { async call() { return statusResult; } };
    },
    scmToolkitMcpError: result => result.content[0].text,
  });
  vm.runInContext(`${preflightSource}\nthis.check = scmToolkitCheckPullRequestMcp;`, preflightContext);
  const preflightSettings = { mcpPrServer: 'codex-drafter', mcpPrTool: 'github_create_pull_request' };
  await preflightContext.check({}, {}, preflightSettings);
  assert.deepEqual(preflightCalls, ['kefania_status', 'github_get_pull_request_context', 'github_create_pull_request']);
  missingTool = 'kefania_status';
  await assert.rejects(preflightContext.check({}, {}, preflightSettings), /MCP: List Servers/);
  missingTool = 'github_create_pull_request';
  await assert.rejects(preflightContext.check({}, {}, preflightSettings), /missing the MCP tool/);
  missingTool = undefined;
  statusResult = { isError: true, content: [{ type: 'text', text: 'Login required' }] };
  await assert.rejects(preflightContext.check({}, {}, preflightSettings), /cannot access GitHub/);
  statusResult = { content: [{ type: 'text', text: 'not-json' }] };
  await assert.rejects(preflightContext.check({}, {}, preflightSettings), /invalid connection status/);
  const callbackSource = source.match(/    const createPullRequest = ([\s\S]*?)\n    };/)[1];
  const chatSourceFunction = source.match(/function scmToolkitChatgptConversationSource\(doc\) \{[\s\S]*?\n\}/)[0];
  const coordinatesFunction = source.match(/function scmToolkitGithubCoordinates\(repositoryUrl\) \{[\s\S]*?\n\}/)[0];
  const helperContext = vm.createContext({});
  vm.runInContext(`${chatSourceFunction}\n${coordinatesFunction}\nthis.chatSource = scmToolkitChatgptConversationSource; this.coordinates = scmToolkitGithubCoordinates;`, helperContext);
  const browserUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const browserSource = helperContext.chatSource({
    querySelectorAll() {
      return [
        { value: 'https://example.com', getClientRects: () => [1] },
        { value: `https://chatgpt.com/c/${browserUuid}`, getClientRects: () => [1] }
      ];
    }
  });
  assert.equal(browserSource.uuid, browserUuid);
  assert.equal(browserSource.url, `https://chatgpt.com/c/${browserUuid}`);
  assert.equal(helperContext.coordinates('https://github.com/owner/repo').owner, 'owner');
  assert.equal(helperContext.coordinates('https://github.com/owner/repo').repo, 'repo');
  assert.equal(helperContext.coordinates('https://gitlab.com/owner/repo'), undefined);

  const pickerSource = {
    kind: 'chatgpt',
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  };
  const recorded = [];
  const sandbox = vm.createContext({
    doc: {},
    currentBranch: 'draft',
    currentRepositoryUri: uri,
    currentDefaultBranch: 'develop',
    settings: {
      mcpPullRequest: true,
      defaultBranch: 'main',
      remote: 'origin',
      mcpPrServer: 'codex-drafter',
      mcpPrTool: 'github_create_pull_request'
    },
    pending: false,
    deletingBranch: false,
    creatingPullRequest: false,
    creatingPonyBranch: false,
    pullRequestEligibility: { allowed: true, reason: 'new-starting-base' },
    scmToolkitChatgptConversationSource() { return pickerSource; },
    recorded,
    async scmToolkitRecordPullRequestSource(_doc, _mcpService, _settings, launch, branch, base, source) {
      recorded.push({ launch, branch, base, source });
    },
    mcpService: {},
    async scmToolkitCheckPullRequestMcp() {},
    refreshBranchControls() {},
    notifications: { error(error) { throw error; } },
    commands: { async executeCommand(id, root, options) {
      assert.equal(id, 'sweetiebot.openPullRequestChat');
      assert.equal(root, uri);
      assert.equal(options.branch, 'draft');
      assert.equal(options.base, 'develop');
      assert.equal(options.mcpServer, 'codex-drafter');
      assert.equal(options.mcpTool, 'github_create_pull_request');
      assert.deepEqual(options.source, pickerSource);
      return { source: pickerSource, repositoryUrl: 'https://github.com/owner/repo' };
    } }
  });
  const click = vm.runInContext(`(${callbackSource}\n    })`, sandbox);
  await click({ stopPropagation() {} });
  await Promise.resolve();
  assert.equal(sandbox.creatingPullRequest, false);
  assert.equal(sandbox.recorded.length, 0);
  sandbox.pullRequestEligibility = { allowed: false, reason: 'same-starting-base' };
  const beforeDisabledClick = sandbox.recorded.length;
  await click({ stopPropagation() {} });
  assert.equal(sandbox.recorded.length, beforeDisabledClick, 'Disabled New PR must not invoke the drafter');
  const launchCommand = sandbox.commands.executeCommand;
  let accessWarnings = 0, refreshedAccess = 0;
  sandbox.pullRequestEligibility = { allowed: false, reason: 'unavailable', message: 'Install codex-pony on this repository before creating a bot PR.' };
  sandbox.pullRequestEligibilityKey = 'cached-failure';
  sandbox.refreshPullRequest = () => { refreshedAccess += 1; };
  sandbox.commands.executeCommand = async (id, message) => {
    assert.equal(id, 'sweetiebot.explainPullRequestSetup', 'Missing access must explain setup without launching or publishing');
    assert.match(message, /Install codex-pony/);
    accessWarnings += 1;
    return true;
  };
  await click({ stopPropagation() {} });
  assert.equal(accessWarnings, 1);
  assert.equal(refreshedAccess, 1);
  assert.equal(sandbox.pullRequestEligibilityKey, undefined, 'Retry clears the cached failure');
  assert.equal(sandbox.creatingPullRequest, false);
  sandbox.commands.executeCommand = launchCommand;
  sandbox.pullRequestEligibility = { allowed: true, reason: 'new-starting-base' };
  sandbox.scmToolkitCheckPullRequestMcp = async () => { throw new Error('Kefania unavailable'); };
  let fallbackLaunches = 0;
  sandbox.commands.executeCommand = async (id) => {
    if (id === 'sweetiebot.openPullRequestChat') throw Object.assign(new Error('Browser unavailable'), { name: 'SweetiebotBrowserUnavailable' });
    assert.equal(id, 'sweetiebot.createLocalPullRequest');
    fallbackLaunches += 1;
    return { repositoryUrl: 'https://github.com/owner/repo' };
  };
  await click({ stopPropagation() {} });
  await Promise.resolve();
  assert.equal(fallbackLaunches, 1);
  assert.equal(sandbox.creatingPullRequest, false);
  assert.equal(sandbox.recorded.length, 0);
  sandbox.commands.executeCommand = async () => { throw new Error('A chat may already be running'); };
  await assert.rejects(click({ stopPropagation() {} }), /already be running/);
  assert.equal(fallbackLaunches, 1, 'An uncertain browser launch must never start a second drafter');

  console.log('Kafania pull-request bridge checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
