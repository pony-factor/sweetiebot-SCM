"""Guarded, reversible fixes for the installed GitHub Pull Requests extension."""
import json
import re
from pathlib import Path
import github_pr_reactions

START = '\n/* sweetiebot-github-pr:start */\n'
END = '\n/* sweetiebot-github-pr:end */\n'
REFRESH_START = '\n/* sweetiebot-github-pr-refresh:start */\n'
REFRESH_END = '\n/* sweetiebot-github-pr-refresh:end */\n'
DESCRIPTION_START = '\n/* sweetiebot-github-pr-description:start */\n'
DESCRIPTION_END = '\n/* sweetiebot-github-pr-description:end */\n'
DESCRIPTION = re.compile(r'async updateItemNow\(([\w$]+)\)\{var ([\w$]+),([\w$]+),([\w$]+);this\._item=\1,')
TREE = re.compile(r'([\w$]+)\.window\.createTreeView\("pr:github",\{treeDataProvider:this,showCollapseAll:!0,(?:canSelectMany:[\w$]+\(\),)?manageCheckboxStateManually:!0\}\)')
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
    helper = (Path(__file__).resolve().parent.parent / 'efs/github_pr_refresh.js').read_text().split('\nmodule.exports')[0]
    original = tree[0].group()
    factory = f'(()=>{{{helper}\nreturn installPullRequestRefresh;}})()'
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
                      + notice.group() + '})(' + notice.group(1) + ')'))
    for original, replacement in edits:
        source = source.replace(original, replacement, 1)
    return source + REFRESH_START + '/* edits:' + json.dumps(edits) + ' */' + REFRESH_END


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
            if remove and START not in old:
                continue
            try:
                stripped = (github_pr_reactions.transform_csp(old, remove=True) if kind == 'host'
                            else github_pr_reactions.transform_webview(old, remove=True))
                stripped = transform_description(transform_refresh(stripped, remove=True), remove=True) if kind == 'host' else stripped
                new = transform(stripped, kind, remove)
            except ValueError:
                if START in old or REFRESH_START in old:
                    raise
                print(f'Warning: unsupported GitHub PR asset {path.name}; skipping this optional fix.')
                continue
            if kind == 'host' and not remove:
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
