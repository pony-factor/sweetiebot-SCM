'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { resolveKefaniaFile } = require('./kefania-paths');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tcpOccupied(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = occupied => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(700, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}

async function probeSetup(port, { fetchImpl = fetch, occupied = tcpOccupied } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/bootstrap`, {
      cache: 'no-store', signal: AbortSignal.timeout(1000)
    });
    if (response.ok) {
      const result = await response.json();
      if (typeof result?.csrf === 'string' && result.csrf.length >= 16 &&
          result.settings && typeof result.settings === 'object' &&
          result.connection && typeof result.connection === 'object') return 'ready';
    }
  } catch {
    // A different or unavailable service must not be accepted as Kefania.
  }
  return await occupied(port) ? 'occupied' : 'vacant';
}

async function launchKefaniaSetup({
  repositoryPath = path.resolve(__dirname, '..', '..'),
  resolveFile = resolveKefaniaFile,
  probe = probeSetup,
  spawnProcess = spawn,
  wait = sleep,
  env = process.env,
  nodePath = process.execPath,
} = {}) {
  const port = Number(env.KEFANIA_SETUP_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid Kefania setup port.');
  }
  const url = `http://127.0.0.1:${port}/`;
  const current = await probe(port);
  if (current === 'ready') return { url, reused: true };
  if (current !== 'vacant') {
    throw new Error(`Port ${port} is already in use by an unverified service. Close it before opening Kefania.`);
  }

  // The shared resolver validates the Kefania checkout's Git origin and root.
  const runner = await resolveFile(repositoryPath, path.join('src', 'setup-web.js'));
  await new Promise((resolve, reject) => {
    const child = spawnProcess(nodePath, [runner], {
      cwd: path.dirname(path.dirname(runner)),
      env: { ...env, KEFANIA_SETUP_PORT: String(port) },
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.once('error', () => reject(new Error('Unable to start Kefania. Check the Node installation.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  for (let attempt = 0; attempt < 32; attempt++) {
    await wait(250);
    const status = await probe(port);
    if (status === 'ready') return { url, reused: false };
  }
  if (await probe(port) === 'occupied') {
    throw new Error(`Port ${port} is in use by an unverified service. Kefania was not opened.`);
  }
  throw new Error('Kefania did not start. Check its installed npm dependencies and local checkout.');
}

if (require.main === module) {
  launchKefaniaSetup().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { probeSetup, launchKefaniaSetup };
