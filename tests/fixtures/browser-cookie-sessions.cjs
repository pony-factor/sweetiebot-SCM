'use strict';
// Use fake loopback cookies only. Never open ChatGPT or a user's browser profile.
const {app, BrowserWindow, session: electron} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {root, injections} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phase = process.argv[3];
app.setPath('userData', root);
app.on('window-all-closed', () => {});
const windows = new Set();
const deadline = setTimeout(() => finish(Error('Cookie session checks timed out')), 30000);
let server;

function finish(error) {
  clearTimeout(deadline);
  for (const win of windows) win.destroy();
  server?.close();
  if (error) {
    console.error(error);
    app.exit(1);
  } else {
    console.log(`Real Electron cookie sharing, isolation and ${phase} checks passed.`);
    app.quit();
  }
}

app.whenReady().then(async () => {
  const cookie = 'sweetiebot_cookie_ci=disposable-fixture';
  const login = 'sweetiebot_session_ci=disposable-session';
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/seed') {
      response.setHeader('Set-Cookie', [`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
        `${login}; Path=/; HttpOnly; SameSite=Lax`]);
    }
    const cookies = (request.headers.cookie || '').split('; ');
    response.end(`<body>${cookies.includes(cookie) && cookies.includes(login) ? 'authenticated' : 'anonymous'}</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function visit(ses, route, expected) {
    const win = new BrowserWindow({show: false,
      webPreferences: {session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false}});
    windows.add(win);
    try {
      await win.loadURL(origin + route);
      assert.equal(await win.webContents.executeJavaScript('document.body.textContent'), expected, route);
      assert.equal(await win.webContents.executeJavaScript('document.cookie'), '', 'HttpOnly cookie stays hidden from page scripts');
    } finally {
      windows.delete(win);
      win.destroy();
    }
  }
  for (const [index, injection] of injections.entries()) {
    const Sessions = {_bySession: new Map()};
    const host = {instantiationService: {createInstance(cls, id, session, scope) {
        const instance = {id, session, scope};
        cls._bySession.set(session, instance);
        return instance;
      }}};
    let isolatedCount = 0;
    const fallback = () => ({session: electron.fromPartition(`cookie-ci-isolated-${index}-${isolatedCount++}`)});
    const resolve = new Function('r', 'o', 'electron', 'Sessions', 'fallback',
      'return ' + injection + 'fallback();');
    const windowFor = id => ({openedWorkspace: {id}});
    const browser = (options, id) => resolve.call(host, options, windowFor(id), electron, Sessions, fallback).session;
    const repository = browser({scope: 'workspace'}, 'repository');
    assert.equal(repository.storagePath, path.join(app.getPath('sessionData'), 'Partitions', 'sweetiebot-browser'));
    if (phase === 'seed') {
      await visit(repository, '/before-login', 'anonymous');
      await visit(repository, '/seed', 'anonymous');
      const deadline = Date.now() + 5000;
      while (true) {
        const [saved] = await repository.cookies.get({name: 'sweetiebot_session_ci'});
        if (saved && !saved.session) break;
        assert(Date.now() < deadline, 'synthetic session cookie must be retained before exit');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    for (const id of ['repository', 'new-pr', 'bulk-merge', 'another-repository']) {
      await visit(browser({scope: 'workspace'}, id), `/${id}`, 'authenticated');
    }
    await visit(browser({scope: 'global'}, 'global'), '/global', 'authenticated');
    for (const options of [{scope: 'ephemeral'}, {scope: 'agent'},
      {scope: 'workspace', affinity: 'separate'},
      {scope: 'workspace', network: {authority: 'remote'}}]) {
      await visit(browser(options, 'isolated'), '/isolated', 'anonymous');
    }
  }
  finish();
}).catch(finish);
