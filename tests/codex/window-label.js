'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const template = readFileSync(path.join(__dirname, '../../assets/codex/window-label.js'), 'utf8');

function render(label) {
    return template.replace('__SCM_TOOLKIT_CODEX_WINDOW_LABEL__', JSON.stringify(label));
}

function text(value) {
    return { nodeType: 3, nodeValue: value, parentElement: null };
}

function element(parts, top = 40, isMessage = false) {
    const node = {
        nodeType: 1,
        parts,
        top,
        isMessage,
        get textContent() { return this.parts.map(part => part.nodeValue).join(''); },
        getBoundingClientRect() { return { top: this.top }; },
        closest(selector) {
            if (selector.startsWith('article,')) return this.isMessage ? this : null;
            if (selector.startsWith('button,')) return null;
            return this.isHeading === false ? null : this;
        },
        querySelectorAll() { return []; },
        querySelector() { return null; }
    };
    for (const part of parts) part.parentElement = node;
    return node;
}

function exercise(label) {
    const heading = element([text('CelestAI: Codex')]);
    const split = element([text('CelestAI:'), text(' Codex')]);
    const withActions = element([text('CelestAI:'), text(' Codex')]);
    withActions.querySelector = () => ({ tagName: 'BUTTON' });
    const nativeHeader = element([text('Codex')]);
    const message = element([text('CelestAI: Codex')], 100, true);
    const distant = element([text('CelestAI: Codex')], 400);
    const description = element([text('Codex can help')]);
    const plainTitle = element([text('CelestAI: Codex')], 72);
    plainTitle.isHeading = false;
    const all = [heading, split, withActions, nativeHeader, message, distant, description, plainTitle];
    const observerCalls = [];
    let documentScans = 0;
    const document = {
        readyState: 'complete',
        documentElement: {},
        body: { parts: all.flatMap(item => item.parts) },
        querySelectorAll() { documentScans++; return [heading, split, withActions, nativeHeader, message, distant, description]; },
        createTreeWalker(root) {
            const parts = root.parts || [];
            let current = -1;
            return {
                currentNode: null,
                nextNode() {
                    current++;
                    if (current >= parts.length) return false;
                    this.currentNode = parts[current];
                    return this.currentNode;
                }
            };
        }
    };
    class MutationObserver {
        constructor(fn) { this.fn = fn; observerCalls.push(this); }
        observe() {}
        fire(records) { this.fn(records); }
    }
    const globals = {
        document,
        NodeFilter: { SHOW_TEXT: 4 },
        MutationObserver,
        globalThis: {}
    };
    vm.runInNewContext(render(label), globals);
    return { heading, split, withActions, nativeHeader, message, distant, description, plainTitle, observerCalls, documentScans: () => documentScans };
}

const view = exercise('CelestAI');
assert.equal(view.heading.textContent, 'CelestAI');
assert.equal(view.split.textContent, 'CelestAI', 'Split heading nodes should not retain a Codex suffix');
assert.equal(view.withActions.textContent, 'CelestAI', 'Heading controls must not prevent relabeling');
assert.equal(view.nativeHeader.textContent, 'CelestAI');
assert.equal(view.plainTitle.textContent, 'CelestAI', 'Plain div fallback should cover sidebar headers');
assert.equal(view.message.textContent, 'CelestAI: Codex', 'Never alter conversation content');
assert.equal(view.distant.textContent, 'CelestAI: Codex', 'Never change similarly named content below header');
assert.equal(view.description.textContent, 'Codex can help', 'No global Codex text replacement');
assert.equal(view.observerCalls.length, 1);
view.heading.parts[0].nodeValue = 'CelestAI: Codex';
view.observerCalls[0].fire([{type: 'characterData', target: view.heading.parts[0]}]);
assert.equal(view.heading.textContent, 'CelestAI', 'React rerenders should retain the custom label');
assert.equal(view.documentScans(), 1, 'React text updates must not rescan the entire document');
view.message.parts[0].nodeValue = 'Codex';
view.observerCalls[0].fire([{type: 'characterData', target: view.message.parts[0]}]);
assert.equal(view.message.textContent, 'Codex', 'Streaming messages remain excluded');
assert.equal(view.documentScans(), 1, 'Streaming messages must not rescan the entire document');
view.split.parts[0].nodeValue = 'CelestAI:';
view.split.parts[1].nodeValue = ' Codex';
view.observerCalls[0].fire([{type: 'childList', target: view.split, addedNodes: view.split.parts}]);
assert.equal(view.split.textContent, 'CelestAI', 'Split heading node replacements retain the label');
const mounted = element([text('CelestAI: Codex')]);
view.observerCalls[0].fire([{type:'childList',target:{},addedNodes:[mounted]}]);
assert.equal(mounted.textContent, 'CelestAI', 'Remounted headings must be relabeled');
const plainMounted = element([text('CelestAI: Codex')]);
plainMounted.isHeading = false;
view.observerCalls[0].fire([{type:'childList',target:{},addedNodes:[plainMounted]}]);
assert.equal(plainMounted.textContent, 'CelestAI', 'Plain remounted compound titles retain fallback');

const disabled = exercise('Codex');
assert.equal(disabled.heading.textContent, 'CelestAI: Codex', 'Default label must disable override');
assert.equal(disabled.observerCalls.length, 0);

assert(render("Celest AI's").includes('Celest AI\'s'));
console.log('Codex window label checks passed.');
