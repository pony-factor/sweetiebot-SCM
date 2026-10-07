'use strict';

const assert = require('node:assert/strict');
const {
  resolvePythonExecutable,
  pythonLaunchError
} = require('../efs/python_runtime');

assert.equal(
  resolvePythonExecutable('darwin', { SWEETIEBOT_PYTHON: '/custom/python3', PATH: '' }, () => false),
  '/custom/python3'
);
assert.equal(
  resolvePythonExecutable('darwin', { PATH: '' }, candidate => candidate === '/usr/bin/python3'),
  '/usr/bin/python3'
);
assert.equal(
  resolvePythonExecutable('darwin', { PATH: '/custom/bin' }, candidate => candidate === '/custom/bin/python3'),
  '/custom/bin/python3'
);
assert.equal(
  resolvePythonExecutable('darwin', { PATH: '' }, () => false),
  'python3'
);

const enoent = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
const friendly = pythonLaunchError(enoent);
assert.equal(friendly.code, 'PYTHON_NOT_FOUND');
assert.match(friendly.message, /SWEETIEBOT_PYTHON/);
assert.equal(pythonLaunchError(new Error('other')).message, 'other');

console.log('Python runtime resolution checks passed.');
