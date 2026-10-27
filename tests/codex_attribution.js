'use strict';
const assert = require('node:assert/strict');
const {isCodex,mergeNames,modelQualifier,withModel,collapse} = require('../extension/codex/attribution');
const email = '<noreply@openai.com>';
assert(isCodex('Codex Web','noreply@openai.com'));
assert(!isCodex('Codex Web','other@example.org'));
assert.equal(modelQualifier({name:'GPT-6.1 Codex',effort:'Medium'}),'6.1 Med');
assert.equal(modelQualifier({name:'GPT-6.1 Codex',effort:'Extra High'}),'6.1 XHigh');
assert.equal(modelQualifier({name:'unknown',effort:'Medium'}),'');
assert.equal(mergeNames('Codex','Codex Web'),'Codex (Web)');
assert.equal(mergeNames('Codex (6.1 Med)','Codex Web'),'Codex (6.1 Med, Web)');
assert.equal(mergeNames('Codex (Web)','Codex (6.1 Med, Web)'),'Codex (6.1 Med, Web)');
assert.equal(withModel('Codex',{name:'GPT-6.1 Codex',effort:'Med'}),'Codex (6.1 Med)');
assert.equal(collapse('Change','Co-authored-by: Codex '+email),
  'Change\n\nCo-authored-by: Codex '+email);
assert.equal(collapse('Change\n\nCo-authored-by: Codex Web '+email,
  'Co-authored-by: Codex (6.1 Med) '+email),
  'Change\n\nCo-authored-by: Codex (6.1 Med, Web) '+email);
assert.equal(collapse('Change\n\nCo-authored-by: Codex '+email+
  '\nCo-authored-by: Codex Web '+email,'Co-authored-by: Codex (6.1 Med) '+email),
  'Change\n\nCo-authored-by: Codex (6.1 Med, Web) '+email);
assert.equal(collapse('Change\n\nCo-authored-by: Human <human@example.org>\n'+
  'Co-authored-by: Codex Web '+email,'Co-authored-by: Codex '+email),
  'Change\n\nCo-authored-by: Human <human@example.org>\n\nCo-authored-by: Codex (Web) '+email);
assert.equal(collapse(' ','Co-authored-by: Codex '+email),'');
console.log('Codex model attribution checks passed');

