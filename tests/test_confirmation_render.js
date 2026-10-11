'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../efs/draft_confirmation.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
}
const images=new Element('div');
const context=vm.createContext({URL,URLSearchParams,location:{pathname:'/kefania-draft/test',hash:''},history:{replaceState(){}},document:{getElementById(){return images},createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})}});
vm.runInContext(script.slice(0,script.lastIndexOf('(async()=>')),context);
assert.equal(context.safeLink('javascript:alert(1)'),null);
assert.equal(context.safeLink('https://user:password@example.com'),null);
const output=new Element('div');
context.renderMarkdown(output,'## Profile\n\nA **recognizable** pony with <script>alert(1)</script>.\n\n- [Source](https://example.com/pony)');
assert.equal(output.children[0].tag,'h3');
assert.equal(output.children[1].children[1].tag,'strong');
assert(output.children[1].children.some(node=>node.textContent.includes('<script>')),'Raw HTML remains inert text');
const remainder=context.imageIndex('Profile\n![Pony credit](https://example.com/image.png)\n![Duplicate](https://example.com/image.png)');
assert(!remainder.includes('!['));
assert.equal(images.children.length,1);
const source=images.children[0].children[0],stage=source.children[0],img=stage.children[0];
assert.equal(img.referrerPolicy,'no-referrer');
assert.equal(source.href,'https://example.com/image.png');
img.onerror();
assert.equal(stage.children[0].textContent,'View image at its source ↗');
assert.equal(source.children[1].textContent,'Pony credit');
console.log('Confirmation Markdown and image fallback checks passed.');
