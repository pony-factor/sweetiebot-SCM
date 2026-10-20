'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../efs/draft_confirmation.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
class Element {
  constructor(tag){this.tag=tag;this.children=[];this._text='';this.listeners={};this.open=false;this.hidden=false;this.style={};}
  get textContent(){return this._text+this.children.map(node=>String(node.textContent??'')).join('');}
  set textContent(value){this._text=String(value);this.children=[];}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=nodes;}
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
const pendingImages=[];
const document={getElementById,createElement:tag=>{const item=new Element(tag);if(tag==='img')pendingImages.push(item);return item;},createTextNode:text=>({textContent:text}),activeElement:focused};
const images=getElementById('images');
const mockWindow={innerWidth:960,innerHeight:1920,listeners:{},addEventListener(name,listener){this.listeners[name]=listener;}};
const context=vm.createContext({URL,URLSearchParams,location:{pathname:'/kefania-draft/test',hash:''},history:{replaceState(){}},document,window:mockWindow});
vm.runInContext(script.slice(0,script.lastIndexOf('(async()=>')),context);
// Theme colors update in place, and disabling the option removes stale tokens.
const themeProperties=new Map();
document.documentElement={
  toggleAttribute(name,value){this[name]=value;},
  style:{setProperty:(key,value)=>themeProperties.set(key,value),removeProperty:key=>themeProperties.delete(key)}
};
context.CSS={supports:(kind,value)=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)};
context.applyAppearance({bg:'#101010',text:'#eeeeee',button:'#00aa55',controlText:'#55dd88'});
assert.equal(document.documentElement['data-theme-colors'],true);
assert.equal(themeProperties.get('--kefania-controlText'),'#55dd88');
context.applyAppearance({bg:'#ffffff',text:'#111111'});
assert.equal(themeProperties.get('--kefania-bg'),'#ffffff','Changing themes updates the page');
assert.equal(themeProperties.has('--kefania-button'),false,'Missing theme colors cannot retain stale values');
context.applyAppearance(null);
assert.equal(document.documentElement['data-theme-colors'],false);
assert.equal(themeProperties.size,0);
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
// Image credits commonly use italics and sometimes include a space before a link URL.
context.renderMarkdown(output,'*Image: Friendship Is Magic episode still (Hasbro/Studio B), preserved by [Twibooru] (https://www.twibooru.org/3559729); not independently created fan art.*');
const credit=output.children[0].children.find(node=>node.tag==='em');
assert(credit,'The attribution stays italic');
const creditLink=credit.children.find(node=>node.tag==='a');
assert(creditLink,'The source link inside italics is clickable');
assert.equal(creditLink.textContent,'Twibooru');
assert.equal(creditLink.href,'https://www.twibooru.org/3559729');
assert.equal(creditLink.target,'_blank');
assert.equal(creditLink.rel,'noopener noreferrer');
context.renderMarkdown(output,'*Source: [Twibooru](https://www.twibooru.org/3559729)* and **[More](https://example.com/more)**');
const highlighted=output.children[0].children;
assert(highlighted.find(node=>node.tag==='em').children.some(node=>node.tag==='a'),'Standard links work inside italics');
assert(highlighted.find(node=>node.tag==='strong').children.some(node=>node.tag==='a'),'Links work inside bold text');
context.renderMarkdown(output,'*Unsafe [script](javascript:alert(1)) remains plain text; `[literal](https://example.com)` is code.*');
const unsafe=output.children[0].children.find(node=>node.tag==='em').children;
assert(!unsafe.some(node=>node.tag==='a'),'Unsafe links are not activated');
assert.equal(unsafe.find(node=>node.tag==='code').textContent,'[literal](https://example.com)');
const remainder=context.imageIndex('Profile\n![Pony credit](https://example.com/image.png)\n![Duplicate](https://example.com/image.png)');
assert(!remainder.includes('!['));
assert.equal(images.children.length,0,'Image cards are not shown before loading');
const img=pendingImages.at(-1);
img.naturalWidth=300;
img.naturalHeight=250;
img.onload();
assert.equal(images.children.length,1,'A successfully loaded thumbnail becomes visible');
const figure=images.children[0],trigger=figure.children[0],stage=trigger.children[0];
assert.equal(stage.children[0],img);
assert.equal(trigger.tag,'button');
assert.equal(trigger.type,'button');
assert.equal(img.referrerPolicy,'no-referrer');
assert.equal(img.src,'https://example.com/image.png');
assert.equal(figure.children[1].textContent,'Pony credit');
trigger.fire('click');
const lightbox=getElementById('image-lightbox');
assert.equal(lightbox.open,true,'Thumbnails open a modal instead of a new tab');
assert(Number.parseInt(lightbox.style.height,10)<mockWindow.innerHeight*0.7,'An image does not inherit a nearly full-viewport column of empty space');
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
assert.equal(images.children.length,0,'Failed thumbnails disappear entirely, including their attribution-only cards');
const artStart=pendingImages.length;
context.imageIndex('[![Art credit](https://example.com/art.png)](https://example.com/posts/42)');
assert.equal(images.children.length,0);
const artImage=pendingImages[artStart];
artImage.naturalWidth=250;
artImage.onload();
images.children[0].children[0].fire('click');
assert.equal(getElementById('lightbox-image').src,'https://example.com/art.png','The image still uses its direct asset');
assert.equal(getElementById('lightbox-source').href,'https://example.com/posts/42','The source opens the contextual artwork page');
lightbox.close();
assert.equal(context.imageSourcePage('https://derpicdn.net/img/download/2022/9/26/2954957__safe.png'),'https://derpibooru.org/images/2954957');
assert.equal(context.imageSourcePage('https://static.manebooru.art/img/2021/12/25/4017785/large.png'),'https://manebooru.art/images/4017785');
assert.equal(context.imageSourcePage('https://example.com/img/2021/12/25/4017785/large.png'),'https://example.com/img/2021/12/25/4017785/large.png','Unknown hosts are not guessed');
const orderingStart=pendingImages.length;
context.imageIndex('![First](https://example.com/first.png)\n![Second](https://example.com/second.png)\n![Duplicate](https://example.com/first.png)');
assert.equal(images.children.length,0,'Unverified image URLs never reserve empty card slots');
const firstImage=pendingImages[orderingStart],secondImage=pendingImages[orderingStart+1];
secondImage.naturalWidth=320;
secondImage.naturalHeight=160;
secondImage.onload();
assert.equal(images.children.length,1);
assert.equal(images.children[0].children[1].textContent,'Second','Only loaded artwork participates in the gallery');
images.children[0].children[0].fire('click');
assert.equal(getElementById('lightbox-next').hidden,true,'Navigation excludes unloaded artwork');
firstImage.naturalWidth=320;
firstImage.naturalHeight=640;
firstImage.onload();
assert.equal(images.children.length,2,'Late images appear in source order');
assert.equal(images.children[0].children[1].textContent,'First');
assert.equal(images.children[1].children[1].textContent,'Second');
assert.equal(getElementById('lightbox-caption').textContent,'Second · 2 of 2','Loading a preceding image preserves the displayed artwork');
assert.equal(getElementById('lightbox-prev').hidden,false);
const galleryHeight=lightbox.style.height;
getElementById('lightbox-next').fire('click');
assert.equal(lightbox.style.height,galleryHeight,'The viewer never changes height on previous/next navigation');
mockWindow.innerHeight=1100;
mockWindow.listeners.resize();
assert(Number.parseInt(lightbox.style.height,10)<=mockWindow.innerHeight*0.95,'Resizing keeps the viewer within the viewport');
assert.equal(getElementById('lightbox-image').src,'https://example.com/first.png');
lightbox.fire('keydown',{key:'ArrowRight'});
assert.equal(getElementById('lightbox-image').src,'https://example.com/second.png','Next wraps');
lightbox.fire('keydown',{key:'ArrowLeft'});
assert.equal(getElementById('lightbox-image').src,'https://example.com/first.png','Previous wraps');
lightbox.fire('click',{clientX:400,clientY:400});
assert.equal(lightbox.open,true,'Interior clicks do not dismiss');
lightbox.fire('click',{clientX:40,clientY:40});
assert.equal(lightbox.open,false,'Backdrop click closes');
const blockedStart=pendingImages.length;
context.imageIndex('[![Blocked Smolder](https://buffy.mlpforums.com/unavailable.png)](https://mlpforums.com/topic/203315-vectors-of-smolder-and-yona/)\n![Working](https://example.com/working.png)');
pendingImages[blockedStart].onerror();
assert.equal(images.children.length,0,'An inaccessible image does not produce a source-only card');
pendingImages[blockedStart+1].naturalWidth=420;
pendingImages[blockedStart+1].onload();
assert.equal(images.children.length,1);
assert.equal(images.children[0].children[1].textContent,'Working');
const staleStart=pendingImages.length;
context.imageIndex('![Old result](https://example.com/old.png)');
const stale=pendingImages[staleStart];
context.imageIndex('![New result](https://example.com/new.png)');
stale.naturalWidth=400;
stale.onload();
assert.equal(images.children.length,0,'Late events from previous research cannot populate new galleries');
pendingImages[staleStart+1].naturalWidth=400;
pendingImages[staleStart+1].onload();
assert.equal(images.children.length,1);
assert.equal(images.children[0].children[1].textContent,'New result');
assert.match(html, /id="close-confirmation"[^>]*hidden/, 'Close action initially hidden');
assert.match(html, /const closeVisible=!!state\.result&&state\.showKefaniaCloseButton!==false/, 'Close is optional after publication');
assert.match(html, /root\+'\/close'/, 'Close action uses local handoff');
assert.match(html, /grid-template-columns:minmax\(0,2fr\) minmax\(0,3fr\)/, 'Pony takes 60% of wide confirmation layout');
assert.match(html, /\.close-confirmation\{[^}]*position:fixed;top:16px;left:16px;right:auto[^}]*width:36px;height:36px[^}]*color:#fff/, 'Close action defaults to a left-aligned white X');
assert.match(html, /\.close-confirmation\.on-right\{left:auto;right:16px\}/, 'Window-right option remains fixed');
assert.match(html, /\.pony-column\{display:flex;flex-direction:column;min-width:0\}/, 'Pony content owns the right-hand column');
assert.match(html, /<div class="pony-column"><button id="close-confirmation"[^>]+>×<\/button><section id="pony-section"/, 'Middle X precedes the pony card in the same column');
assert.match(html, /\.close-button-middle \.close-confirmation\{position:static;[^}]*align-self:flex-end;[^}]*margin:0 0 10px\}/, 'Middle X is right-aligned above pony content without overlapping');
assert.match(html, /for\(const position of \['left','middle','right'\]\)document\.querySelector\('main'\)\.classList\.toggle/, 'All three placements update on the live state poll');
assert.match(html, /\.close-button-left header\{padding-left:44px\}/, 'Only visible left X reserves header space');
assert.match(html, /\.lightbox\[open\]\{display:grid;grid-template-rows:minmax\(0,1fr\) auto\}/, 'Lightbox has only image and footer rows');
assert.doesNotMatch(html, /class="lightbox-toolbar"/, 'No empty top banner');
assert.match(html, /\.lightbox-nav\{[^}]*position:absolute;top:50%[^}]*height:min\(75%,560px\)/, 'Arrows resize with the compact image stage instead of spanning empty space');
assert.match(html, /function fitLightboxToGallery\(\)/, 'Artwork dimensions determine a common height across the carousel');
assert.match(html, /source\.height=img\.naturalHeight/, 'Natural image dimensions are retained for fitting');
assert.match(html, /\.lightbox-stage img\{[^}]*width:0;height:100%[^}]*object-fit:contain/, 'All images use one contained stage size');
assert.doesNotMatch(html, /PR drafting and pony research finish independently\./, 'Redundant footer is removed');
assert.match(html, /Pull request published\. Review the details and supporting character research\./, 'Published subtitle uses professional status copy');
assert.match(html, /const confirmationToken =/, 'Unique tab token lets VS Code close the moved confirmation safely');
console.log('Confirmation Markdown, lightbox, image fallback, and close action checks passed.');

(async()=>{
  let merges=0, prompts=0;
  let state={result:{number:2,base:'main'}};
  context.fetch=async (url, options)=>{
    if(options?.method==='POST'){merges++;return {ok:true,json:async()=>({merged:true})};}
    return {ok:true,json:async()=>state};
  };
  context.refresh=async()=>{};
  context.confirm=()=>{prompts++;return false;};
  await getElementById('merge').onclick();
  assert.equal(prompts,1,'Default mode asks before merging');
  assert.equal(merges,0,'Cancelling confirmation cannot merge');
  state.ludicrousMode=true;
  context.confirm=()=>{throw new Error('Ludicrous mode must skip confirmation');};
  await getElementById('merge').onclick();
  assert.equal(merges,1,'Ludicrous mode merges on the explicit button click');
  state.merging=true;
  await getElementById('merge').onclick();
  assert.equal(merges,1,'A merge already in progress stays guarded');
  state={ludicrousMode:true};
  await getElementById('merge').onclick();
  assert.equal(merges,1,'Ludicrous mode cannot merge an unpublished PR');
  state={result:{number:2},ludicrousMode:false};
  context.confirm=()=>{prompts++;return true;};
  await getElementById('merge').onclick();
  assert.equal(prompts,2,'Turning the setting off restores confirmation');
  assert.equal(merges,2);
  console.log('Ludicrous mode confirmation checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
