const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const hooks = {};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../assets/codex/queued-edit.js'), 'utf8'), {
    globalThis: {__SCM_TOOLKIT_QUEUE_EDIT_TEST__: hooks}, Symbol, Map, Promise,
});
const {QueueEdit} = hooks;
function fixture() {
    const context = {imageAttachments:[{src:'attachment.png'}], fileAttachments:[{path:'fixture.txt'}]};
    let messages = ['a','b','c'].map(id => ({id, text:id + ' original', context, submission:{status:'queued'}}));
    let holds = 0, restores = 0, removals = 0, fail = false, failStorage = false;
    const data = new Map(), calls = [];
    const storage = {
        setItem(k,v) { if(failStorage) throw Error('quota'); data.set(k,v); },
        getItem:k => data.get(k), removeItem:k => data.delete(k),
    };
    const adapter = {threadId:'thread-a', hostId:'local',
        coordinator:async () => ({deferAutomaticTurns(thread) {
            assert.equal(thread, 'thread-a'); holds++; calls.push('hold');
            return {[Symbol.dispose]() { holds--; calls.push('release'); }};
        }}), actions: {
            get:id => messages.find(m=>m.id===id),
            async beginEdit(id) {
                assert.equal(holds > 0, true); removals++; calls.push('remove');
                const index=messages.findIndex(m=>m.id===id);
                if(index<0)return null;
                const receipt={index,message:messages[index],previousMessageId:messages[index-1]?.id??null,nextMessageId:messages[index+1]?.id??null,serverSubmission:{clientUserMessageId:id,serializedText:messages[index].text}};
                messages=messages.filter(m=>m.id!==id); return receipt;
            },
            async restoreEdit(receipt) {
                assert.equal(holds>0,true); restores++; calls.push('restore');
                if(fail)throw Error('native persistence unavailable');
                const index=messages.findIndex(m=>m.id===receipt.nextMessageId);
                messages.splice(index<0?receipt.index:index,0,{...receipt.message,text:receipt.serverSubmission?.serializedText??receipt.message.text});
            },
            async send(message, options) {
                assert.equal(holds>0,true); restores++; calls.push('send');
                if(fail)throw Error('native persistence unavailable');
                assert.equal(options.acceptLocally,true); assert.equal(options.queueModeOverride,'queue');
                const next=messages.findIndex(m=>m.id===options.editPosition.nextMessageId);
                messages.splice(next<0?messages.length:next,0,message);
                return {status:'queued',messageId:message.id};
            },
        }};
    return {adapter,storage,data,calls,context,get messages(){return messages;},get holds(){return holds;},get restores(){return restores;},get removals(){return removals;},set fail(v){fail=v;},set failStorage(v){failStorage=v;}};
}
// Native ref semantics and store return values survive absent DOM APIs and
// inaccessible optional metadata. No adapter work runs at import time.
const bridgeSandbox = {queueMicrotask:fn=>fn(), Map, WeakMap, JSON};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../assets/codex/queued-edit-bridge.js'), 'utf8') +
    ';globalThis.register=scmToolkitRegisterQueueStore;globalThis.ref=scmToolkitQueueRowRef;', bridgeSandbox);
const nativeStore={actions:{get(){},send(){},beginEdit(){},restoreEdit(){}}};
assert.equal(bridgeSandbox.register('thread','local',nativeStore,()=>{}),nativeStore);
assert.equal(bridgeSandbox.register('thread','local',{},()=>{}).constructor,Object);
let nativeRefs=0; const cleanup=()=>{}; const nativeRef=()=>{nativeRefs++;return cleanup;};
const bound=bridgeSandbox.ref(nativeRef,'id','local');
assert.equal(bound,bridgeSandbox.ref(nativeRef,'id','local'),'keeps native ref identity stable');
assert.equal(bound({get dataset(){throw Error('upstream DOM moved');}}),cleanup);
assert.equal(nativeRefs,1);
const nativeObjectRef={current:null};
assert.equal(bridgeSandbox.ref(nativeObjectRef,'id','local'),nativeObjectRef);

(async()=>{
    const f=fixture(), edit=new QueueEdit(f.adapter,'b',f.storage);
    await edit.begin();
    assert.equal(edit.phase,'editing'); assert.equal(f.holds,1);
    assert.deepEqual(f.messages.map(m=>m.id),['a','c']);
    edit.update('b edited\nwith a second line');
    assert.equal(JSON.parse(f.storage.getItem(edit.key)).text,edit.text);
    // Editing itself never dispatches or re-enqueues; save and blur may race.
    const save=edit.finish(), blur=edit.finish(); assert.equal(save,blur);
    await save;
    assert.equal(f.restores,1); assert.equal(f.holds,0);
    assert.deepEqual(f.messages.map(m=>m.id),['a','b','c']);
    assert.equal(f.messages[1].text,'b edited\nwith a second line');
    assert.equal(f.messages[1].context,f.context,'rich context is retained by reference');
    assert.deepEqual(f.calls,['hold','remove','send','release']);
    assert.equal(f.data.size,0);

    const cancel=new QueueEdit(f.adapter,'b',f.storage);
    await cancel.begin(); cancel.update('discard this edit'); await cancel.finish(true);
    assert.equal(f.messages[1].text,'b edited\nwith a second line');
    assert.equal(f.holds,0);

    const g=fixture(), failed=new QueueEdit(g.adapter,'a',g.storage);
    await failed.begin(); failed.update('retained across failure'); g.fail=true;
    assert.equal(await failed.finish(),false); assert.equal(g.holds,1);
    assert.equal(failed.phase,'error'); assert.equal(g.data.size,1);
    assert.deepEqual(g.messages.map(m=>m.id),['b','c']);
    g.fail=false; await failed.finish(); assert.equal(g.holds,0);
    assert.equal(g.messages[0].text,'retained across failure');

    const h=fixture(); h.failStorage=true;
    const blocked=new QueueEdit(h.adapter,'a',h.storage); await blocked.begin();
    assert.equal(blocked.phase,'error'); assert.equal(h.holds,0); assert.equal(h.removals,0);
    assert.deepEqual(h.messages.map(m=>m.id),['a','b','c']);

    const j=fixture(); j.adapter.coordinator=async()=>({});
    const unsupported=new QueueEdit(j.adapter,'a',j.storage); await unsupported.begin();
    assert.equal(unsupported.phase,'error'); assert.equal(j.removals,0);

    const k=fixture(), beforeReload=new QueueEdit(k.adapter,'b',k.storage);
    beforeReload.owner='same-window'; await beforeReload.begin(); beforeReload.update('recover this');
    const record=JSON.parse(k.storage.getItem(beforeReload.key));
    beforeReload.release(); // native RPC lease is disposed when its window retires
    const recovered=new QueueEdit(k.adapter,'b',k.storage);
    await recovered.begin(record); assert.equal(k.removals,1,'recovery does not remove a second native item');
    assert.equal(k.holds,1); await recovered.finish();
    assert.deepEqual(k.messages.map(m=>m.id),['a','b','c']);
    assert.equal(k.messages[1].text,'recover this'); assert.equal(k.holds,0);
    const multi=fixture(), firstWindow=new QueueEdit(multi.adapter,'a',multi.storage);
    firstWindow.owner='first'; await firstWindow.begin(); firstWindow.update('saved before takeover');
    const moved=JSON.parse(multi.storage.getItem(firstWindow.key)); moved.owner='second';
    multi.storage.setItem(firstWindow.key,JSON.stringify(moved));
    assert.equal(await firstWindow.finish(),false);
    assert.equal(multi.restores,0); assert.equal(multi.holds,0);
    assert.equal(firstWindow.moved,true);
    assert.equal(JSON.parse(multi.storage.getItem(firstWindow.key)).owner,'second');

    console.log('PASS: native queue hold, ordering, context, cancel, retry, recovery, and unsupported-API safety');
})().catch(error=>{console.error(error);process.exitCode=1;});
