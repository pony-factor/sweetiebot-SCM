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
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Publish pull request/);
    assert.equal(writes,0,'Opening a draft must not publish it');
    const body = JSON.stringify({title:'🦄 Open a PR',body:'A paragraph.\n\nhttps://github.com/owner/repo/pull/1'});
    const rejected = await fetch(url,{method:'POST',headers:{Origin:'https://chatgpt.com','Content-Type':'application/json'},body});
    assert.equal(rejected.status,403);
    assert.equal(writes,0);
    const result = await fetch(url,{method:'POST',headers:{Origin:handoff.origin,'Content-Type':'application/json'},body});
    assert.equal(result.status,200);
    assert.equal((await result.json()).number,2);
    assert.equal(writes,1);
    console.log('Local browser draft handoff checks passed.');
  } finally {handoff.dispose();}
})().catch(error => {console.error(error);process.exitCode=1;});
