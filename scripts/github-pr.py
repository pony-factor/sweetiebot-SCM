"""Guarded, reversible fixes for the installed GitHub Pull Requests extension."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import json
import re
from pathlib import Path
import github_pr_reactions

START = '\n/* sweetiebot-github-pr:start */\n'
END = '\n/* sweetiebot-github-pr:end */\n'
REFRESH_START = '\n/* sweetiebot-github-pr-refresh:start */\n'
REFRESH_END = '\n/* sweetiebot-github-pr-refresh:end */\n'
CHECKOUT_START = '\n/* sweetiebot-github-pr-checkout:start */\n'
CHECKOUT_END = '\n/* sweetiebot-github-pr-checkout:end */\n'
DESCRIPTION_START = '\n/* sweetiebot-github-pr-description:start */\n'
DESCRIPTION_END = '\n/* sweetiebot-github-pr-description:end */\n'
DESCRIPTION = re.compile(r'async updateItemNow\(([\w$]+)\)\{var ([\w$]+),([\w$]+),([\w$]+);this\._item=\1,')
TREE = re.compile(r'([\w$]+)\.window\.createTreeView\("pr:github",\{treeDataProvider:this,showCollapseAll:!0,(?:canSelectMany:(?:[\w$]+\(\)|![01]),)?manageCheckboxStateManually:!0\}\)')
REFRESH_COMMAND = re.compile(r'([\w$]+)=>\{this\.prsTreeModel\.forceClearCache\(\)(?:,this\.refreshAllQueryResults\(!0\))?\}')
FETCH_NOTICE = re.compile(
    r'[\w$]+\.l10n\.t\("Fetching pull requests failed: \{0\}",([\w$]+\([\w$]+\))\)'
)
CLEANUP = re.compile(
    r'else if\(\(await [\w$]+\.githubRepository\.getMetadata\(\)\)\.delete_branch_on_merge\)'
    r'\{const ([\w$]+)=await [\w$]+\([\w$]+,[\w$]+\);return \1\.isReply\?void 0:\1\.message\}'
)
NUMBER_LINK = re.compile(
    r'href:([\w$]+),title:\1,"data-vscode-context":JSON\.stringify\([\w$]+\),'
    r'onClick:[\w$]+\(([\w$]+)=>\{\2\.preventDefault\(\),([\w$]+)\(\)\},"onClick"\)'
)


def transform(source, kind, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete GitHub PR patch; refusing to overwrite it.')
    if START in source:
        before, remainder = source.split(START)
        metadata, after = remainder.split(END)
        original, replacement = json.loads(metadata.removeprefix("/* edit:").removesuffix(" */"))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('GitHub PR patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    pattern = CLEANUP if kind == 'host' else NUMBER_LINK
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError(f'Unsupported GitHub PR {kind} build: expected one matching anchor.')
    original = matches[0].group()
    if kind == 'host':
        # Leave explicitly configured native automatic deletion and manual deletion intact.
        replacement = original[:original.index('{')] + '{return void 0}'
    else:
        # React's existing handler remains the sole opener; workbench link interception sees no href.
        opener = matches[0].group(3)
        replacement = ('role:"link",tabIndex:0,onKeyDown:event=>{if(event.key==="Enter")'
                       '{event.preventDefault();' + opener + '()}},'
                       + original.replace('href:', '"data-sweetiebot-url":', 1))
    return source.replace(original, replacement, 1) + START + "/* edit:" + json.dumps([original, replacement]) + " */" + END


def bundled_refresh_helper():
    root = Path(__file__).resolve().parent.parent / 'extension'

    def bundle(path):
        source = path.read_text()

        def dependency(match):
            target = (path.parent / (match.group(1) + '.js')).resolve()
            if not target.is_relative_to(root.resolve()):
                raise ValueError('GitHub PR helper dependency escapes the extension.')
            return bundle(target)

        source = re.sub(r'require\([\"\'](\.[^\"\']+)[\"\']\)', dependency, source)
        return '(()=>{const module={exports:{}};\n' + source + '\nreturn module.exports;})()'

    # The helper executes inside GitHub's extension, so relative imports must
    # travel with it rather than resolve against GitHub's dist directory.
    return bundle(root / 'github/pr-refresh.js')


def transform_refresh(source, remove=False):
    if source.count(REFRESH_START) != source.count(REFRESH_END) or source.count(REFRESH_START) > 1:
        raise ValueError('Incomplete GitHub PR refresh patch; refusing to overwrite it.')
    if REFRESH_START in source:
        before, remainder = source.split(REFRESH_START)
        metadata, after = remainder.split(REFRESH_END)
        edits = json.loads(metadata.removeprefix('/* edits:').removesuffix(' */'))
        source = before + after
        for original, replacement in reversed(edits):
            if source.count(replacement) != 1:
                raise ValueError('GitHub PR refresh patch changed; refusing to overwrite it.')
            source = source.replace(replacement, original, 1)
    if remove:
        return source
    tree = list(TREE.finditer(source))
    commands = list(REFRESH_COMMAND.finditer(source))
    if len(tree) != 1 or len(commands) != 1:
        raise ValueError('Unsupported GitHub PR tree build: expected one matching anchor.')
    helper = bundled_refresh_helper()
    original = tree[0].group()
    factory = f'({helper}).installPullRequestRefresh'
    edits = [(original, f'({factory})({tree[0].group(1)},{original},this)'),
             (commands[0].group(), commands[0].group().replace('{this.', '{return this.', 1))]
    notices = list(FETCH_NOTICE.finditer(source))
    if len(notices) > 1:
        raise ValueError('Unsupported GitHub PR notification build: ambiguous fetch notice.')
    if notices:
        notice = notices[0]
        # Keep authentication and other errors intact; shorten only network timeouts.
        edits.append((notice.group(),
                      '((sweetiebotError)=>{globalThis.__sweetiebotGitHubPrRefreshError?.(sweetiebotError);'
                      'return /connect timeout|connection timeout|timed?\\s*out|UND_ERR_CONNECT_TIMEOUT/i.test(sweetiebotError)'
                      '?"⏳ GitHub took too long to respond. Try refreshing.":'
                      '/API rate limit exceeded|secondary rate limit|abuse detection|too many requests|HTTP 429/i.test(sweetiebotError)'
                      '?"GitHub API rate limit reached. Automatic refresh is paused; use Retry after reset in the GitHub notification.":'
                      + notice.group() + '})(' + notice.group(1) + ')'))
    for original, replacement in edits:
        source = source.replace(original, replacement, 1)
        # Keep nested dependency block comments from closing the reversible JSON metadata.
    return source + REFRESH_START + '/* edits:' + json.dumps(edits).replace('*/', '*\\/') + ' */' + REFRESH_END


def transform_description(source, remove=False):
    if source.count(DESCRIPTION_START) != source.count(DESCRIPTION_END) or source.count(DESCRIPTION_START) > 1:
        raise ValueError('Incomplete GitHub PR description patch; refusing to overwrite it.')
    if DESCRIPTION_START in source:
        before, remainder = source.split(DESCRIPTION_START)
        metadata, after = remainder.split(DESCRIPTION_END)
        original, replacement = json.loads(metadata.removeprefix('/* edit:').removesuffix(' */'))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('GitHub PR description patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    matches = list(DESCRIPTION.finditer(source))
    if len(matches) != 1:
        raise ValueError('Unsupported GitHub PR description build: expected one matching anchor.')
    original = matches[0].group()
    model = matches[0].group(1)
    # Tree models can contain raw body text without bodyHTML. Resolve that exact
    # PR before constructing the initial context, preserving GitHub's Markdown.
    hydration = (
        f'if({model}.body?.trim()&&!{model}.bodyHTML?.trim()){{'
        f'const sweetiebotResolved=await this._folderRepositoryManager.resolvePullRequest('
        f'{model}.remote.owner,{model}.remote.repositoryName,{model}.number);'
        'if(!sweetiebotResolved)throw new Error("Failed to load pull request description");'
        f'{model}=sweetiebotResolved;}}'
    )
    replacement = original.replace(f'this._item={model},', hydration + f'this._item={model},')
    return source.replace(original, replacement, 1) + DESCRIPTION_START + '/* edit:' + json.dumps([original, replacement]) + ' */' + DESCRIPTION_END


def transform_checkout(source, remove=False):
    if source.count(CHECKOUT_START) != source.count(CHECKOUT_END) or source.count(CHECKOUT_START) > 1:
        raise ValueError('Incomplete GitHub PR checkout patch; refusing to overwrite it.')
    if CHECKOUT_START in source:
        before, remainder = source.split(CHECKOUT_START)
        metadata, after = remainder.split(CHECKOUT_END)
        original, replacement = json.loads(metadata.removeprefix('/* edit:').removesuffix(' */'))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('GitHub PR checkout patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    # Hook after GitHub has matched the PR's head repository to a local remote.
    # Both the tree and the PR description use this shared checkout method.
    pattern = re.compile(r'const ([\w$]+)=([\w$]+)\.head\.ref,([\w$]+)=([\w$]+)\.remoteName;let ([\w$]+),([\w$]+)=\1;')
    matches = list(pattern.finditer(source))
    methods = list(re.finditer(r'async fetchAndCheckout\(([\w$]+),[\w$]+,[\w$]+,[\w$]+\)', source))
    vscode = re.search(r'([\w$]+)\.commands\.executeCommand\("pr\.pick"', source)
    if len(matches) != 1 or len(methods) != 1 or not vscode:
        raise ValueError('Unsupported GitHub PR checkout build: expected one matching anchor.')
    match = matches[0]
    if match.start() < methods[0].end():
        raise ValueError('Unsupported GitHub PR checkout build: invalid method order.')
    original = match.group()
    prefix, suffix = original.split(';', 1)
    replacement = (prefix + ';if(await ' + vscode[1] + '.commands.executeCommand('
                   '"sweetiebot.checkoutBranchStrip",' + methods[0][1] + '.rootUri,'
                   '{branch:' + match[1] + ',existingOnly:true}))return;' + suffix)
    return source.replace(original, replacement, 1) + CHECKOUT_START + '/* edit:' + json.dumps([original, replacement]) + ' */' + CHECKOUT_END


def patch_files(extension_path=None, remove=False):
    candidates = ([Path(extension_path)] if extension_path else
                  sorted((Path.home() / '.vscode/extensions').glob('github.vscode-pull-request-github-*')))
    edits = []
    for extension in candidates:
        for filename, kind in [('extension.js', 'host'), ('browser/extension.js', 'host'),
                               ('webview-pr-description.js', 'webview')]:
            path = extension / 'dist' / filename
            if not path.is_file():
                continue
            old = path.read_text()
            markers = (CHECKOUT_START, START, REFRESH_START, DESCRIPTION_START, github_pr_reactions.CSP_START, github_pr_reactions.WEBVIEW_START)
            if remove and not any(marker in old for marker in markers):
                continue
            # Existing guarded patches must always unpatch cleanly. An unrelated
            # optional anchor in a newer build must not suppress tree commands.
            stripped = (github_pr_reactions.transform_csp(old, remove=True) if kind == 'host'
                        else github_pr_reactions.transform_webview(old, remove=True))
            stripped = transform_checkout(transform_description(transform_refresh(stripped, remove=True), remove=True), remove=True) if kind == 'host' else stripped
            try:
                new = transform(stripped, kind, remove)
            except ValueError:
                if START in old:
                    raise
                print(f'Warning: unsupported GitHub PR {kind} cleanup in {path.name}; retaining independent tree and reaction repairs.')
                new = stripped
            if kind == 'host' and not remove:
                try:
                    new = transform_checkout(new)
                except ValueError:
                    if CHECKOUT_START in old:
                        raise
                    print(f'Warning: unsupported GitHub PR checkout in {path.name}; skipping workspace routing.')
                try:
                    new = transform_description(new)
                except ValueError:
                    if DESCRIPTION_START in old:
                        raise
                    print(f'Warning: unsupported GitHub PR description in {path.name}; skipping description hydration.')
                try:
                    new = transform_refresh(new)
                except ValueError:
                    if REFRESH_START in old:
                        raise
                    print(f'Warning: unsupported GitHub PR tree in {path.name}; skipping automatic refresh.')
            if not remove:
                try:
                    new = (github_pr_reactions.transform_csp(new) if kind == 'host'
                           else github_pr_reactions.transform_webview(new))
                except ValueError:
                    marker = (github_pr_reactions.CSP_START if kind == 'host'
                              else github_pr_reactions.WEBVIEW_START)
                    if marker in old:
                        raise
                    print(f'Warning: unsupported GitHub PR reaction asset {path.name}; skipping hover profiles.')
            edits.append((path, old, new))
    return edits
