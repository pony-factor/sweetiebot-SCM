'use strict';

// Integrate a bot-opened PR locally without replacing any existing commit.
// The two-parent commit retains the selected head and lets GitHub recognize
// the original PR as merged. App-enabled integration uses the verified bot;
// the original human commits remain in the parent chain.
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyCommit } = require('./human-squash-merge');
const { commitIdentity, attributedCommitTree, verifyLocalCommitIdentity } = require('./commit-signing');
const { waitForMergeChecks } = require('./checks');
const SHA = /^[a-f0-9]{40}$/i;

async function localAuthorMerge({ repository, number, original, headSha, baseSha, tree, author, message,
  git, api, directory, checkOptions, expectChecks, onProgress = () => {}, requireSignedCommit = false,
  privateRepository = false, integratedTree = false, createCommitTree = attributedCommitTree, automationAuthor }) {
  const commitAuthor = automationAuthor || author;
  const verification = { allowBot: Boolean(automationAuthor), committer: automationAuthor };
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
    // A dirty PR may have been resolved in the independently verified index.
    // Other blockers and destination branch rules remain authoritative.
    if ((fresh.mergeable === false || fresh.mergeable_state === 'blocked') &&
        !(integratedTree && fresh.mergeable_state === 'dirty'))
      return 'GitHub reports a blocked PR without a verified local conflict resolution.';
  };
  onProgress('waiting-checks',{sha:headSha});
  const checks = await waitForMergeChecks(api,repository,headSha,{...checkOptions,expectChecks,collectEvidence:true,
    onPoll: checks => onProgress('checks-polled',{sha:headSha,...checks})});
  if (checks.state !== 'passed') return { ...blocked('Checks on the integrated PR head have not passed.'),
    status:checks.state==='pending'?'waiting':'checks_failed',sha:headSha,previousHeadSha:original.head.sha };
  const reason = await checkSnapshot();
  if (reason) return blocked(reason);
  // A current-base resolution may differ from the unchanged PR head tree.
  // Verify the exact staged index, not a model-supplied tree.
  const verifiedTree = integratedTree ? await git('write-tree') :
    await git('rev-parse', headSha + '^{tree}');
  if (verifiedTree !== tree) throw Error('The locally verified integration tree changed.');
  onProgress('preparing-merge',{sha:headSha});
  // Use the actual local committer for signature attribution, while preserving
  // the selected PR author. Signing is preferred even if commit.gpgsign is off.
  let identity = await commitIdentity(git, commitAuthor, requireSignedCommit, true, automationAuthor);
  const file=path.join(directory,'.git','sweetiebot-local-merge-message');
  await fs.writeFile(file,message+'\n',{mode:0o600});
  const create = identity => createCommitTree({ directory, tree,
    parents: [baseSha, headSha], messageFile: file, identity });
  let sha;
  try {
    sha = await create(identity);
  } catch (error) {
    if (requireSignedCommit || !identity.signed) throw error;
    identity = { author: commitAuthor, committer: commitAuthor, signed: false };
    sha = await create(identity);
  }
  if (!SHA.test(sha)) throw Error('Local Git did not produce a merge commit.');
  if (identity.signed && !/(?:^|\n)gpgsig /.test(await git('cat-file','-p',sha))) {
    if (requireSignedCommit) throw Error('The signed merge commit is missing its signature.');
    identity = { author: commitAuthor, committer: commitAuthor, signed: false };
    sha = await create(identity);
    if (!SHA.test(sha)) throw Error('Local Git did not produce an unsigned fallback commit.');
  }
  await verifyLocalCommitIdentity(git, sha, identity);
  const signMerge = identity.signed;
  const [name,email,committerName,committerEmail,...body]=(await git('show','-s','--format=%an%x00%ae%x00%cn%x00%ce%x00%B',sha)).split('\0');
  verifyCommit({commit:{author:{name,email},committer:{name:committerName,email:committerEmail},message:body.join('\0')}},message,commitAuthor,verification);
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
  verifyCommit(destination,message,commitAuthor,verification);
  // Signature verification is informational: unavailable keys or a GitHub
  // identity mismatch must not prevent an otherwise authorized merge.
  const verified = destination.commit?.verification?.verified === true;
  if (destination.parents?.length!==2 || destination.parents[0].sha!==baseSha || destination.parents[1].sha!==headSha) throw Error('Remote merge ancestry was not verified.');
  for (let attempt=0;attempt<12;attempt++) {
    const fresh=await api(prPath);
    if (fresh.merged===true && fresh.merge_commit_sha===sha && fresh.base?.ref===base) {
      return {merged:true,status:'merged',number,sha,headSha,previousHeadSha:original.head.sha,
        author:commitAuthor,base,baseSha,authorsPreserved:true,method:'local-git',signed:signMerge,verified,
        url:'https://github.com/'+repository+'/commit/'+sha};
    }
    if (attempt<11) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Local Git pushed the verified merge, but GitHub PR bookkeeping is not confirmed; do not repeat the merge.');
}
module.exports={localAuthorMerge};
