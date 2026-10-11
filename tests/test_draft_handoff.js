'use strict';
const assert = require('node:assert/strict');
const {createDraftHandoff} = require('../efs/draft_handoff');
(async () => {
  let writes = 0;
  const handoff = await createDraftHandoff(async uri => {
    writes++;
    const values = new URLSearchParams(uri.query);
    assert.equal(values.get('title'), '🦄 Open a PR');
    assert.equal(values.get('body'), 'A paragraph.\n\nhttps://github.com/owner/repo/pull/1');
    return {number:2,url:'https://github.com/owner/repo/pull/2'};
  });
  try {
    const url = handoff.origin + '/kefania-draft/11111111-2222-4333-8444-555555555555';
    handoff.register('11111111-2222-4333-8444-555555555555', {pony:{slug:'bushel'}});
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Publish pull request/);
    assert.equal(writes,0,'Opening a draft must not publish it');
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
    const result = await fetch(url,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    assert.equal(result.status,200);
    assert.equal((await result.json()).number,2);
    assert.equal(writes,1);
    assert.equal((await post('',{})).status,200);
    assert.equal(writes,1,'Double publication must return the existing result');
    state = await (await fetch(url+'/state')).json();
    assert.equal(state.profile,'Bushel profile with a source.');
    assert.equal(state.result.number,2);
    console.log('Local browser draft handoff checks passed.');
  } finally {handoff.dispose();}
})().catch(error => {console.error(error);process.exitCode=1;});
