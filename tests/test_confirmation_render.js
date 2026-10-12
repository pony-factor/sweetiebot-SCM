'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../efs/draft_confirmation.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.listeners={};this.open=false;this.hidden=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(name,value){this[name]=value;}
  addEventListener(name,listener){(this.listeners[name]??=[]).push(listener);}
  fire(name,other={}){const event={target:this,type:name,preventDefault(){this.defaultPrevented=true;},...other};for(const listener of this.listeners[name]||[])listener(event);return event;}
  showModal(){this.open=true;}
  close(){this.open=false;this.fire('close');}
  focus(){this.focused=true;}
  getBoundingClientRect(){return {left:100,top:100,right:900,bottom:700};}
}
const elements=new Map(),focused=new Element('button');
const getElementById=id=>{if(!elements.has(id))elements.set(id,new Element(id==='image-lightbox'?'dialog':'div'));return elements.get(id);};
const document={getElementById,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),activeElement:focused};
const images=getElementById('images');
const context=vm.createContext({URL,URLSearchParams,location:{pathname:'/kefania-draft/test',hash:''},history:{replaceState(){}},document});
vm.runInContext(script.slice(0,script.lastIndexOf('(async()=>')),context);
assert.equal(context.safeLink('javascript:alert(1)'),null);
assert.equal(context.safeLink('https://user:password@example.com'),null);
const output=new Element('div');
context.renderMarkdown(output,'## Profile\n\nA **recognizable** pony with <script>alert(1)</script>.\n\n- [Source](https://example.com/pony)');
assert.equal(output.children[0].tag,'h3');
assert.equal(output.children[1].children[1].tag,'strong');
assert(output.children[1].children.some(node=>node.textContent.includes('<script>')),'Raw HTML remains inert text');
context.renderMarkdown(output,'Maud in *Friendship Is Magic*, _Rock Solid Friendship_, **adult mare**, and `*literal*`.');
const inlineNodes=output.children[0].children;
assert.deepEqual(inlineNodes.filter(node=>node.tag==='em').map(node=>node.textContent),['Friendship Is Magic','Rock Solid Friendship']);
assert.equal(inlineNodes.find(node=>node.tag==='strong').textContent,'adult mare');
assert.equal(inlineNodes.find(node=>node.tag==='code').textContent,'*literal*');
context.renderMarkdown(output,'ordinary_name_part and https://example.com/rock_solid_friendship');
assert(!output.children[0].children.some(node=>node.tag==='em'),'Underscores in words and URLs remain literal');
const remainder=context.imageIndex('Profile\n![Pony credit](https://example.com/image.png)\n![Duplicate](https://example.com/image.png)');
assert(!remainder.includes('!['));
assert.equal(images.children.length,1);
const figure=images.children[0],trigger=figure.children[0],stage=trigger.children[0],img=stage.children[0];
assert.equal(trigger.tag,'button');
assert.equal(trigger.type,'button');
assert.equal(img.referrerPolicy,'no-referrer');
assert.equal(img.src,'https://example.com/image.png');
assert.equal(figure.children[1].textContent,'Pony credit');
trigger.fire('click');
const lightbox=getElementById('image-lightbox');
assert.equal(lightbox.open,true,'Thumbnails open a modal instead of a new tab');
assert.equal(getElementById('lightbox-image').src,'https://example.com/image.png');
assert.equal(getElementById('lightbox-source').href,'https://example.com/image.png');
assert.equal(getElementById('lightbox-caption').textContent,'Pony credit · 1 of 1');
assert.equal(getElementById('lightbox-prev').hidden,true);
assert.equal(getElementById('lightbox-next').hidden,true);
getElementById('lightbox-image').fire('error');
assert.equal(getElementById('lightbox-error').hidden,false,'Failed full images offer a source fallback');
getElementById('lightbox-close').fire('click');
assert.equal(lightbox.open,false,'Close button dismisses modal');
assert.equal(focused.focused,true,'Focus returns to thumbnail');
img.onerror();
assert.equal(figure.children[0].href,'https://example.com/image.png','Failed thumbnails link to their source');
assert.equal(figure.children[0].rel,'noopener noreferrer');
assert.equal(figure.children[0].textContent,'View image at its source ↗');
context.imageIndex('![First](https://example.com/first.png)\n![Second](https://example.com/second.png)\n![Duplicate](https://example.com/first.png)');
assert.equal(images.children.length,2,'Deduplicate image sources');
images.children[0].children[0].fire('click');
assert.equal(getElementById('lightbox-prev').hidden,false);
getElementById('lightbox-next').fire('click');
assert.equal(getElementById('lightbox-image').src,'https://example.com/second.png');
lightbox.fire('keydown',{key:'ArrowRight'});
assert.equal(getElementById('lightbox-image').src,'https://example.com/first.png','Next wraps');
lightbox.fire('keydown',{key:'ArrowLeft'});
assert.equal(getElementById('lightbox-image').src,'https://example.com/second.png','Previous wraps');
lightbox.fire('click',{clientX:400,clientY:400});
assert.equal(lightbox.open,true,'Interior clicks do not dismiss');
lightbox.fire('click',{clientX:40,clientY:40});
assert.equal(lightbox.open,false,'Backdrop click closes');
assert.match(html, /id="close-confirmation"[^>]*hidden/, 'Close action initially hidden');
assert.match(html, /el\('close-confirmation'\)\.hidden=!state\.result/, 'Close appears after publication');
assert.match(html, /root\+'\/close'/, 'Close action uses local handoff');
console.log('Confirmation Markdown, lightbox, image fallback, and close action checks passed.');
