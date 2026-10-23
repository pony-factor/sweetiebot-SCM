'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

const fs = require('node:fs/promises');
const path = require('node:path');

// Apply EFS exclusions before traversing dependencies and metadata.
function githubGlobRegex(pattern) {
  let source = '^';
  const escape = ch => '\\^$+?.()|[]{}'.includes(ch) ? '\\' + ch : ch;
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('**/', i)) { source += '(?:.*/)?'; i += 3; }
    else if (pattern.startsWith('**', i)) { source += '.*'; i += 2; }
    else if (pattern[i] === '*') { source += '[^/]*'; i++; }
    else if (pattern[i] === '?') { source += '[^/]'; i++; }
    else if (pattern[i] === '{' && pattern.indexOf('}', i + 1) !== -1) {
      const end = pattern.indexOf('}', i + 1);
      source += '(?:' + pattern.slice(i + 1, end).split(',').map(word =>
        [...word].map(escape).join('')).join('|') + ')';
      i = end + 1;
    } else { source += escape(pattern[i]); i++; }
  }
  return new RegExp(source + '$');
}

async function listGithubFolderFiles(folder, exclude, maxFiles = 100000) {
  const root = path.resolve(folder);
  let stat;
  try { stat = await fs.stat(root); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('GitHub folder not found: ' + root);
    throw error;
  }
  if (!stat.isDirectory()) throw new Error('GitHub folder is not a directory: ' + root);
  const matcher = exclude ? githubGlobRegex(String(exclude).replace(/\\/g, '/')) : null;
  const limit = Math.max(1, Math.min(100000, Number(maxFiles) || 100000));
  const files = [], directories = [root];
  // Breadth-first traversal avoids one repository dominating the index cap.
  for (let cursor = 0; cursor < directories.length && files.length < limit; cursor++) {
    let entries;
    try { entries = await fs.readdir(directories[cursor], { withFileTypes: true }); }
    catch (error) { if (cursor === 0) throw error; continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directories[cursor], entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && !(matcher && matcher.test(relative + '/'))) directories.push(absolute);
      } else if (entry.isFile() && !(matcher && matcher.test(relative))) {
        files.push(absolute);
        if (files.length === limit) break;
      }
    }
  }
  return files;
}

const { chunkText, keywordScore, bestMatchingLine, cosine } = require('./core');
const { extractText } = require('./extract');
const { embedTexts } = require('./ollama');

const INDEX_VERSION = 3;
const CACHE_SHARD_CHUNKS = 16;
const FILENAME_CACHE_TTL_MS = 2 * 60 * 1000;
const FOLDER_CACHE_TTL_MS = 2 * 60 * 1000;

// Treat punctuation and spaces alike when comparing a filename to a typed title.
function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}


function normalizedFolderName(value) {
  return normalizedName(value);
}

function workspaceKey() {
  const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('\n');
  return crypto.createHash('sha1').update(folders).digest('hex');
}

class SearchIndex {
  constructor(context, getSettings, options = {}) {
    this.githubFolder = options.githubFolder || '';
    this.context = context;
    this.getSettings = getSettings;
    this.files = new Map();
    this.dirty = new Set();
    this.loaded = false;
    this.embeddingModel = this.getSettings().embeddingModel;
    this.embeddingWarning = '';
    this.embeddingAvailable = true;
    this.persistTimer = undefined;
    this.loadPromise = undefined;
    this.refreshPromise = undefined;
    this.filenameCache = undefined;
    this.filenameScanPromise = undefined;
    this.folderCache = undefined;
    this.folderScanPromise = undefined;
    this.persistedEntries = new Map();
    this.cacheChanges = new Map();
    this.cacheRevision = 0;
    this.persistPromise = undefined;
  }

  cacheKey() {
    return this.githubFolder
      ? crypto.createHash('sha1').update(workspaceKey() + '\ngithub:' + this.githubFolder).digest('hex')
      : workspaceKey();
  }

  relativeUri(uri) {
    return this.githubFolder
      ? path.relative(this.githubFolder, uri.fsPath).split(path.sep).join('/')
      : vscode.workspace.asRelativePath(uri, false);
  }

  async listFiles(maxFiles) {
    if (!this.githubFolder) return vscode.workspace.findFiles('**/*', this.getSettings().exclude || undefined, maxFiles);
    const files = await listGithubFolderFiles(this.githubFolder, this.getSettings().exclude, maxFiles);
    return files.map(file => vscode.Uri.file(file));
  }

  get storageUri() {
    return vscode.Uri.joinPath(this.context.globalStorageUri, `workspace-search-${this.cacheKey()}.json`);
  }

  get cacheDirectoryUri() {
    return vscode.Uri.joinPath(this.context.globalStorageUri, `workspace-search-${this.cacheKey()}-parts`);
  }

  shardUri(uri, generation, part) {
    const id = crypto.createHash('sha1').update(uri).digest('hex');
    return vscode.Uri.joinPath(this.cacheDirectoryUri, `${id}-${generation}-${part}.json`);
  }

  markCacheChanged(uri) {
    this.cacheChanges.set(uri, ++this.cacheRevision);
  }

  async load() {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    const work = (async () => {
      try {
        const raw = await vscode.workspace.fs.readFile(this.storageUri);
        const payload = JSON.parse(Buffer.from(raw).toString('utf8'));
        if (payload.version !== INDEX_VERSION || payload.embeddingModel !== this.embeddingModel || !Array.isArray(payload.files)) return;
        for (const entry of payload.files) {
          if (!entry || typeof entry.uri !== 'string' || !/^[a-f0-9]{16}$/.test(entry.generation)
              || !Number.isSafeInteger(entry.shardCount) || entry.shardCount < 0) continue;
          const chunks = [];
          try {
            for (let part = 0; part < entry.shardCount; part += 1) {
              const rawPart = await vscode.workspace.fs.readFile(this.shardUri(entry.uri, entry.generation, part));
              const parsed = JSON.parse(Buffer.from(rawPart).toString('utf8'));
              if (!Array.isArray(parsed)) throw new Error('Invalid semantic index shard.');
              chunks.push(...parsed);
            }
          } catch {
            // Rebuild an incomplete entry instead of dropping the entire index.
            continue;
          }
          this.files.set(entry.uri, { uri: entry.uri, mtime: entry.mtime, size: entry.size, chunks });
          this.persistedEntries.set(entry.uri, entry);
        }
      } catch {
        // A missing or stale index starts clean.
      } finally {
        this.loaded = true;
      }
    })();
    this.loadPromise = work;
    try {
      return await work;
    } finally {
      if (this.loadPromise === work) this.loadPromise = undefined;
    }
  }

  async persist() {
    if (!this.loaded) return;
    // Background refreshes and file watcher updates must not race index writes.
    if (this.persistPromise) {
      await this.persistPromise;
      if (this.cacheChanges.size) return this.persist();
      return;
    }
    const work = this.persistNow();
    this.persistPromise = work;
    try {
      await work;
    } finally {
      if (this.persistPromise === work) this.persistPromise = undefined;
    }
  }

  async persistNow() {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.createDirectory(this.cacheDirectoryUri);
    const oldEntries = this.persistedEntries;
    const changes = new Map(this.cacheChanges);
    const entries = new Map();

    // Persist each file in bounded chunks. A whole-workspace JSON.stringify()
    // can exceed V8's maximum string size with thousands of embeddings.
    for (const file of this.files.values()) {
      const old = oldEntries.get(file.uri);
      if (old && !changes.has(file.uri)) {
        entries.set(file.uri, old);
        continue;
      }
      const generation = crypto.randomBytes(8).toString('hex');
      const chunks = file.chunks || [];
      const shardCount = Math.ceil(chunks.length / CACHE_SHARD_CHUNKS);
      for (let part = 0; part < shardCount; part += 1) {
        const batch = chunks.slice(part * CACHE_SHARD_CHUNKS, (part + 1) * CACHE_SHARD_CHUNKS);
        await vscode.workspace.fs.writeFile(this.shardUri(file.uri, generation, part), Buffer.from(JSON.stringify(batch)));
      }
      entries.set(file.uri, { uri: file.uri, mtime: file.mtime, size: file.size, generation, shardCount });
    }

    const payload = JSON.stringify({
      version: INDEX_VERSION, embeddingModel: this.embeddingModel, files: [...entries.values()]
    });
    const temp = vscode.Uri.joinPath(this.context.globalStorageUri, `workspace-search-${this.cacheKey()}.tmp`);
    await vscode.workspace.fs.writeFile(temp, Buffer.from(payload));
    try { await vscode.workspace.fs.delete(this.storageUri, { useTrash: false }); } catch {}
    await vscode.workspace.fs.rename(temp, this.storageUri, { overwrite: true });

    this.persistedEntries = entries;
    for (const [uri, revision] of changes) {
      if (this.cacheChanges.get(uri) === revision) this.cacheChanges.delete(uri);
    }
    for (const [uri, old] of oldEntries) {
      if (entries.get(uri)?.generation === old.generation) continue;
      for (let part = 0; part < old.shardCount; part += 1) {
        try { await vscode.workspace.fs.delete(this.shardUri(uri, old.generation, part), { useTrash: false }); } catch {}
      }
    }
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist().catch(() => {});
    }, 750);
  }

  markDirty(uri) {
    const key = uri.toString();
    this.dirty.add(key);
    if (!this.files.has(key)) this.filenameCache = undefined;
    this.folderCache = undefined;
  }

  remove(uri) {
    this.filenameCache = undefined;
    this.folderCache = undefined;
    this.dirty.delete(uri.toString());
    this.files.delete(uri.toString());
    this.markCacheChanged(uri.toString());
    this.schedulePersist();
  }

  async clear() {
    this.filenameCache = undefined;
    this.folderCache = undefined;
    this.files.clear();
    this.dirty.clear();
    this.persistedEntries.clear();
    this.cacheChanges.clear();
    try { await vscode.workspace.fs.delete(this.storageUri, { useTrash: false }); } catch {}
    try { await vscode.workspace.fs.delete(this.cacheDirectoryUri, { useTrash: false, recursive: true }); } catch {}
  }

  async indexUri(uri, stat) {
    const settings = this.getSettings();
    const text = await extractText(uri, stat.size, settings.maxFileSizeMB);
    const chunks = chunkText(text);
    const indexed = chunks.map(chunk => ({ ...chunk, vector: null }));
    if (this.embeddingAvailable) {
      try {
        for (let offset = 0; offset < chunks.length; offset += 16) {
          const batch = chunks.slice(offset, offset + 16).map(chunk => chunk.text);
          const vectors = await embedTexts(settings, batch);
          for (let i = 0; i < vectors.length; i += 1) indexed[offset + i].vector = vectors[i];
        }
        this.embeddingWarning = '';
      } catch (error) {
        this.embeddingAvailable = false;
        this.embeddingWarning = `Semantic indexing unavailable: ${error.message}`;
      }
    }
    this.files.set(uri.toString(), { uri: uri.toString(), mtime: stat.mtime, size: stat.size, chunks: indexed });
    this.markCacheChanged(uri.toString());
  }

  async refresh(options = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const work = this.refreshNow(options);
    this.refreshPromise = work;
    try {
      return await work;
    } finally {
      if (this.refreshPromise === work) this.refreshPromise = undefined;
    }
  }

  async refreshNow({ force = false, repairVectors = false, progress } = {}) {
    await this.load();
    if (this.embeddingModel !== this.getSettings().embeddingModel) {
      this.files.clear();
      this.embeddingModel = this.getSettings().embeddingModel;
      this.embeddingAvailable = true;
      this.embeddingWarning = '';
      force = true;
    }
    if (force) {
      this.embeddingAvailable = true;
      this.embeddingWarning = '';
    }
    const settings = this.getSettings();
    const uris = await this.listFiles(settings.maxFiles);
    const seen = new Set();
    let processed = 0;
    for (const uri of uris) {
      const key = uri.toString();
      seen.add(key);
      let stat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }
      if ((stat.type & vscode.FileType.File) === 0) continue;
      const previous = this.files.get(key);
      const changed = force || this.dirty.has(key) || !previous || previous.mtime !== stat.mtime || previous.size !== stat.size
        || (repairVectors && previous.chunks.some(chunk => !chunk.vector));
      if (!changed) continue;
      progress?.report({ message: vscode.workspace.asRelativePath(uri, false) });
      await this.indexUri(uri, stat);
      this.dirty.delete(key);
      processed += 1;
    }
    let removed = 0;
    for (const key of [...this.files.keys()]) if (!seen.has(key)) {
      this.files.delete(key);
      this.markCacheChanged(key);
      removed += 1;
    }
    if (processed || force || removed) await this.persist();
    return { files: this.files.size, processed, warning: this.embeddingWarning };
  }

  async discoverFilenames(settings) {
    const exclude = settings.exclude || undefined;
    if (this.filenameCache && this.filenameCache.exclude === exclude && Date.now() < this.filenameCache.expires) {
      return this.filenameCache.uris;
    }
    if (this.filenameScanPromise) return this.filenameScanPromise;

    // Unlike content indexing, filename discovery must not use maxFiles.
    const work = this.listFiles();
    this.filenameScanPromise = work;
    try {
      const uris = await work;
      this.filenameCache = { exclude, uris, expires: Date.now() + FILENAME_CACHE_TTL_MS };
      return uris;
    } finally {
      if (this.filenameScanPromise === work) this.filenameScanPromise = undefined;
    }
  }

  async discoverFolders(settings) {
    const exclude = settings.exclude || undefined;
    if (this.folderCache && this.folderCache.exclude === exclude && Date.now() < this.folderCache.expires) {
      return this.folderCache.uris;
    }
    if (this.folderScanPromise) return this.folderScanPromise;

    const work = (async () => {
      // Discover folder paths without the passage index's maxFiles limit.
      const files = await this.listFiles();
      const folders = new Map();
      const githubRootUri = this.githubFolder ? vscode.Uri.file(this.githubFolder) : null;
      if (githubRootUri) folders.set(githubRootUri.toString(), githubRootUri);
      else for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
        folders.set(workspaceFolder.uri.toString(), workspaceFolder.uri);
      }
      for (const uri of files) {
        const workspaceRoot = githubRootUri || vscode.workspace.getWorkspaceFolder(uri)?.uri;
        if (!workspaceRoot) continue;
        let parent = vscode.Uri.joinPath(uri, '..');
        while (parent.toString() !== workspaceRoot.toString()) {
          const key = parent.toString();
          if (folders.has(key)) break;
          folders.set(key, parent);
          const next = vscode.Uri.joinPath(parent, '..');
          if (next.toString() === key) break;
          parent = next;
        }
      }
      const uris = [...folders.values()];
      this.folderCache = { exclude, uris, expires: Date.now() + FOLDER_CACHE_TTL_MS };
      return uris;
    })();
    this.folderScanPromise = work;
    try {
      return await work;
    } finally {
      if (this.folderScanPromise === work) this.folderScanPromise = undefined;
    }
  }


  async search(query, mode) {
    await this.load();
    if (!this.files.size || this.embeddingModel !== this.getSettings().embeddingModel) await this.refresh();
    const settings = this.getSettings();
    const selectedMode = mode || settings.mode;
    let queryVector = null;
    if (selectedMode !== 'exact') {
      try {
        [queryVector] = await embedTexts(settings, [query]);
        this.embeddingAvailable = true;
        this.embeddingWarning = '';
      } catch (error) {
        this.embeddingWarning = `Semantic search unavailable: ${error.message}`;
      }
      // Only repair files with missing vectors; do not re-embed the workspace
      // on every query or misreport an index storage error as an Ollama error.
      if (queryVector && [...this.files.values()].some(file => file.chunks.some(chunk => !chunk.vector))) {
        try {
          await this.refresh({ repairVectors: true });
        } catch (error) {
          this.embeddingWarning = `Semantic index recovery failed: ${error.message}`;
        }
      }
    }
    const scored = [];
    const fuzzy = selectedMode === 'hybrid';
    const normalizedQuery = normalizedName(query);
    const literalUrlQuery = /^https?:\/\/\S+$/i.test(String(query || '').trim());
    for (const folderUri of await this.discoverFolders(settings)) {
      const relative = this.relativeUri(folderUri);
      const name = relative.split(/[\\/]/).pop() || relative;
      const nameScore = keywordScore(query, name, { fuzzy: fuzzy });
      const pathScore = keywordScore(query, relative, { fuzzy: fuzzy });
      const directMatch = normalizedQuery && normalizedQuery === normalizedFolderName(name);
      const score = directMatch ? 2 : Math.max(nameScore * 1.15, pathScore * 1.05);
      if (score > 0) {
        scored.push({
          uri: folderUri.toString(),
          relative,
          line: 0,
          text: directMatch || nameScore >= pathScore ? 'Folder name match' : 'Folder path match',
          score,
          kind: 'folder'
        });
      }
    }
    const filenames = await this.discoverFilenames(settings);
    for (const uri of filenames) {
      const relative = this.relativeUri(uri);
      const filename = relative.split(/[\\/]/).pop() || relative;
      const filenameScore = keywordScore(query, filename, { fuzzy });
      const pathScore = keywordScore(query, relative, { fuzzy });
      const stem = filename.replace(/\.[^.]+$/, '');
      const directMatch = normalizedQuery && (
        normalizedQuery === normalizedName(stem) || normalizedQuery === normalizedName(filename)
      );
      // Strong filename matches outrank semantic and content results.
      const fileScore = directMatch ? 2 : Math.max(filenameScore, pathScore * 0.95);
      if (fileScore > 0) {
        scored.push({
          uri: uri.toString(),
          relative,
          line: 0,
          text: directMatch || filenameScore >= pathScore * 0.95 ? 'File name match' : 'Path match',
          score: fileScore,
          kind: 'filename'
        });
      }
    }
    for (const file of this.files.values()) {
      for (const chunk of file.chunks || []) {
        const literalUrlOffset = literalUrlQuery ? chunk.text.indexOf(query) : -1;
        const exact = keywordScore(query, chunk.text, { fuzzy });
        const semantic = queryVector && chunk.vector ? Math.max(0, cosine(queryVector, chunk.vector)) : 0;
        // An identical URL must never be buried by semantically similar passages.
        const literalMatch = chunk.text.toLowerCase().includes(String(query).trim().toLowerCase());
        const score = literalUrlOffset >= 0 ? 3 : selectedMode === 'exact'
            ? exact
            : selectedMode === 'semantic'
                ? semantic
                : literalMatch
                    // Literal matches lead; semantic relevance orders that group.
                    ? 1 + semantic * 0.2
                    : (!queryVector || !chunk.vector)
                        ? exact
                        : exact * 0.65 + semantic * 0.35;
        if (score > 0) {
          const line = literalUrlOffset >= 0
            ? chunk.line + (chunk.text.slice(0, literalUrlOffset).match(/\n/g) || []).length
            : bestMatchingLine(query, chunk.text, chunk.line, { fuzzy });
          scored.push({ uri: file.uri, relative: this.relativeUri(vscode.Uri.parse(file.uri)), line, text: chunk.text, score });
        }
      }
    }
    // A path hit explains where a file was found; do not show it as a separate
    // result when the same file already has matching passage content.
    const filesWithPassages = new Set(scored.filter(item => !item.kind).map(item => item.uri));
    const visibleResults = scored.filter(item => item.kind !== 'filename' || item.text !== 'Path match' || !filesWithPassages.has(item.uri));
    visibleResults.sort((a, b) => b.score - a.score);
    if (this.dirty.size) void this.refresh().then(() => {
      if (this.dirty.size) return this.refresh();
      return undefined;
    }).catch(() => {});
    return { results: visibleResults.slice(0, settings.resultLimit), warning: this.embeddingWarning, mode: selectedMode };
  }
}

module.exports = { SearchIndex, listGithubFolderFiles, githubGlobRegex };
