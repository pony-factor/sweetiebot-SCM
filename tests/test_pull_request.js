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
  registerPullRequestCommand,
} = require('../efs/pull_request');

async function run() {
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
  assert.match(prompt, /Kafania's configured MCP server "codex-drafter"/);
  assert.match(prompt, /"github_create_pull_request"/);
  assert(prompt.includes(chatSource.uuid));
  assert(prompt.includes(chatSource.url));
  assert.match(prompt, /intentSummary/);
  assert.match(prompt, /provenance summary may differ from the final diff/);
  assert.match(prompt, /Conversation context for the optional intent summary only/);
  assert.match(prompt, /Local Sweetiebot pony profile/);
  assert(prompt.includes('berry-punch'));
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
  let uriHandler;
  let browserAvailable = true;
  let codexSnapshot;
  const calls = [];
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
  const vscode = {
    workspace: { getConfiguration(section) {
      assert.equal(section, 'scmToolkit');
      return { get(key, fallback) { assert.equal(key, 'chatgptProjectUrl'); return configuredProject || fallback; } };
    } },
    Uri: {
      from: components => components,
      parse: value => ({ value })
    },
    window: {
      registerUriHandler(handler) { uriHandler = handler; return { dispose() {} }; }
    },
    extensions: {
      getExtension(id) {
        if (id === 'vscode.git') return gitExtension;
        if (id === 'openai.chatgpt') return codexSnapshot ? codexExtension : undefined;
        return undefined;
      }
    },
    commands: {
      registerCommand(id, handler) {
        assert.equal(id, 'sweetiebot.openPullRequestChat');
        callback = handler;
        return { dispose() {} };
      },
      async getCommands() {
        return browserAvailable
          ? ['workbench.action.browser.open', ...(codexSnapshot ? ['sweetiebot.readCodexConversation'] : [])]
          : [];
      },
      async executeCommand(id, ...args) {
        if (id === 'sweetiebot.readCodexConversation') return codexSnapshot;
        calls.push({ id, args });
      }
    }
  };
  registerPullRequestCommand(vscode, { subscriptions: [] }, {
    readInstructions: async repositoryPath => {
      assert.equal(repositoryPath, uri.fsPath);
      return rules;
    },
    readPony: async branch => branch === 'draft'
      ? { slug: 'draft', packId: 'test-pack', packLabel: 'Test ponies', packDescription: 'Test only.' }
      : undefined,
    showPony: async pony => { shownPonies.push(pony); }
  });

  await callback({ rootUri: uri }, {
    branch: 'draft',
    remote: 'origin',
    base: 'main',
    mcpServer: 'codex-drafter',
    mcpTool: 'github_create_pull_request',
    source: chatSource
  });
  assert.equal(shownPonies.length, 1);
  assert.equal(shownPonies[0].packId, 'test-pack');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'workbench.action.browser.open');
  const browserOptions = calls[0].args[0];
  const url = new URL(browserOptions.url);
  assert.equal(url.origin, 'https://chatgpt.com');
  const openedPrompt = url.searchParams.get('q');
  assert.match(openedPrompt, /"draft"/);
  assert(openedPrompt.includes(rules));
  assert(openedPrompt.includes(chatSource.uuid));
  assert(openedPrompt.includes('test-pack'));
  assert.match(openedPrompt, /local chat context only/);
  assert.equal(browserOptions.openToSide, false);

  configuredProject = 'https://chatgpt.com/g/g-p-test123/project';
  calls.length = 0;
  await callback(uri, { branch: 'draft', remote: 'origin', base: 'main', source: chatSource });
  assert.equal(new URL(calls[0].args[0].url).pathname, '/g/g-p-test123/project');
  assert.match(new URL(calls[0].args[0].url).searchParams.get('q'), /"draft"/);
  configuredProject = '';

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
  const codexPrompt = new URL(calls.at(-1).args[0].url).searchParams.get('q');
  assert(codexPrompt.includes(codexSnapshot.source.uuid));
  assert(codexPrompt.includes(codexSnapshot.text));

  calls.length = 0;
  await uriHandler.handleUri({ path: '/codex/019c56c3-06fc-7db3-a928-9c3607e17129' });
  assert.equal(calls[0].id, 'vscode.openWith');
  assert.equal(calls[0].args[0].value, 'openai-codex:/local/019c56c3-06fc-7db3-a928-9c3607e17129');
  assert.equal(calls[0].args[1], 'chatgpt.conversationEditor');

  browserAvailable = false;
  await assert.rejects(callback(uri, { branch: 'draft', base: 'main' }), /Update VS Code/);
  browserAvailable = true;
  repository.state.HEAD.name = 'other';
  await assert.rejects(callback(uri, { branch: 'draft', base: 'main' }), /active branch changed/);
  repository.state.HEAD.name = 'main';
  await assert.rejects(callback(uri, { branch: 'main', base: 'main' }), /other than/);
  repository.state.HEAD.name = 'draft';

  const packageJson = require('../efs/package.json');
  assert(packageJson.activationEvents.includes('onCommand:sweetiebot.openPullRequestChat'));
  assert(packageJson.activationEvents.includes('onUri'));

  const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
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
    scmToolkitChatgptConversationSource() { return pickerSource; },
    recorded,
    async scmToolkitRecordPullRequestSource(_doc, _mcpService, _settings, launch, branch, base, source) {
      recorded.push({ launch, branch, base, source });
    },
    mcpService: {},
    refreshBranchControls() {},
    notifications: { error(error) { throw error; } },
    commands: { async executeCommand(id, root, options) {
      assert.equal(id, 'sweetiebot.openPullRequestChat');
      assert.equal(root, uri);
      assert.equal(options.branch, 'draft');
      assert.equal(options.base, 'main');
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
  assert.equal(sandbox.recorded.length, 1);
  assert.equal(sandbox.recorded[0].branch, 'draft');
  assert.equal(sandbox.recorded[0].base, 'main');
  assert.deepEqual(sandbox.recorded[0].source, pickerSource);
  assert.equal(sandbox.recorded[0].launch.repositoryUrl, 'https://github.com/owner/repo');

  console.log('Kafania pull-request bridge checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
