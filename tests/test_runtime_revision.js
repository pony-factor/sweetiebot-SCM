'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runtimeRevision } = require('../efs/runtime_revision');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-runtime-'));
try {
  const appRoot = path.join(root, 'app');
  const extensionPath = path.join(root, 'extensions', 'sweetiebot');
  const workbench = path.join(appRoot, 'out/vs/workbench');
  fs.mkdirSync(workbench, { recursive: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'extension.js'), 'old code');
  const vscode = { env: { appRoot }, extensions: { getExtension() {} } };
  const context = { extensionPath };
  const original = runtimeRevision(vscode, context);
  assert.equal(runtimeRevision(vscode, context), original, 'unchanged repairs keep the same revision');
  fs.writeFileSync(path.join(extensionPath, 'extension.js'), 'new code');
  const updated = runtimeRevision(vscode, context);
  assert.notEqual(updated, original);
  assert.equal(runtimeRevision(vscode, context), updated, 'another repository window sees the same installed revision');
  const legacy = path.join(root, 'extensions', 'jfwooten4.scm-toolkit-workspace-search-0.3.2');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'package.json'), '{}');
  const duplicate = runtimeRevision(vscode, context);
  fs.rmSync(legacy, { recursive: true });
  assert.notEqual(runtimeRevision(vscode, context), duplicate, 'legacy cleanup requires a reload');
} finally {
  fs.rmSync(root, { recursive: true });
}
console.log('Installed runtime revision checks passed.');
