const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
    constructor(text, tagName = 'DIV') {
        this.tagName = tagName;
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
    getAttribute(name) { return this.attributes.get(name) ?? null; }
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
const activity = new FakeElement('Worked for 1m 48s', 'BUTTON');
activity.attributes.set('aria-label', 'Worked for 1m 48s');
const activityText = { nodeType: 3, textContent: activity.textContent, parentElement: activity };
activity.childTextNodes = [activityText];
const thought = new FakeElement('Thought for 58s', 'DIV');
thought.attributes.set('role', 'button');
const thoughtText = { nodeType: 3, textContent: thought.textContent, parentElement: thought };
thought.childTextNodes = [thoughtText];
const split = new FakeElement('Worked for 4m 33s', 'BUTTON');
const splitLabel = { nodeType: 3, textContent: 'Worked for ', parentElement: split };
const splitTime = { nodeType: 3, textContent: '4m 33s', parentElement: split };
split.childTextNodes = [splitLabel, splitTime];
const ordinaryActivity = new FakeElement('Worked for 1m 48s');
const ordinaryActivityText = { nodeType: 3, textContent: ordinaryActivity.textContent, parentElement: ordinaryActivity };
const otherButton = new FakeElement('Worked for all of Monday', 'BUTTON');
const otherButtonText = { nodeType: 3, textContent: otherButton.textContent, parentElement: otherButton };
otherButton.childTextNodes = [otherButtonText];
const nodes = [timestampText, ordinaryText, activityText, thoughtText, splitLabel, splitTime, ordinaryActivityText, otherButtonText];

const document = {
    readyState: 'complete',
    documentElement: new FakeElement(''),
    body: new FakeElement(''),
    createTreeWalker(root) {
        const candidates = root === document ? nodes : (root.childTextNodes || []);
        let index = 0;
        return {
            currentNode: null,
            nextNode() {
                if (index >= candidates.length) return false;
                this.currentNode = candidates[index++];
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

assert.equal(activityText.textContent, 'Activity', 'elapsed work time is replaced');
assert.equal(activity.getAttribute('aria-label'), 'Activity', 'accessible labels omit elapsed time');
assert.equal(activity.attributes.has('aria-hidden'), false, 'activity toggle stays accessible');
assert.equal(activity.style.values.has('display'), false, 'activity toggle stays visible');
assert.equal(thoughtText.textContent, 'Activity', 'thought durations are recognized');
assert.equal(splitLabel.textContent, 'Activity', 'split duration labels are handled');
assert.equal(splitTime.textContent, '', 'split time text is removed');
assert.equal(ordinaryActivityText.textContent, 'Worked for 1m 48s', 'message text stays intact');
assert.equal(otherButtonText.textContent, 'Worked for all of Monday', 'unrelated buttons stay intact');

console.log('Codex timestamp and elapsed-time hiding checks passed.');
