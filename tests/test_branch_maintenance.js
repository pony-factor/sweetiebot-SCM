'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const children = [], subscriptions = [], outputLines = [];
let tick, cleared = false, enabled = true, refreshed = 0;
const child = () => { const result = new EventEmitter(); result.stdout = new EventEmitter(); result.stderr = new EventEmitter(); result.kill = () => { result.killed = true; }; return result; };
const sandbox = { module: {exports:{}}, process,
  require(name) {
    if (name === './python_runtime') return {resolvePythonExecutable(){return '/resolved/python3';}};
    assert.equal(name,'child_process'); return {spawn(executable,args,options) {
    assert.equal(executable,'/resolved/python3');
    assert.deepEqual(Array.from(args), ['/extension/prune_merged_branches.py','--force','--repo','/repo with spaces']);
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
    const result=child();children.push(result);return result;
  }};},
  setInterval(fn, interval) { assert.equal(interval,600000);tick=fn;return 1; },
  clearInterval(id) { assert.equal(id,1);cleared=true; }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../efs/branch_maintenance'), 'utf8'),sandbox);
const vscode={window:{createOutputChannel(){return {append(chunk){outputLines.push(chunk);},appendLine(line){outputLines.push(line);},dispose(){}};}},workspace:{getConfiguration(){return {get(){return enabled;}}}},extensions:{getExtension(){return {async activate(){return {getAPI(){return {repositories:[
  {rootUri:{scheme:'file',fsPath:'/repo with spaces'},async status(){refreshed++;}},{rootUri:{scheme:'vscode-remote',fsPath:'/remote'}}
]}}}}}}},Uri:{joinPath(_,file){return {fsPath:'/extension/'+file}}}};
(async()=>{
 sandbox.module.exports.registerBranchMaintenance(vscode,{extensionUri:{},subscriptions});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,1);
 tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,1);
 children[0].stdout.emit('data','Pruned deleted origin tracking branch /repo: origin/old\\n');
 children[0].stderr.emit('data','Could not check merged local branches\\n');
 assert(outputLines.some(line=>line.includes('origin/old')));
 assert(outputLines.some(line=>line.includes('Could not check')));
 children[0].emit('exit',0);enabled=false;tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,1);
 assert.equal(refreshed,1);
 enabled=true;tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,2);
 assert.equal(subscriptions.length,2);
 subscriptions[1].dispose();assert(cleared);assert(children[1].killed);
 tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,2);
 console.log('Branch maintenance lifecycle passed');
})().catch(error=>{console.error(error);process.exitCode=1});
