import json
import subprocess
import unittest
import github_pr

HOST = 'else if((await pr.githubRepository.getMetadata()).delete_branch_on_merge){const result=await prompt(repo,pr);return result.isReply?void 0:result.message}'
LINK = 'href:url,title:url,"data-vscode-context":JSON.stringify(context),onClick:wrap(event=>{event.preventDefault(),open()},"onClick")'


class GitHubPRTests(unittest.TestCase):
    def test_tree_refresh_is_reversible_idempotent_and_guarded(self):
        source = 's.window.createTreeView("pr:github",{treeDataProvider:this,showCollapseAll:!0,manageCheckboxStateManually:!0});' + 'a=>{this.prsTreeModel.forceClearCache(),this.refreshAllQueryResults(!0)}'
        patched = github_pr.transform_refresh(source)
        # Compile the actual injected code, including all helper declarations.
        subprocess.run(['node', '--check'], input=patched, text=True, check=True)
        self.assertEqual(github_pr.transform_refresh(patched), patched)
        self.assertEqual(github_pr.transform_refresh(patched, remove=True), source)
        self.assertIn('return this.prsTreeModel', patched)
        with self.assertRaises(ValueError):
            github_pr.transform_refresh(source + source)
        with self.assertRaises(ValueError):
            github_pr.transform_refresh(patched.replace('5000', '10000', 1))

    def test_reversible_idempotent_and_guarded(self):
        for kind, original in [('host', HOST), ('webview', LINK)]:
            source = 'prefix;' + original + ';suffix;'
            patched = github_pr.transform(source, kind)
            self.assertEqual(github_pr.transform(patched, kind), patched)
            self.assertEqual(github_pr.transform(patched, kind, remove=True), source)
            with self.assertRaises(ValueError):
                github_pr.transform(original + original, kind)
            with self.assertRaises(ValueError):
                github_pr.transform(patched.replace('data-sweetiebot-url' if kind == 'webview' else 'return void 0', 'changed', 1), kind)

    def test_prompt_only_suppressed_for_repository_auto_deletion(self):
        original = 'if(configured)await automatic(repo,pr);' + HOST
        patched = github_pr.transform(HOST, 'host').split(github_pr.START)[0]
        script = '''
const assert = require('node:assert/strict');
async function check(body, configured, deletes) {
 let prompts=0, automaticCalls=0;
 const repo={}, pr={githubRepository:{getMetadata:async()=>({delete_branch_on_merge:deletes})}};
 const prompt=async()=>{prompts++;return {isReply:false,message:{}}};
 const automatic=async()=>{automaticCalls++};
 const fn = new Function('configured','repo','pr','prompt','automatic','return (async()=>{'+body+'})()');
 await fn(configured,repo,pr,prompt,automatic);
 return {prompts,automaticCalls};
}
(async()=>{
 const before=BEFORE, after=AFTER;
 assert.equal((await check(before,false,true)).prompts,1);
 assert.deepEqual(await check(after,false,true),{prompts:0,automaticCalls:0});
 assert.deepEqual(await check(after,false,false),{prompts:0,automaticCalls:0});
 assert.deepEqual(await check(after,true,true),{prompts:0,automaticCalls:1});
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace('BEFORE', json.dumps(original)).replace('AFTER', json.dumps('if(configured)await automatic(repo,pr);' + patched))
        subprocess.run(['node', '-e', script], check=True)

    def test_number_link_uses_one_opener_and_retains_keyboard_support(self):
        patched = github_pr.transform(LINK, 'webview').split(github_pr.START)[0]
        script = '''
const assert = require('node:assert/strict');
let opens=0;
const url='https://github.com/owner/repo/pull/33',context={},wrap=fn=>fn,open=()=>{opens++};
const before=({BEFORE}),after=({AFTER});
function click(link){if(link.href)opens++;link.onClick({preventDefault(){}});}
click(before);assert.equal(opens,2);
opens=0;click(after);assert.equal(opens,1);
after.onKeyDown({key:'Enter',preventDefault(){}});assert.equal(opens,2);
after.onKeyDown({key:'Escape'});assert.equal(opens,2);
assert.equal(after.role,'link');assert.equal(after.tabIndex,0);
assert.equal(after.title,url);assert.equal(after['data-vscode-context'],JSON.stringify(context));
'''.replace('BEFORE', LINK).replace('AFTER', patched)
        subprocess.run(['node', '-e', script], check=True)
