const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let nodes = ['GPT-6.1', 'Medium', 'Light', 'Extra high', 'High'].map(nodeValue => ({ nodeValue }));
let update;
let observers = 0;
const context = vm.createContext({
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
        readyState: 'complete', documentElement: {},
        querySelectorAll(selector) {
            assert.match(selector, /data-composer-navigation-target="reasoning"/);
            assert.ok(!selector.includes('menuitem'), 'model menu stays unchanged');
            return [{}];
        },
        createTreeWalker() {
            let index = 0;
            return { nextNode: () => nodes[index++] };
        },
    },
    MutationObserver: class {
        constructor(callback) { update = callback; observers++; }
        observe(root, options) { assert.equal(options.characterData, true); }
    },
});
const source = fs.readFileSync('assets/codex/codex-short-model-labels.js', 'utf8');
vm.runInContext(source, context);
assert.deepEqual(nodes.map(node => node.nodeValue), ['6.1', 'Med', 'Low', 'Uber', 'High']);
nodes = [{ nodeValue: 'GPT-6 Extra High' }];
update();
assert.equal(nodes[0].nodeValue, '6 Uber', 'model changes update the display');
update();
assert.equal(nodes[0].nodeValue, '6 Uber', 'observer settles after its own changes');
vm.runInContext(source, context);
assert.equal(observers, 1, 'split bundles share one observer');
console.log('Short model label rendering checks passed.');
