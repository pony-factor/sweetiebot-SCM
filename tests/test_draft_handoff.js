'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createDraftHandoff} = require('../efs/draft_handoff');
(async () => {
  const incompleteInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-handoff-'));
  try {
    const modulePath = path.join(incompleteInstall, 'draft_handoff.js');
    fs.copyFileSync(require.resolve('../efs/draft_handoff'), modulePath);
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
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Publish pull request/);
    assert.equal(writes,0,'Opening a draft must not publish it');
    assert.equal((await fetch(url+'/close')).status,405,'Closing requires an explicit local POST');
    assert.equal((await fetch(url.replace(/555555555555$/, '666666666666'))).status,410);
    const post = (path, value) => fetch(url+path,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
    assert.equal((await post('/pony', {profile:'Bushel profile with a source.'})).status,200);
    let state = await (await fetch(url+'/state')).json();
    assert.equal(state.profile,'Bushel profile with a source.');
    assert.equal(state.draft,undefined, 'Pony research can complete before the PR draft');
    assert.equal(writes,0);
    assert.equal((await post('/pony',{profile:'🦄'.repeat(26000)})).status,413,'Enforce bytes, not string length');
    const body = JSON.stringify({title:'🦄 Open a PR',body:'A paragraph.\n\nhttps://github.com/owner/repo/pull/1'});
    const rejected = await fetch(url,{method:'POST',headers:{Origin:'https://chatgpt.com','Content-Type':'application/json'},body});
    assert.equal(rejected.status,403);
    assert.equal(writes,0);
    assert.equal((await post('/close',{})).status,409,'Cannot close before publication');
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
    assert.equal(closes,1,'Closing the confirmation never publishes again');
    const automaticId='22222222-2222-4333-8444-555555555555';
    handoff.register(automaticId,{pony:{slug:'maud-pie'},autoPublish:true,onClose:async()=>{closes++;}});
    const automaticUrl=handoff.origin+'/kefania-draft/'+automaticId;
    await fetch(automaticUrl+'/draft',{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    const automaticState=await (await fetch(automaticUrl+'/state')).json();
    assert.equal(automaticState.result.number,2,'Auto-publish creates the PR without a confirmation POST');
    assert.equal(automaticState.profile,undefined,'Auto-publish never waits for pony research');
    assert.equal(writes,2);
    assert.equal((await fetch(automaticUrl+'/close',{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body:'{}'})).status,200);
    assert.equal(closes,2,'Auto-published PR can close before pony research finishes');
    const cachedId='33333333-2222-4333-8444-555555555555';
    handoff.register(cachedId,{pony:{slug:'bushel'},profile:'Previously sourced character.',autoPublish:false});
    const cachedState = await (await fetch(handoff.origin+'/kefania-draft/'+cachedId+'/state')).json();
    assert.equal(cachedState.profile,'Previously sourced character.','Cache hits are visible without a pony callback');
    assert.equal(cachedState.draft,undefined);
    assert.equal(writes,2,'A cache hit never publishes a PR');
    console.log('Local browser draft handoff and close checks passed.');
  } finally {handoff.dispose();}
})().catch(error => {console.error(error);process.exitCode=1;});
