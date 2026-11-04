'use strict';

const fs = require('fs');
const path = require('path');

function resolvePythonExecutable(
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync
) {
  const configured = String(env.SWEETIEBOT_PYTHON || env.PYTHON || '').trim();
  if (configured) return configured;

  if (platform === 'darwin') {
    for (const candidate of [
      '/usr/bin/python3',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
      '/Library/Developer/CommandLineTools/usr/bin/python3'
    ]) {
      if (exists(candidate)) return candidate;
    }
  }

  const names = platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['python3', 'python'];
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }

  return platform === 'win32' ? 'python' : 'python3';
}

function pythonLaunchError(error) {
  if (!error || error.code !== 'ENOENT') return error;
  const wrapped = new Error(
    'Python 3 was not found. Install Python 3 or set SWEETIEBOT_PYTHON to its executable path.'
  );
  wrapped.code = 'PYTHON_NOT_FOUND';
  wrapped.cause = error;
  return wrapped;
}

module.exports = { resolvePythonExecutable, pythonLaunchError };
