const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
    constructor(text) {
        this.nodeType = 1;
        this.textContent = text;
        this.parentElement = null;
        this.attributes = new Map();
        this.style = {
            values: new Map(),
            setProperty(name, value, priority) {
                this.values.set(name, { value, priority });
            },
        };
    }

    querySelector() { return null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
}

const timestamp = new FakeElement('Monday 10:22 PM');
const timestampText = {
    nodeType: 3,
    textContent: timestamp.textContent,
    parentElement: timestamp,
};
const ordinary = new FakeElement('Monday planning');
const ordinaryText = {
    nodeType: 3,
    textContent: ordinary.textContent,
    parentElement: ordinary,
};
const nodes = [timestampText, ordinaryText];

const document = {
    readyState: 'complete',
    documentElement: new FakeElement(''),
    body: new FakeElement(''),
    createTreeWalker() {
        let index = 0;
        return {
            currentNode: null,
            nextNode() {
                if (index >= nodes.length) return false;
                this.currentNode = nodes[index++];
                return true;
            },
        };
    },
};

const context = vm.createContext({
    document,
    Element: FakeElement,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: {
        SHOW_TEXT: 4,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
    },
    MutationObserver: class {
        observe() {}
    },
});
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../assets/codex/codex-hide-chat-timestamps.js'), 'utf8'),
    context,
);

assert.equal(timestamp.attributes.get('aria-hidden'), 'true');
assert.deepEqual(timestamp.style.values.get('display'), { value: 'none', priority: 'important' });
assert.equal(ordinary.attributes.has('aria-hidden'), false, 'non-timestamp weekday text remains visible');

console.log('Codex weekday timestamp hiding checks passed.');
