'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {normalizeVector} = require('../efs/core');

async function run() {
  let model = 'first:embed', unavailable = false, persisted;
  const calls = [];
  const uri = {toString: () => 'file:///example.txt'};
  const vscode = {
    Uri: {joinPath: (_root, file) => file, parse: text => ({toString: () => text})},
    FileType: {File: 1},
    workspace: {
      workspaceFolders: [], asRelativePath: () => 'example.txt', findFiles: async () => [uri],
      fs: {readFile: async () => {throw new Error('No cache');}, createDirectory: async () => {},
        writeFile: async (_uri, bytes) => {persisted = JSON.parse(bytes.toString());},
        delete: async () => {}, rename: async () => {}, stat: async () => ({type: 1, size: 20, mtime: 1})}
    }
  };
  const sandbox = {module: {exports: {}}, Buffer, setTimeout, clearTimeout, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './core') return require('../efs/core');
    if (name === './extract') return {extractText: async () => 'A meaningful example passage.'};
    if (name === './ollama') return {embedTexts: async (settings, texts) => {
      calls.push(settings.embeddingModel);
      if (unavailable) throw new Error('Model missing');
      return texts.map(() => normalizeVector(settings.embeddingModel === 'first:embed' ? [1, 0] : [0, 1]));
    }};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../efs/search_index.js'), 'utf8'), sandbox);
  const index = new sandbox.module.exports.SearchIndex({globalStorageUri: {}}, () => ({embeddingModel: model, resultLimit: 10, mode: 'semantic'}));
  unavailable = true;
  await index.refresh();
  assert.match(index.embeddingWarning, /Model missing/);
  unavailable = false;
  let result = await index.search('example', 'semantic');
  assert.equal(result.warning, '');
  assert.equal(result.results.length, 1, 'Installing a model must recover previously unembedded passages');
  assert.equal(persisted.embeddingModel, model);
  model = 'second:embed';
  calls.length = 0;
  result = await index.search('example', 'semantic');
  assert.equal(result.results[0].score, 1, 'Changing model must rebuild cached vectors');
  assert.equal(persisted.embeddingModel, model);
  assert.ok(calls.every(name => name === model));
  console.log('Workspace model recovery and index checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
