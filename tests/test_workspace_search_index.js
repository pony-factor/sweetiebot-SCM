'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {normalizeVector} = require('../efs/core');

async function run() {
  let model = 'first:embed', unavailable = false, persisted;
  const calls = [];
  const exampleUri = {toString: () => 'file:///example.txt'};
  const emptyUri = {toString: () => 'file:///notes/empty-notes.md'};
  const outsideCapUri = {toString: () => 'file:///projects/finance/report.md'};
  const rootUri = {toString: () => 'file:///'};
  const vscode = {
    Uri: {
      joinPath: (uri, component) => {
        if (uri === rootUri && component.startsWith('workspace-search-')) return component;
        const url = new URL(uri.toString());
        url.pathname = path.posix.resolve(url.pathname, component);
        return {toString: () => url.toString()};
      },
      parse: text => ({toString: () => text})
    },
    FileType: {File: 1},
    workspace: {
      workspaceFolders: [{uri: rootUri}],
      getWorkspaceFolder: () => ({uri: rootUri}),
      asRelativePath: uri => uri.toString().replace(/^file:\/\/\//, '') || 'workspace',
      findFiles: async (_pattern, _exclude, maxFiles) =>
        maxFiles ? [exampleUri, emptyUri] : [exampleUri, emptyUri, outsideCapUri],
      fs: {readFile: async () => {throw new Error('No cache');}, createDirectory: async () => {},
        writeFile: async (_uri, bytes) => {persisted = JSON.parse(bytes.toString());},
        delete: async () => {}, rename: async () => {}, stat: async () => ({type: 1, size: 20, mtime: 1})}
    }
  };
  const sandbox = {module: {exports: {}}, Buffer, setTimeout, clearTimeout, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './core') return require('../efs/core');
    if (name === './extract') return {extractText: async uri =>
      uri.toString() === emptyUri.toString() ? '' : 'Header.\nA meaningful example passage.\nFooter.'};
    if (name === './ollama') return {embedTexts: async (settings, texts) => {
      calls.push(settings.embeddingModel);
      if (unavailable) throw new Error('Model missing');
      return texts.map(() => normalizeVector(settings.embeddingModel === 'first:embed' ? [1, 0] : [0, 1]));
    }};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../efs/search_index.js'), 'utf8'), sandbox);
  const index = new sandbox.module.exports.SearchIndex({globalStorageUri: rootUri}, () => ({embeddingModel: model, resultLimit: 10, maxFiles: 2, mode: 'semantic'}));
  unavailable = true;
  await index.refresh();
  assert.match(index.embeddingWarning, /Model missing/);
  unavailable = false;
  let result = await index.search('passage', 'semantic');
  assert.equal(result.warning, '');
  assert.equal(result.results.length, 1, 'Installing a model must recover previously unembedded passages');
  assert.equal(result.results[0].line, 1, 'Search results should point at the matching line inside the indexed chunk');
  assert.equal(persisted.embeddingModel, model);
  assert.equal(persisted.version, 2, 'PDF extraction changes must invalidate older cached passages');
  model = 'second:embed';
  calls.length = 0;
  result = await index.search('passage', 'semantic');
  assert.equal(result.results[0].score, 1, 'Changing model must rebuild cached vectors');
  assert.equal(persisted.embeddingModel, model);
  assert.ok(calls.every(name => name === model));
  result = await index.search('empty-notes.md', 'semantic');
  const filenameResult = result.results.find(item =>
    item.kind === 'filename' && item.relative === 'notes/empty-notes.md'
  );
  assert.ok(filenameResult, 'Semantic search should return files whose names match even without extractable text');
  assert.equal(filenameResult.text, 'File name match');
  assert.ok(persisted.files.some(file => file.uri === emptyUri.toString()), 'Empty files should remain in the index for filename search');
  result = await index.search('finance', 'exact');
  const folderResult = result.results.find(item => item.kind === 'folder' && item.relative === 'projects/finance');
  assert.ok(folderResult, 'Folder names should be searchable even beyond the content-index file cap');
  assert.equal(result.results[0].relative, 'projects/finance', 'Direct folder-name matches should outrank incidental path matches');
  assert.equal(folderResult.text, 'Folder name match');
  assert.equal(folderResult.line, 0);
  assert.ok(!persisted.files.some(file => file.uri === outsideCapUri.toString()), 'Folder search must not require content indexing');
  result = await index.search('projects finance', 'hybrid');
  assert.ok(result.results.some(item => item.kind === 'folder' && item.relative === 'projects/finance'),
    'Folder paths should be searchable as well as folder basenames');
  console.log('Workspace model recovery, filename search, folder search, and index checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
