'use strict';

// Integrate a bot-opened PR locally without replacing any existing commit.
// The two-parent commit retains the selected head and lets GitHub recognize
// the original PR as merged while using the verified human Git author.
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyCommit } = require('./human_squash_merge');
const { waitForMergeChecks } = require('./checks');
const SHA = /^[a-f0-9]{40}$/i;

async function localAuthorMerge({ repository, number, original, headSha, baseSha, tree, author, message,
  git, api, directory, checkOptions, expectChecks, onProgress = () => {}, requireSignedCommit = false, privateRepository = false }) {
  const root = 'repos/' + repository, prPath = root + '/pulls/' + number;
  const head = original.head.ref, base = original.base.ref;
  const blocked = reason => ({ merged:false,status:'blocked',number,reason,headSha,base,baseSha });
  const checkSnapshot = async () => {
    const fresh = await api(prPath);
    if (fresh.state !== 'open' || fresh.draft || fresh.merged || fresh.merged_at || fresh.stack
        || fresh.head?.sha !== headSha || fresh.head?.ref !== head || fresh.base?.ref !== base
        || fresh.title !== original.title || fresh.head?.repo?.full_name !== repository
        || fresh.base?.repo?.full_name !== repository) throw Error('PR changed before local Git merge.');
    const branch = await api(root + '/branches/' + encodeURIComponent(base));
    if (branch.commit?.sha !== baseSha) throw Object.assign(Error('Base changed before local Git merge.'),{code:'MERGE_BASE_CHANGED'});
    // Never use direct Git pushes to bypass a protected branch or repository rule.
    if (branch.protected !== false) return 'The base branch is protected; local Git cannot bypass its merge policy.';
    let rules;
    try { rules = await api(root + '/rules/branches/' + encodeURIComponent(base)); }
    catch (error) {
      // GitHub Free private repos cannot enforce rulesets. This exact product
      // availability response is distinct from an unknown permission failure.
      // The fresh branch.protected === false check above remains mandatory.
      const unavailable = privateRepository && error.status === 403
        && /^Upgrade to GitHub Pro or make this repository public to enable this feature\.?$/i.test(error.githubMessage || '');
      if (!unavailable) throw error;
      rules = [];
    }
    if (!Array.isArray(rules) || rules.length) return 'The base has active branch rules; local Git will not bypass them.';
    if (fresh.mergeable === false || fresh.mergeable_state === 'blocked') return 'GitHub reports a blocked or conflicting PR.';
  };
  onProgress('waiting-checks',{sha:headSha});
  const checks = await waitForMergeChecks(api,repository,headSha,{...checkOptions,expectChecks,collectEvidence:true,
    onPoll: checks => onProgress('checks-polled',{sha:headSha,...checks})});
  if (checks.state !== 'passed') return { ...blocked('Checks on the integrated PR head have not passed.'),
    status:checks.state==='pending'?'waiting':'checks_failed',sha:headSha,previousHeadSha:original.head.sha };
  const reason = await checkSnapshot();
  if (reason) return blocked(reason);
  if (await git('rev-parse',headSha+'^{tree}') !== tree) throw Error('The local merge tree differs from the checked PR head.');
  onProgress('preparing-merge',{sha:headSha});
  // Unlike git commit, git commit-tree does not honor commit.gpgsign by itself.
  // Use the same configuration as incremental Lindsey resolution commits.
  const signingConfigured = (await git('config', '--type=bool', '--default', 'false',
    '--get', 'commit.gpgsign')) === 'true';
  const signMerge = requireSignedCommit || signingConfigured;
  const file=path.join(directory,'.git','sweetiebot-local-merge-message');
  await fs.writeFile(file,message+'\n',{mode:0o600});
  const sha=await git('-c','user.name='+author.name,'-c','user.email='+author.email,
    'commit-tree',...(signMerge?['-S']:[]),tree,'-p',baseSha,'-p',headSha,'-F',file);
  if (!SHA.test(sha)) throw Error('Local Git did not produce a verified merge commit.');
  const [name,email,...body]=(await git('show','-s','--format=%an%x00%ae%x00%B',sha)).split('\0');
  verifyCommit({commit:{author:{name,email},message:body.join('\0')}},message,author);
  if (signMerge && !/(?:^|\n)gpgsig /.test(await git('cat-file','-p',sha))) throw Error('Local merge commit is missing its configured signature; no branch was pushed.');
  if (await git('rev-parse',sha+'^1')!==baseSha || await git('rev-parse',sha+'^2')!==headSha) throw Error('Local merge ancestry does not preserve the selected base and head.');
  const changed = await checkSnapshot();
  if (changed) return blocked(changed);
  onProgress('merging',{sha,title:message.split('\n')[0]});
  // Ordinary fast-forward only: a concurrent destination update rejects this push.
  onProgress('pushing-merge',{sha,title:message.split('\n')[0]});
  await git('push','origin',sha+':refs/heads/'+base);
  onProgress('verifying-merge',{sha});
  const destination=await api(root+'/commits/'+sha);
  verifyCommit(destination,message,author);
  if (signMerge && destination.commit?.verification?.verified !== true) {
    throw Error('The signed merge reached the base, but GitHub did not verify its signature (' +
      (destination.commit?.verification?.reason || 'unknown reason') + '); inspect the pushed commit before retrying.');
  }
  if (destination.parents?.length!==2 || destination.parents[0].sha!==baseSha || destination.parents[1].sha!==headSha) throw Error('Remote merge ancestry was not verified.');
  for (let attempt=0;attempt<12;attempt++) {
    const fresh=await api(prPath);
    if (fresh.merged===true && fresh.merge_commit_sha===sha && fresh.base?.ref===base) {
      return {merged:true,status:'merged',number,sha,headSha,previousHeadSha:original.head.sha,
        author,base,baseSha,authorsPreserved:true,method:'local-git',...(signMerge?{signed:true}:{}),url:'https://github.com/'+repository+'/commit/'+sha};
    }
    if (attempt<11) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Local Git pushed the verified merge, but GitHub PR bookkeeping is not confirmed; do not repeat the merge.');
}
module.exports={localAuthorMerge};
