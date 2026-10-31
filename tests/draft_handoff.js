'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDraftHandoff} = require('../extension/codex/draft_handoff');
(async () => {
  const incompleteInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-handoff-'));
  try {
    const modulePath = path.join(incompleteInstall, 'draft_handoff.js');
    fs.copyFileSync(require.resolve('../extension/codex/draft_handoff'), modulePath);
    let installed;
    assert.doesNotThrow(() => { installed = require(modulePath); },
      'A missing PR page must not prevent SCM extension modules from loading');
    await assert.rejects(installed.createDraftHandoff(() => {}), {code: 'ENOENT'},
      'Report the missing asset only when the PR handoff is requested');
  } finally {
    fs.rmSync(incompleteInstall, {recursive: true, force: true});
  }
  let writes = 0, closes = 0, merges = 0;
  const handoff = await createDraftHandoff(async uri => {
    writes++;
    const values = new URLSearchParams(uri.query);
    assert.equal(values.get('title'), '🦄 Open a PR');
    assert.equal(values.get('body'), 'A paragraph.\n\nhttps://github.com/owner/repo/pull/1');
    return {number:2,url:'https://github.com/owner/repo/pull/2'};
  });
  try {
    const url = handoff.origin + '/kefania-draft/11111111-2222-4333-8444-555555555555';
    handoff.register('11111111-2222-4333-8444-555555555555', {pony:{slug:'bushel'},onClose:async()=>{closes++;},onMerge:async()=>{merges++;return {merged:true,sha:'a'.repeat(40)}}});
    let closeAfterMerge = false;
    let ludicrous = false;
    const liveId = '22222222-2222-4333-8444-555555555555';
    let appearance={bg:'#101010',text:'#eeeeee'};
    handoff.register(liveId, {closeAfterMerge:()=>closeAfterMerge,ludicrousMode:()=>ludicrous,appearance:async()=>appearance});
    const liveState = async () => (await fetch(handoff.origin+'/kefania-draft/'+liveId+'/state')).json();
    assert.equal((await liveState()).closeAfterMerge,false);
    closeAfterMerge = true;
    assert.equal((await liveState()).closeAfterMerge,true,'Close-after-merge preference is read live');
    assert.deepEqual((await liveState()).appearance,appearance);
    appearance=null;
    assert.equal((await liveState()).appearance,null,'Appearance settings are read live');
    assert.equal((await liveState()).ludicrousMode,false);
    assert.equal((await liveState()).showKefaniaCloseButton,true);
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'left');
    let showClose = true, position = 'left';
    handoff.register(liveId, {closeAfterMerge:()=>closeAfterMerge,ludicrousMode:()=>ludicrous,appearance:()=>appearance,showKefaniaCloseButton:()=>showClose,kefaniaCloseButtonPosition:()=>position});
    showClose = false; position = 'right';
    assert.equal((await liveState()).showKefaniaCloseButton,false,'Live preference hides the X');
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'right','Live preference fixes the X to the right');
    showClose = true; position = 'middle';
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'middle','Live preference aligns the X above the pony card');
    position = 'left';
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'left','Live preference restores left alignment');
    position = 'invalid';
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'left','Unknown positions fall back safely');
    handoff.register(liveId, {kefaniaCloseButtonLeft:false});
    assert.equal((await liveState()).kefaniaCloseButtonPosition,'right','Legacy left/right callers still work');
    handoff.register(liveId, {closeAfterMerge:()=>closeAfterMerge,ludicrousMode:()=>ludicrous,appearance:()=>appearance,kefaniaCloseButtonPosition:()=>position});
    ludicrous = true;
    assert.equal((await liveState()).ludicrousMode,true,'An open dialog observes preference changes');
    ludicrous = 'true';
    assert.equal((await liveState()).ludicrousMode,false,'Only an explicit boolean enables bypass');
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Publish pull request/);
    assert.match(pageHtml, /function renderMergeMarkdown\(/, 'The browser page uses the shared Markdown renderer');
    assert.match(pageHtml, /renderMarkdown\(el\('profile'\),imageIndex\(cleanProfileReferences\(state\.profile\)\)\)/, 'The confirmation window renders the independent pony profile as Markdown, including timestamped moment links');
    assert.doesNotMatch(pageHtml, /__MARKDOWN_RENDERER__/, 'Shared renderer is inserted before serving');
    assert.match(pageHtml, /function keepOpenForPony\(state\)/, 'Automatic merge close must inspect pony research and pending cache writes');
    assert.equal((pageHtml.match(/!keepOpenForPony\(state\)&&updated&&!keepOpenForPony\(updated\)/g)||[]).length, 2,
      'Normal and locally signed squash merges both retain pending pony research');
    assert.equal(writes,0,'Opening a draft must not publish it');
    const detailsId = '44444444-2222-4333-8444-555555555555';
    handoff.register(detailsId, {decorateDraft: draft => ({
      ...draft, body: draft.body + '\n\n<details>\n<summary>Source details</summary>\n\nOnline URL\n</details>'
    })});
    const detailsUrl = handoff.origin + '/kefania-draft/' + detailsId;
    const detailsResult = await fetch(detailsUrl + '/draft', { method:'POST',
      headers:{Origin:handoff.origin,'Content-Type':'application/json'},
      body:JSON.stringify({title:'Sample',body:'Description'}) });
    assert.equal(detailsResult.status,200);
    assert.match((await (await fetch(detailsUrl+'/state')).json()).draft.body, /<summary>Source details<\/summary>/);
    assert.equal(writes,0,'Decorating a preview does not publish');
    assert.equal((await fetch(url+'/close')).status,405,'Closing requires an explicit local POST');
    const savingId = '77777777-2222-4333-8444-555555555555';
    let finishCache;
    const cacheGate = new Promise(resolve => { finishCache = resolve; });
    handoff.register(savingId, { pony: { slug: 'flitter' }, onResult: () => cacheGate });
    const savingUrl = handoff.origin + '/kefania-draft/' + savingId;
    const savingState = async () => (await (await fetch(savingUrl + '/state')).json());
    assert.equal((await savingState()).ponyCachePending, false, 'No cache operation has started before research returns');
    const saveResponse = await fetch(savingUrl + '/pony', { method: 'POST',
      headers: { Origin: handoff.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'Flitter research.' }) });
    assert.equal(saveResponse.status, 200);
    assert.equal((await savingState()).ponyCachePending, true, 'Research results keep the window open while cache publication is queued');
    finishCache();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await savingState()).ponyCachePending, false, 'The confirmation state observes completed durable cache handoff');
    assert.equal((await fetch(url.replace(/555555555555$/, '666666666666'))).status,410);
    const post = (path, value) => fetch(url+path,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
    assert.equal((await post('/pony', {profile:'Bushel profile with a source.'})).status,200);
    let state = await (await fetch(url+'/state')).json();
    assert.equal(state.ludicrousMode,false,'Confirmation stays enabled by default');
    assert.equal(state.profile,'Bushel profile with a source.');
    assert.equal(state.draft,undefined, 'Pony research can complete before the PR draft');
    assert.equal(writes,0);
    assert.equal((await post('/pony',{profile:'🦄'.repeat(26000)})).status,413,'Enforce bytes, not string length');
    const body = JSON.stringify({title:'🦄 Open a PR',body:'A paragraph.\n\nhttps://github.com/owner/repo/pull/1'});
    const rejected = await fetch(url,{method:'POST',headers:{Origin:'https://chatgpt.com','Content-Type':'application/json'},body});
    assert.equal(rejected.status,403);
    assert.equal(writes,0);
    assert.equal((await post('/close',{})).status,200,'Close is available while PR drafting is still in progress');
    assert.equal(closes,1,'Early close invokes only the window close handler');
    assert.equal(writes,0,'Closing before publication never publishes a draft');
    assert.equal((await post('/merge',{})).status,409,'Cannot merge before publication');
    const result = await fetch(url,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    assert.equal(result.status,200);
    assert.equal((await result.json()).number,2);
    assert.equal(writes,1);
    assert.equal((await post('',{})).status,200);
    assert.equal(writes,1,'Double publication must return the existing result');
    state = await (await fetch(url+'/state')).json();
    assert.equal(state.profile,'Bushel profile with a source.');
    assert.equal(state.result.number,2);
    assert.equal((await fetch(url+'/merge')).status,405,'Merge requires an authenticated local POST');
    const merged=await post('/merge',{});
    assert.equal(merged.status,200);
    assert.equal((await merged.json()).merged,true);
    assert.equal((await post('/merge',{})).status,200,'Repeated requests cannot merge twice');
    assert.equal(merges,1);
    assert.equal((await (await fetch(url+'/state')).json()).mergeResult.merged,true);
    assert.equal((await post('/close',{})).status,200);
    assert.equal(closes,2,'Closing the confirmation after publication does not publish again');
    const automaticId='22222222-2222-4333-8444-555555555555';
    handoff.register(automaticId,{pony:{slug:'maud-pie'},autoPublish:true,onClose:async()=>{closes++;}});
    const automaticUrl=handoff.origin+'/kefania-draft/'+automaticId;
    await fetch(automaticUrl+'/draft',{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    const automaticState=await (await fetch(automaticUrl+'/state')).json();
    assert.equal(automaticState.result.number,2,'Auto-publish creates the PR without a confirmation POST');
    assert.equal(automaticState.profile,undefined,'Auto-publish never waits for pony research');
    assert.equal(writes,2);
    assert.equal((await fetch(automaticUrl+'/close',{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:'{}'})).status,200);
    assert.equal(closes,3,'Auto-published PR can close before pony research finishes');
    const cachedId='33333333-2222-4333-8444-555555555555';
    handoff.register(cachedId,{pony:{slug:'bushel'},profile:'Previously sourced character.',autoPublish:false});
    const cachedState = await (await fetch(handoff.origin+'/kefania-draft/'+cachedId+'/state')).json();
    assert.equal(cachedState.profile,'Previously sourced character.','Cache hits are visible without a pony callback');
    assert.equal(cachedState.draft,undefined);
    assert.equal(writes,2,'A cache hit never publishes a PR');
    const choiceId = '99999999-2222-4333-8444-555555555555';
    let preserved = 0;
    handoff.register(choiceId, { autoPublish: true,
      onMerge: async () => { throw Object.assign(Error('A human squash needs an explicit method choice.'), { code: 'SQUASH_AUTHOR_CHOICE_REQUIRED' }); },
      onMergePreservingCommits: async () => { preserved++; return { merged: true, sha: 'b'.repeat(40) }; }
    });
    const choiceUrl = handoff.origin + '/kefania-draft/' + choiceId;
    const choicePost = suffix => fetch(choiceUrl + suffix, { method: 'POST', headers: { Origin: handoff.origin, 'Content-Type': 'application/json' }, body: '{}' });
    await fetch(choiceUrl + '/draft', { method: 'POST', headers: { Origin: handoff.origin, 'Content-Type': 'application/json' }, body });
    assert.equal((await choicePost('/merge-history')).status, 409, 'No silent fallback before the author choice is shown');
    assert.equal((await choicePost('/merge')).status, 409);
    assert.equal((await (await fetch(choiceUrl + '/state')).json()).mergeChoice, 'SQUASH_AUTHOR_CHOICE_REQUIRED');
    assert.equal(preserved, 0, 'Showing the choice does not merge anything');
    assert.equal((await choicePost('/merge-history')).status, 200);
    await choicePost('/merge-history');
    assert.equal(preserved, 1, 'A replay cannot merge twice');
    const signerId='99999999-2222-4333-8444-666666666666';
    let signed=0;
    handoff.register(signerId,{autoPublish:true,
      onMerge:async()=>{throw Object.assign(Error('Original bot authorship needs a method choice.'),{code:'SQUASH_AUTHOR_CHOICE_REQUIRED'});},
      onMergeLocalSigned:async()=>{signed++;return {merged:true,sha:'c'.repeat(40)};}
    });
    const signerUrl=handoff.origin+'/kefania-draft/'+signerId;
    const signerPost=suffix=>fetch(signerUrl+suffix,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:'{}'});
    await fetch(signerUrl+'/draft',{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    assert.equal((await signerPost('/merge-local-signed')).status,409,'No local signed rewrite before attribution choice');
    assert.equal(signed,0);
    assert.equal((await signerPost('/merge')).status,409);
    assert.equal((await (await fetch(signerUrl+'/state')).json()).localSignedMergeAvailable,true);
    assert.equal((await fetch(signerUrl+'/merge-local-signed')).status,405,'GET never triggers a signer');
    assert.equal((await signerPost('/merge-local-signed')).status,200);
    assert.equal(signed,1,'Signed local squash is invoked only on the explicit authorized request');
    assert.equal((await signerPost('/merge-local-signed')).status,200);
    assert.equal(signed,1,'A replay cannot sign and rewrite twice');
    const blockerId='77777777-2222-4333-8444-555555555555';
    let helped = 0;
    handoff.register(blockerId, { onMerge: async () => { throw Error('Resolve the overlapping edits against the current base, preserving both intentions.'); },
      onMergeHelp: async () => { helped++; return true; } });
    const blockerUrl = handoff.origin+'/kefania-draft/'+blockerId;
    const blockerPost = suffix => fetch(blockerUrl+suffix, {method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await blockerPost('/merge-help')).status,409,'Recovery cannot open before a failed merge');
    assert.equal((await fetch(blockerUrl,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body})).status,200,'Publish the test PR before testing merge failure');
    assert.equal((await fetch(blockerUrl+'/merge-help')).status,405,'Recovery requires a POST');
    assert.equal((await blockerPost('/merge')).status,409);
    const blockedState = await (await fetch(blockerUrl+'/state')).json();
    assert.equal(blockedState.mergeIssue.kind,'conflict','Overlapping edits surface as an actual conflict state');
    assert.match(blockedState.mergeIssue.message,/overlapping edits/);
    assert.equal(blockedState.mergeResult,undefined,'Recovery never pretends a merge completed');
    assert.equal(blockedState.mergeHelpAvailable,true);
    assert.equal((await blockerPost('/merge-help')).status,200);
    assert.equal(helped,1,'A deliberate click opens the shared Lindsey recovery dashboard');
    assert.equal((await (await fetch(blockerUrl+'/state')).json()).mergeHelpOpened,true);
    assert.equal((await fetch(blockerUrl+'/merge-help',{method:'POST',headers:{Origin:'https://malicious.example','Content-Type':'application/json'},body:'{}'})).status,403);
    const failureId='88888888-2222-4333-8444-555555555555';
    handoff.register(failureId,{onMerge:async()=>{throw Object.assign(Error('Human authorship requires another method.'),{code:'SQUASH_AUTHOR_CHOICE_REQUIRED'});}});
    const failureUrl=handoff.origin+'/kefania-draft/'+failureId;
    const failurePost=suffix=>fetch(failureUrl+suffix,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await fetch(failureUrl,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body})).status,200);
    await failurePost('/merge');
    assert.equal((await (await fetch(failureUrl+'/state')).json()).mergeIssue.kind,'method','Authorship choice is not mislabeled a merge conflict');
    assert.equal((await failurePost('/merge-help')).status,503,'Unavailable resolution view is not falsely reported open');
    // Active confirmation polling renews the idle deadline while preserving
    // the original security limit for stale pages and background callbacks.
    const clock = Date.now;
    try {
      let now = clock();
      Date.now = () => now;
      const activeId = '44444444-2222-4333-8444-555555555555';
      const activeUrl = handoff.origin + '/kefania-draft/' + activeId;
      handoff.register(activeId);
      now += 59 * 60 * 1000;
      assert.equal((await fetch(activeUrl + '/state')).status, 200, 'An active confirmation stays readable');
      now += 59 * 60 * 1000;
      assert.equal((await fetch(activeUrl + '/state')).status, 200,
        'Polling keeps an active confirmation alive past the original one-hour limit');
      now += 60 * 60 * 1000 + 1;
      assert.equal((await fetch(activeUrl + '/state')).status, 410,
        'Leaving an active page unattended for an hour still expires its capability');
      assert.equal((await fetch(activeUrl + '/draft', {
        method: 'POST', headers: { Origin: handoff.origin, 'Content-Type': 'application/json' },
        body
      })).status, 410, 'Idle expiry continues to reject late draft submissions');

      const boundedId = '55555555-2222-4333-8444-555555555555';
      const boundedUrl = handoff.origin + '/kefania-draft/' + boundedId;
      handoff.register(boundedId);
      for (let i = 0; i < 14; i++) {
        now += 50 * 60 * 1000;
        assert.equal((await fetch(boundedUrl + '/state')).status, 200);
      }
      now += 50 * 60 * 1000;
      assert.equal((await fetch(boundedUrl + '/state')).status, 410,
        'Even repeated polling cannot keep a confirmation live beyond twelve hours');
    } finally { Date.now = clock; }
    const now=Date.now;
    try {
      Date.now=()=>now()+3600001;
      assert.equal((await fetch(url+'/state')).status,410,'Draft state expires');
      assert.equal((await post('/merge',{})).status,410,'Expiry still blocks PR mutations');
      const beforeClose=closes;
      assert.equal((await post('/close',{})).status,200,'Close remains available after draft expiry');
      assert.equal(closes,beforeClose+1);
      assert.equal((await fetch(url+'/close',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'})).status,403,'Expired close retains its same-origin guard');
    } finally { Date.now=now; }
    console.log('Local browser draft handoff and close checks passed.');
  } finally {handoff.dispose();}
})().catch(error => {console.error(error);process.exitCode=1;});
