'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/pr_background.js'), 'utf8');
let listener;
const settings = [];
const contents = {
  getBackgroundThrottling: () => true,
  setBackgroundThrottling: value => settings.push(value),
  on(event, callback) { assert.equal(event, 'did-start-navigation'); listener = callback; },
};
vm.runInNewContext(source, { URL, URLSearchParams, _view: { webContents: contents } });
const callback = 'http://127.0.0.1:1234/kefania-draft/11111111-2222-4333-8444-555555555555';
const navigate = (url, main = true) => listener({}, url, false, main);
navigate('https://chatgpt.com/');
assert.equal(settings.at(-1), true, 'Ordinary tabs retain throttling');
navigate('https://chatgpt.com/#sweetiebot_pr=1&return_to=' + encodeURIComponent(callback + '/draft'));
assert.equal(settings.at(-1), false, 'Workflow starts before preload removes its fragment');
navigate('https://chatgpt.com/c/generated-conversation');
assert.equal(settings.at(-1), false, 'SPA conversation navigation keeps the background job alive');
navigate('https://example.com/frame', false);
assert.equal(settings.at(-1), false, 'A child frame cannot cancel the job');
navigate(callback + '/draft#title=Ready&body=Description');
assert.equal(settings.at(-1), false, 'Return navigation remains alive while minimized');
navigate('https://example.com/');
assert.equal(settings.at(-1), true, 'Leaving the workflow restores the original setting');
navigate('https://chatgpt.com/');
assert.equal(settings.at(-1), true);
navigate(callback);
assert.equal(settings.at(-1), false, 'Confirmation polling also survives minimizing');
navigate('http://127.0.0.1:1234/unrelated');
assert.equal(settings.at(-1), true);
navigate('https://chatgpt.com/#sweetiebot_pr=1&return_to=' + encodeURIComponent('https://example.com/draft'));
assert.equal(settings.at(-1), true, 'Invalid callback does not opt in');
listener({ url: callback, isMainFrame: true });
assert.equal(settings.at(-1), false, 'Support current Electron navigation event details');
listener({ url: 'https://example.com/', isMainFrame: true });
assert.equal(settings.at(-1), true);
navigate('https://chatgpt.com/#sweetiebot_merge=1&q=Merge');
assert.equal(settings.at(-1), false, 'Bulk merge keeps running in its background window');
navigate('https://chatgpt.com/c/merge-conversation');
assert.equal(settings.at(-1), false, 'Merge conversation navigation retains background execution');
navigate('http://127.0.0.1:1234/lindsey-merge/11111111-2222-4333-8444-555555555555#result=prepared');
assert.equal(settings.at(-1), false, 'Local CLI handoff remains active in a background merge window');
navigate('https://example.com/');
assert.equal(settings.at(-1), true, 'Leaving a merge chat restores throttling');
console.log('Background PR lifecycle checks passed.');
