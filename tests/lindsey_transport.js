'use strict';
const assert = require('node:assert/strict');
const { createLindseyTransport } = require('../extension/merge/lindsey_transport');

(async () => {
  const {decodeKeychainPassword} = require('../extension/github/app_settings');
  const fixture = 'TEST MULTILINE\nKEYCHAIN PASSWORD\n';
  assert.equal(decodeKeychainPassword(Buffer.from(fixture).toString('hex')),fixture.trim());
  assert.equal(decodeKeychainPassword(fixture),fixture.trim());
  assert.equal(decodeKeychainPassword('abc'),'abc','Odd-length hex text is preserved');
  let clock = 0, minted = 0;
  const writes = [];
  const transport = createLindseyTransport('owner/repo', {
    env: {SWEETIEBOT_BOT_IDENTITY_MODE:'separate-apps'}, now:()=>clock,
    async getToken(role, repository, options) {
      assert.equal(role,'lindsey'); assert.equal(repository,'owner/repo');
      minted++;
      return {token:options.readOnly?'lindsey-read':`lindsey-write-${minted}`,
        expiresAt:new Date(clock+3600000).toISOString()};
    },
    async fetchImpl(url, options) {
      writes.push({url,options});
      return {ok:true,status:200,json:async()=>({ok:true})};
    }
  });
  await transport.api('repos/owner/repo/pulls/12');
  assert.equal(writes[0].options.headers.Authorization,'Bearer lindsey-read');
  await transport.api('repos/owner/repo/pulls/12/merge','PUT',['-f','merge_method=squash']);
  const token = await transport.gitToken();
  assert.equal(writes[1].options.headers.Authorization,'Bearer '+token);
  assert.equal(JSON.parse(writes[1].options.body).merge_method,'squash');
  assert.equal(minted,2,'Git and merge writes share Lindsey credentials');
  clock = 3590000;
  assert.notEqual(await transport.gitToken(),token,'Long CI waits refresh expiring credentials');
  await assert.rejects(transport.api('repos/other/repo/issues/1/comments','POST'),/outside/);
  await assert.rejects(transport.api('repos/owner/repo/../other/issues','POST'),/outside/);
  const legacy = createLindseyTransport('owner/repo',{env:{SWEETIEBOT_BOT_IDENTITY_MODE:'legacy'},
    fetchImpl:()=>assert.fail('Never fall back to user authentication')});
  await assert.rejects(legacy.gitToken(),/Lindsey GitHub App/);
  await assert.rejects(legacy.api('repos/owner/repo'),/Lindsey GitHub App/);
  console.log('Lindsey read/write identity, Git credentials, refresh and repository scope passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
