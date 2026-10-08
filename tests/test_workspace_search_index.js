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
  const overlookedUri = {toString: () => 'file:///drafts/apa-nondeference.md'};
  const outsideCapUri = {toString: () => 'file:///projects/finance/report.md'};
  const rootUri = {toString: () => 'file:///'};
  let filenameScans = 0;
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
      findFiles: async (_glob, _exclude, maxFiles) => {
        if (maxFiles) return [exampleUri, emptyUri];
        filenameScans += 1;
        return [exampleUri, emptyUri, overlookedUri, outsideCapUri];
      },
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
  assert.ok(!persisted.files.some(file => file.uri === overlookedUri.toString()), 'The fixture must be outside the capped content index');
  result = await index.search('apa nondeference', 'hybrid');
  assert.equal(result.results[0].relative, 'drafts/apa-nondeference.md', 'Hyphenated exact titles must rank first');
  assert.equal(result.results[0].kind, 'filename');
  assert.equal(result.results[0].score, 2, 'Direct filename matches must beat passage scores');
  result = await index.search('APA-NONDEFERENCE.MD', 'exact');
  assert.equal(result.results[0].relative, 'drafts/apa-nondeference.md', 'Full filenames must match without case sensitivity');
  result = await index.search('nondeference', 'semantic');
  assert.ok(result.results.some(item => item.relative === 'drafts/apa-nondeference.md' && item.kind === 'filename'), 'Semantic mode must discover names of unindexed files');
  result = await index.search('finance', 'exact');
  const folderResult = result.results.find(item => item.kind === 'folder' && item.relative === 'projects/finance');
  assert.ok(folderResult, 'Folder names should be searchable beyond the content-index file cap');
  assert.equal(result.results[0].relative, 'projects/finance', 'Exact folder-name matches should lead');
  assert.equal(folderResult.text, 'Folder name match');
  assert.equal(folderResult.line, 0);
  assert.ok(!persisted.files.some(file => file.uri === outsideCapUri.toString()), 'Folder lookup must not require content indexing');
  result = await index.search('projects finance', 'hybrid');
  assert.ok(result.results.some(item => item.kind === 'folder' && item.relative === 'projects/finance'), 'Folder paths should be searchable');
  assert.equal(filenameScans, 2, 'Repeated queries should reuse independent filename and folder listings');

  // Suppress redundant path matches only when the same file has matching passages.
  // Keep standalone file-path matches and filename matches visible.
  const originalRelativePath = vscode.workspace.asRelativePath;
  vscode.workspace.asRelativePath = uri => {
    if (uri.toString() === exampleUri.toString()) return 'passage/example.txt';
    if (uri.toString() === emptyUri.toString()) return 'references/empty-notes.md';
    return originalRelativePath(uri);
  };
  result = await index.search('passage', 'exact');
  const passageResults = result.results.filter(item => item.uri === exampleUri.toString());
  assert.ok(passageResults.some(item => !item.kind), 'Matching passages remain visible');
  assert.ok(!passageResults.some(item => item.text === 'Path match'), 'Do not list a path hit beside passages from the same file');
  result = await index.search('references', 'exact');
  const pathOnly = result.results.find(item => item.uri === emptyUri.toString());
  assert.ok(pathOnly, 'A file without matching passages must still be found by its path');
  assert.equal(pathOnly.text, 'Path match');
  result = await index.search('example', 'exact');
  assert.ok(result.results.some(item => item.uri === exampleUri.toString() && item.text === 'File name match'),
    'File-name hits remain independent of passage hits');
  vscode.workspace.asRelativePath = originalRelativePath;

  console.log('Workspace model recovery, uncapped filenames, exact-name priority, folder search, and index checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
