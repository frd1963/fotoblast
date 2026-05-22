const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const REPO_DIR = process.env.REPO_DIR || path.join(__dirname, 'repo');
const SYNC_COOKIE = 'synced_photos';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

fs.mkdirSync(REPO_DIR, { recursive: true });

const watchers = new Set();

function safePhotoName(name) {
  const base = path.basename(name);
  if (!base || base.startsWith('.') || base !== name) return null;
  const full = path.join(REPO_DIR, base);
  if (!full.startsWith(REPO_DIR + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return base;
}

function broadcastPhoto(meta) {
  const payload = `event: photo\ndata: ${JSON.stringify(meta)}\n\n`;
  for (const res of watchers) {
    res.write(payload);
  }
}

const app = express();
app.use(express.json());

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, REPO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

function listPhotos() {
  return fs
    .readdirSync(REPO_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function parseSyncedCookie(req) {
  const raw = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SYNC_COOKIE}=`));
  if (!raw) return new Set();

  const value = decodeURIComponent(raw.slice(SYNC_COOKIE.length + 1));
  try {
    const names = JSON.parse(value);
    return new Set(Array.isArray(names) ? names : []);
  } catch {
    return new Set();
  }
}

function syncedCookieValue(names) {
  return `${SYNC_COOKIE}=${encodeURIComponent(JSON.stringify([...names]))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`;
}

app.post('/upload', upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing photo field (multipart form field name: photo)' });
  }
  const meta = {
    filename: req.file.filename,
    size: req.file.size,
    url: `/photos/${encodeURIComponent(req.file.filename)}`,
  };
  broadcastPhoto(meta);
  res.status(201).json({ ok: true, ...meta });
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.get('/photos/:filename', (req, res) => {
  const name = safePhotoName(req.params.filename);
  if (!name) return res.status(404).json({ error: 'Photo not found' });
  res.download(path.join(REPO_DIR, name), name);
});

app.get('/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': connected\n\n');
  watchers.add(res);

  if (req.query.initial !== '0') {
    for (const filename of listPhotos()) {
      const full = path.join(REPO_DIR, filename);
      const stat = fs.statSync(full);
      const meta = {
        filename,
        size: stat.size,
        url: `/photos/${encodeURIComponent(filename)}`,
      };
      res.write(`event: photo\ndata: ${JSON.stringify(meta)}\n\n`);
    }
  }

  req.on('close', () => watchers.delete(res));
});

app.get('/ui', (_req, res) => {
  res.type('html').send(UI_HTML);
});

app.get('/receiver', (_req, res) => {
  res.type('html').send(RECEIVER_HTML);
});

app.get('/slideshow', (_req, res) => {
  res.type('html').send(SLIDESHOW_HTML);
});

app.get('/slideshow/photos', (_req, res) => {
  res.json({
    photos: listPhotos().map((filename) => ({
      filename,
      url: `/photos/${encodeURIComponent(filename)}`,
    })),
  });
});

app.get('/sync', (req, res) => {
  const synced = parseSyncedCookie(req);
  const all = listPhotos();
  const pending = all.filter((name) => !synced.has(name));

  if (pending.length === 0) {
    res.status(204).end();
    return;
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="photos-${stamp}.zip"`);

  pending.forEach((name) => {
    archive.file(path.join(REPO_DIR, name), { name });
  });

  pending.forEach((name) => synced.add(name));
  res.setHeader('Set-Cookie', syncedCookieValue(synced));

  archive.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });

  archive.pipe(res);
  archive.finalize();
});

app.get('/', (_req, res) => res.redirect('/ui'));

app.get('/health', (_req, res) => {
  res.json({ ok: true, photos: listPhotos().length });
});

const heartbeat = setInterval(() => {
  for (const res of watchers) {
    res.write(': heartbeat\n\n');
  }
}, 25000);

heartbeat.unref();

app.listen(PORT, () => {
  console.log(`Fotoblast listening on http://0.0.0.0:${PORT}`);
  console.log(`Repo directory: ${REPO_DIR}`);
});

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Fotoblast</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 1.25rem;
      max-width: 32rem;
      margin-inline: auto;
      line-height: 1.5;
      color: #1a1a1a;
      background: #f6f7f9;
    }
    h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 1rem 1.1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,.08);
      margin-bottom: 1rem;
    }
    ol { margin: 0; padding-left: 1.2rem; }
    li { margin-bottom: 0.35rem; }
    button, .btn {
      display: inline-block;
      width: 100%;
      padding: 0.85rem 1rem;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
    }
    #takeBtn {
      background: #2563eb;
      color: #fff;
      margin-bottom: 0.5rem;
    }
    #takeBtn:disabled { opacity: 0.6; cursor: wait; }
    #status {
      min-height: 1.25rem;
      font-size: 0.9rem;
      margin-top: 0.75rem;
      color: #374151;
    }
    #status.ok { color: #047857; }
    #status.err { color: #b91c1c; }
    #clearBtn {
      background: #e5e7eb;
      color: #111;
      margin-bottom: 0.75rem;
    }
    #clearBtn:disabled { opacity: 0.45; cursor: default; }
    #stackCard { display: none; }
    #stackCard.visible { display: block; }
    #photoStack {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .stack-item {
      border-radius: 8px;
      overflow: hidden;
      background: #f3f4f6;
    }
    .stack-item img {
      width: 100%;
      display: block;
      vertical-align: middle;
    }
    .stack-item .stack-label {
      font-size: 0.75rem;
      color: #6b7280;
      padding: 0.35rem 0.5rem 0.45rem;
      word-break: break-all;
    }
    input[type="file"] { display: none; }
    code { font-size: 0.85em; background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Fotoblast</h1>
  <div class="card">
    <ol>
      <li>Tap <strong>Take fotos</strong> to open your device camera.</li>
      <li>Each photo is uploaded immediately.</li>
    </ol>
  </div>
  <div class="card">
    <button type="button" id="takeBtn">Take fotos</button>
    <input type="file" id="cameraInput" accept="image/*" capture="environment">
    <p id="status"></p>
  </div>
  <div class="card" id="stackCard">
    <button type="button" id="clearBtn" disabled>Clear</button>
    <div id="photoStack"></div>
  </div>
  <script>
    const MAX_STACK = 25;
    const takeBtn = document.getElementById('takeBtn');
    const input = document.getElementById('cameraInput');
    const status = document.getElementById('status');
    const stackCard = document.getElementById('stackCard');
    const photoStack = document.getElementById('photoStack');
    const clearBtn = document.getElementById('clearBtn');

    function setStatus(msg, type) {
      status.textContent = msg;
      status.className = type || '';
    }

    function updateStackChrome() {
      const hasPhotos = photoStack.children.length > 0;
      stackCard.classList.toggle('visible', hasPhotos);
      clearBtn.disabled = !hasPhotos;
    }

    function addToStack(result) {
      const item = document.createElement('div');
      item.className = 'stack-item';
      const img = document.createElement('img');
      img.src = result.url;
      img.alt = result.filename;
      img.loading = 'lazy';
      const label = document.createElement('div');
      label.className = 'stack-label';
      label.textContent = result.filename;
      item.appendChild(img);
      item.appendChild(label);
      photoStack.prepend(item);
      while (photoStack.children.length > MAX_STACK) {
        photoStack.lastElementChild.remove();
      }
      updateStackChrome();
    }

    function clearStack() {
      photoStack.innerHTML = '';
      updateStackChrome();
    }

    function ensureImageFile(file) {
      if (file.type && file.type.startsWith('image/')) return file;
      const name = file.name && file.name.includes('.') ? file.name : 'photo.jpg';
      return new File([file], name, { type: 'image/jpeg', lastModified: file.lastModified });
    }

    async function uploadFile(file) {
      const fd = new FormData();
      fd.append('photo', file, file.name || 'photo.jpg');
      const res = await fetch('/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || 'Upload failed');
      return data;
    }

    async function processCapture(file) {
      const imageFile = ensureImageFile(file);
      takeBtn.disabled = true;
      setStatus('Uploading…');

      try {
        const result = await uploadFile(imageFile);
        addToStack(result);
        setStatus('Uploaded: ' + result.filename, 'ok');
      } catch (e) {
        setStatus(e.message || 'Upload failed', 'err');
      } finally {
        takeBtn.disabled = false;
      }
    }

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      void processCapture(file);
    });

    takeBtn.addEventListener('click', () => input.click());
    clearBtn.addEventListener('click', clearStack);
  </script>
</body>
</html>`;

const RECEIVER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fotoblast Receiver</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 1.25rem;
      max-width: 40rem;
      margin-inline: auto;
      line-height: 1.5;
      background: #f6f7f9;
      color: #1a1a1a;
    }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 1rem 1.1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,.08);
      margin-bottom: 1rem;
    }
    #state { font-weight: 600; }
    #state.live { color: #047857; }
    #state.err { color: #b91c1c; }
    #log {
      margin: 0;
      padding: 0;
      list-style: none;
      max-height: 20rem;
      overflow: auto;
      font-size: 0.9rem;
    }
    #log li { padding: 0.35rem 0; border-bottom: 1px solid #eee; }
    #log a { color: #2563eb; }
    label { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }
    .folder-row { margin-top: 1rem; }
    #folderPath {
      font-size: 0.9rem;
      color: #374151;
      margin: 0.5rem 0 0;
      word-break: break-all;
    }
    .btn-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .btn {
      padding: 0.6rem 0.9rem;
      font-size: 0.95rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      background: #2563eb;
      color: #fff;
    }
    .btn.secondary { background: #e5e7eb; color: #111; }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .hint { font-size: 0.85rem; color: #6b7280; margin: 0.5rem 0 0; }
  </style>
</head>
<body>
  <h1>Live receiver</h1>
  <div class="card">
    <p>Stays connected to <code>/watch</code> and saves each new photo as it is uploaded.</p>
    <p id="state">Connecting…</p>
    <div class="folder-row">
      <p><strong>Auto-save folder</strong></p>
      <p id="folderPath">Not set — using browser Downloads</p>
      <div class="btn-row">
        <button type="button" class="btn" id="pickFolderBtn">Choose save folder…</button>
        <button type="button" class="btn secondary" id="clearFolderBtn" hidden>Use browser Downloads</button>
      </div>
      <p class="hint">Picks a folder only for this app. Your browser’s default download location stays unchanged. Requires Chrome or Edge on desktop.</p>
    </div>
    <label>
      <input type="checkbox" id="autoDl" checked>
      Auto-save new photos
    </label>
    <label>
      <input type="checkbox" id="skipExisting" checked>
      Skip photos already in repo when page loads
    </label>
  </div>
  <div class="card">
    <ul id="log"></ul>
  </div>
  <script>
    const STORAGE_KEY = 'fotoblast-received';
    const IDB_NAME = 'fotoblast-receiver';
    const IDB_STORE = 'settings';
    const HANDLE_KEY = 'saveDir';

    const state = document.getElementById('state');
    const log = document.getElementById('log');
    const autoDl = document.getElementById('autoDl');
    const skipExisting = document.getElementById('skipExisting');
    const folderPath = document.getElementById('folderPath');
    const pickFolderBtn = document.getElementById('pickFolderBtn');
    const clearFolderBtn = document.getElementById('clearFolderBtn');

    const fsSupported = 'showDirectoryPicker' in window;
    let saveDirHandle = null;

    const received = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
    let bootstrapping = true;

    function persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...received]));
    }

    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function idbGet(db, key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function idbPut(db, key, value) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    function idbDelete(db, key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function verifyDirPermission(handle) {
      if (!handle) return false;
      const opts = { mode: 'readwrite' };
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      return (await handle.requestPermission(opts)) === 'granted';
    }

    function updateFolderUi() {
      if (saveDirHandle) {
        folderPath.textContent = saveDirHandle.name;
        clearFolderBtn.hidden = false;
        pickFolderBtn.textContent = 'Change save folder…';
      } else {
        folderPath.textContent = fsSupported
          ? 'Not set — using browser Downloads'
          : 'Folder picker not supported — using browser Downloads';
        clearFolderBtn.hidden = true;
        pickFolderBtn.textContent = 'Choose save folder…';
      }
      pickFolderBtn.disabled = !fsSupported;
    }

    async function loadSavedFolder() {
      if (!fsSupported) {
        updateFolderUi();
        return;
      }
      try {
        const db = await openDb();
        const handle = await idbGet(db, HANDLE_KEY);
        if (handle && (await verifyDirPermission(handle))) {
          saveDirHandle = handle;
        } else if (handle) {
          await idbDelete(db, HANDLE_KEY);
        }
      } catch {
        /* ignore */
      }
      updateFolderUi();
    }

    async function chooseSaveFolder() {
      if (!fsSupported) {
        addLog('Folder picker requires Chrome or Edge on desktop');
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (!(await verifyDirPermission(handle))) {
          addLog('Write permission denied for folder');
          return;
        }
        saveDirHandle = handle;
        const db = await openDb();
        await idbPut(db, HANDLE_KEY, handle);
        updateFolderUi();
        addLog('Saving to folder: ' + handle.name);
      } catch (e) {
        if (e.name !== 'AbortError') addLog('Folder error: ' + e.message);
      }
    }

    async function clearSaveFolder() {
      saveDirHandle = null;
      try {
        const db = await openDb();
        await idbDelete(db, HANDLE_KEY);
      } catch {
        /* ignore */
      }
      updateFolderUi();
      addLog('Using browser Downloads for auto-save');
    }

    function addLog(text, url) {
      const li = document.createElement('li');
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        a.textContent = text;
        li.appendChild(a);
      } else {
        li.textContent = text;
      }
      log.prepend(li);
    }

    async function savePhotoToChosenFolder(meta, blob) {
      const fileHandle = await saveDirHandle.getFileHandle(meta.filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    }

    async function savePhotoViaBrowserDownload(meta, blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = meta.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    async function downloadPhoto(meta) {
      const res = await fetch(meta.url);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();

      if (saveDirHandle) {
        if (!(await verifyDirPermission(saveDirHandle))) {
          throw new Error('Lost access to save folder — choose it again');
        }
        await savePhotoToChosenFolder(meta, blob);
      } else {
        await savePhotoViaBrowserDownload(meta, blob);
      }
    }

    function handlePhoto(meta) {
      if (received.has(meta.filename)) return;
      received.add(meta.filename);
      persist();

      if (bootstrapping && skipExisting.checked) return;

      addLog('Received: ' + meta.filename, meta.url);
      if (autoDl.checked) {
        downloadPhoto(meta).catch((e) => addLog('Download error: ' + e.message));
      }
    }

    const es = new EventSource('/watch?initial=1');

    es.addEventListener('open', () => {
      state.textContent = 'Connected — waiting for uploads';
      state.className = 'live';
      setTimeout(() => { bootstrapping = false; }, 500);
    });

    es.addEventListener('photo', (ev) => {
      try {
        handlePhoto(JSON.parse(ev.data));
      } catch (e) {
        addLog('Bad event: ' + e.message);
      }
    });

    es.onerror = () => {
      state.textContent = 'Connection lost — retrying…';
      state.className = 'err';
    };

    pickFolderBtn.addEventListener('click', chooseSaveFolder);
    clearFolderBtn.addEventListener('click', clearSaveFolder);
    loadSavedFolder();
  </script>
</body>
</html>`;

const SLIDESHOW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fotoblast Slideshow</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      background: #000;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #stage {
      position: fixed;
      inset: 0;
      background: #000;
      overflow: hidden;
    }
    .layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      transform-origin: center center;
      transition-duration: 0s;
      transition-property: opacity, transform, filter, clip-path;
      transition-timing-function: ease-in-out;
      z-index: 1;
    }
    .layer.off {
      visibility: hidden;
      opacity: 0 !important;
      pointer-events: none;
      z-index: 0;
      transition: none !important;
    }
    .layer.from { z-index: 1; visibility: visible; }
    .layer.to { z-index: 2; visibility: visible; }
    #empty {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      color: #9ca3af;
      font-size: 1.1rem;
      padding: 2rem;
      text-align: center;
    }
    #empty.visible { display: flex; }
    #menu {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      z-index: 20;
      width: min(20rem, calc(100vw - 2rem));
      padding: 0.85rem 1rem;
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transform: translateY(0.5rem);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    #menu.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    #menu h2 {
      margin: 0 0 0.65rem;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .field {
      margin-bottom: 0.65rem;
    }
    .field:last-child { margin-bottom: 0; }
    .field label {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 0.8rem;
      margin-bottom: 0.25rem;
      color: #cbd5e1;
    }
    .field label span { color: #f8fafc; font-weight: 600; }
    .field input[type="range"] { width: 100%; }
    .field select {
      width: 100%;
      padding: 0.4rem 0.5rem;
      border-radius: 6px;
      border: 1px solid #334155;
      background: #0f172a;
      color: #f8fafc;
      font-size: 0.85rem;
    }
    .layer.from.fade { opacity: 1; }
    .layer.from.fade.animate { opacity: 0; }
    .layer.to.fade { opacity: 0; }
    .layer.to.fade.animate { opacity: 1; }
    .layer.from.slide-left { opacity: 1; transform: translateX(0); }
    .layer.from.slide-left.animate { opacity: 0; transform: translateX(-100%); }
    .layer.to.slide-left { opacity: 0; transform: translateX(100%); }
    .layer.to.slide-left.animate { opacity: 1; transform: translateX(0); }
    .layer.from.slide-right { opacity: 1; transform: translateX(0); }
    .layer.from.slide-right.animate { opacity: 0; transform: translateX(100%); }
    .layer.to.slide-right { opacity: 0; transform: translateX(-100%); }
    .layer.to.slide-right.animate { opacity: 1; transform: translateX(0); }
    .layer.from.slide-up { opacity: 1; transform: translateY(0); }
    .layer.from.slide-up.animate { opacity: 0; transform: translateY(-100%); }
    .layer.to.slide-up { opacity: 0; transform: translateY(100%); }
    .layer.to.slide-up.animate { opacity: 1; transform: translateY(0); }
    .layer.from.slide-down { opacity: 1; transform: translateY(0); }
    .layer.from.slide-down.animate { opacity: 0; transform: translateY(100%); }
    .layer.to.slide-down { opacity: 0; transform: translateY(-100%); }
    .layer.to.slide-down.animate { opacity: 1; transform: translateY(0); }
    .layer.from.zoom-in { opacity: 1; transform: scale(1); }
    .layer.from.zoom-in.animate { opacity: 0; transform: scale(1.15); }
    .layer.to.zoom-in { opacity: 0; transform: scale(0.85); }
    .layer.to.zoom-in.animate { opacity: 1; transform: scale(1); }
    .layer.from.zoom-out { opacity: 1; transform: scale(1); }
    .layer.from.zoom-out.animate { opacity: 0; transform: scale(0.85); }
    .layer.to.zoom-out { opacity: 0; transform: scale(1.15); }
    .layer.to.zoom-out.animate { opacity: 1; transform: scale(1); }
    .layer.from.blur { opacity: 1; filter: blur(0); }
    .layer.from.blur.animate { opacity: 0; filter: blur(12px); }
    .layer.to.blur { opacity: 0; filter: blur(12px); }
    .layer.to.blur.animate { opacity: 1; filter: blur(0); }
    .layer.from.rotate { opacity: 1; transform: rotate(0deg) scale(1); }
    .layer.from.rotate.animate { opacity: 0; transform: rotate(-12deg) scale(0.9); }
    .layer.to.rotate { opacity: 0; transform: rotate(12deg) scale(0.9); }
    .layer.to.rotate.animate { opacity: 1; transform: rotate(0deg) scale(1); }
    .layer.from.flip-h { opacity: 1; transform: perspective(1200px) rotateY(0deg); }
    .layer.from.flip-h.animate { opacity: 0; transform: perspective(1200px) rotateY(90deg); }
    .layer.to.flip-h { opacity: 0; transform: perspective(1200px) rotateY(-90deg); }
    .layer.to.flip-h.animate { opacity: 1; transform: perspective(1200px) rotateY(0deg); }
    .layer.from.flip-v { opacity: 1; transform: perspective(1200px) rotateX(0deg); }
    .layer.from.flip-v.animate { opacity: 0; transform: perspective(1200px) rotateX(90deg); }
    .layer.to.flip-v { opacity: 0; transform: perspective(1200px) rotateX(-90deg); }
    .layer.to.flip-v.animate { opacity: 1; transform: perspective(1200px) rotateX(0deg); }
    .layer.from.wipe-left { opacity: 1; clip-path: inset(0 0 0 0); }
    .layer.from.wipe-left.animate { clip-path: inset(0 100% 0 0); opacity: 1; }
    .layer.to.wipe-left { opacity: 1; clip-path: inset(0 0 0 100%); }
    .layer.to.wipe-left.animate { clip-path: inset(0 0 0 0); }
    .layer.from.dissolve { opacity: 1; filter: contrast(1); }
    .layer.from.dissolve.animate { opacity: 0; filter: contrast(2) brightness(1.4); }
    .layer.to.dissolve { opacity: 0; filter: contrast(0.5) brightness(0.6); }
    .layer.to.dissolve.animate { opacity: 1; filter: contrast(1) brightness(1); }
    .layer.from.push { opacity: 1; transform: scale(1); }
    .layer.from.push.animate { opacity: 0.6; transform: scale(0.92); }
    .layer.to.push { opacity: 0; transform: scale(1.08); }
    .layer.to.push.animate { opacity: 1; transform: scale(1); }
    .layer.from.fade-black { opacity: 1; filter: brightness(1); }
    .layer.from.fade-black.animate { opacity: 0; filter: brightness(0); }
    .layer.to.fade-black { opacity: 0; filter: brightness(0); }
    .layer.to.fade-black.animate { opacity: 1; filter: brightness(1); }
    .layer.from.morph { opacity: 1; filter: blur(0) saturate(1); transform: scale(1) skewX(0deg); }
    .layer.from.morph.animate { opacity: 0; filter: blur(16px) saturate(1.4); transform: scale(1.06) skewX(4deg); }
    .layer.to.morph { opacity: 0; filter: blur(16px) saturate(0.7); transform: scale(0.94) skewX(-4deg); }
    .layer.to.morph.animate { opacity: 1; filter: blur(0) saturate(1); transform: scale(1) skewX(0deg); }
    .layer.from.shatter { opacity: 1; transform: scale(1) rotate(0deg); clip-path: inset(0 0 0 0); filter: blur(0); }
    .layer.from.shatter.animate { opacity: 0; transform: scale(1.14) rotate(7deg); clip-path: polygon(8% 0, 92% 4%, 100% 38%, 62% 52%, 96% 100%, 4% 92%, 0 36%); filter: blur(5px); }
    .layer.to.shatter { opacity: 0; transform: scale(0.86) rotate(-6deg); clip-path: inset(12% 8% 12% 8%); filter: blur(10px); }
    .layer.to.shatter.animate { opacity: 1; transform: scale(1) rotate(0deg); clip-path: inset(0 0 0 0); filter: blur(0); }
    .layer.from.smash { opacity: 1; transform: scale(1); }
    .layer.from.smash.animate { opacity: 0; transform: scale(0.75); filter: brightness(0.6); }
    .layer.to.smash { opacity: 0; transform: translateY(-35%) scale(1.35); }
    .layer.to.smash.animate { opacity: 1; transform: translateY(0) scale(1); transition-timing-function: cubic-bezier(0.2, 0.9, 0.2, 1); }
    .layer.from.bounce { opacity: 1; transform: scale(1); }
    .layer.from.bounce.animate { opacity: 0; transform: scale(0.88); }
    .layer.to.bounce { opacity: 0; transform: scale(0.25); }
    .layer.to.bounce.animate { opacity: 1; transform: scale(1); transition-timing-function: cubic-bezier(0.34, 1.45, 0.64, 1); }
    #staticOverlay {
      position: absolute;
      inset: 0;
      z-index: 15;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s ease;
      background: #000;
      overflow: hidden;
    }
    #staticOverlay::before {
      content: '';
      position: absolute;
      inset: -80%;
      width: 260%;
      height: 260%;
      opacity: 0.92;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      animation: static-jitter 0.12s steps(5) infinite;
    }
    #stage.static-on #staticOverlay { opacity: 1; }
    @keyframes static-jitter {
      0% { transform: translate(0, 0); }
      25% { transform: translate(-3%, 2%); }
      50% { transform: translate(2%, -3%); }
      75% { transform: translate(-2%, -1%); }
      100% { transform: translate(3%, 1%); }
    }
  </style>
</head>
<body>
  <div id="stage">
    <img id="layerA" class="layer" alt="" decoding="async">
    <img id="layerB" class="layer off" alt="" decoding="async">
    <div id="staticOverlay" aria-hidden="true"></div>
  </div>
  <p id="empty">No photos uploaded yet.</p>
  <div id="menu" aria-label="Slideshow options">
    <h2>Slideshow</h2>
    <div class="field">
      <label for="displayTime">Show each photo <span id="displayTimeVal">5s</span></label>
      <input type="range" id="displayTime" min="1" max="30" step="1" value="5">
    </div>
    <div class="field">
      <label for="transitionSpeed">Transition speed <span id="transitionSpeedVal">0.8s</span></label>
      <input type="range" id="transitionSpeed" min="0.1" max="3" step="0.1" value="0.8">
    </div>
    <div class="field">
      <label for="transitionType">Transition type</label>
      <select id="transitionType">
        <option value="none" selected>None</option>
        <option value="random">Random</option>
        <option value="fade">Fade</option>
        <option value="slide-left">Slide left</option>
        <option value="slide-right">Slide right</option>
        <option value="slide-up">Slide up</option>
        <option value="slide-down">Slide down</option>
        <option value="zoom-in">Zoom in</option>
        <option value="zoom-out">Zoom out</option>
        <option value="blur">Blur</option>
        <option value="rotate">Rotate</option>
        <option value="flip-h">Flip horizontal</option>
        <option value="flip-v">Flip vertical</option>
        <option value="wipe-left">Wipe left</option>
        <option value="dissolve">Dissolve</option>
        <option value="push">Push</option>
        <option value="fade-black">Fade to/from black</option>
        <option value="morph">Morph</option>
        <option value="shatter">Shatter</option>
        <option value="static">TV static</option>
        <option value="smash">Smash</option>
        <option value="bounce">Bounce</option>
      </select>
    </div>
  </div>
  <script>
    const RANDOM_TYPES = [
      'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down',
      'zoom-in', 'zoom-out', 'blur', 'rotate', 'flip-h', 'flip-v',
      'wipe-left', 'dissolve', 'push', 'fade-black', 'morph', 'shatter',
      'static', 'smash', 'bounce',
    ];

    const layerA = document.getElementById('layerA');
    const layerB = document.getElementById('layerB');
    const stage = document.getElementById('stage');
    const emptyEl = document.getElementById('empty');
    const menu = document.getElementById('menu');
    const displayTimeInput = document.getElementById('displayTime');
    const transitionSpeedInput = document.getElementById('transitionSpeed');
    const transitionTypeSelect = document.getElementById('transitionType');
    const displayTimeVal = document.getElementById('displayTimeVal');
    const transitionSpeedVal = document.getElementById('transitionSpeedVal');

    let photos = [];
    let index = 0;
    let active = layerA;
    let idle = layerB;
    let holdTimer = null;
    let transitionTimer = null;
    let menuHideTimer = null;
    let running = false;
    let transitioning = false;

    function getDisplayMs() {
      return Number(displayTimeInput.value) * 1000;
    }

    function getTransitionMs() {
      return Math.round(Number(transitionSpeedInput.value) * 1000);
    }

    function resolveTransitionType() {
      const choice = transitionTypeSelect.value;
      if (choice === 'random') {
        return RANDOM_TYPES[Math.floor(Math.random() * RANDOM_TYPES.length)];
      }
      return choice;
    }

    function applyTransitionTiming(out, inn, type, duration) {
      const ms = duration + 'ms';
      out.style.transitionDuration = ms;
      inn.style.transitionDuration = ms;
      out.style.transitionTimingFunction = '';
      inn.style.transitionTimingFunction = '';
      if (type === 'bounce') {
        inn.style.transitionTimingFunction = 'cubic-bezier(0.34, 1.45, 0.64, 1)';
      } else if (type === 'smash') {
        inn.style.transitionTimingFunction = 'cubic-bezier(0.2, 0.9, 0.2, 1)';
      }
    }

    function finishSwap(out, inn, nextIndex) {
      resetLayer(out, true);
      resetLayer(inn, false);
      active = inn;
      idle = out;
      index = nextIndex;
      scheduleHold();
    }

    function updateLabels() {
      displayTimeVal.textContent = displayTimeInput.value + 's';
      transitionSpeedVal.textContent = Number(transitionSpeedInput.value).toFixed(1) + 's';
    }

    function clearTimers() {
      clearTimeout(holdTimer);
      clearTimeout(transitionTimer);
      holdTimer = null;
      transitionTimer = null;
    }

    function resetLayer(el, off) {
      el.className = off ? 'layer off' : 'layer';
      el.style.transitionDuration = '';
    }

    function waitMs(ms) {
      return new Promise((resolve) => {
        transitionTimer = setTimeout(resolve, ms + 50);
      });
    }

    function showMenu() {
      menu.classList.add('visible');
      clearTimeout(menuHideTimer);
      menuHideTimer = setTimeout(() => menu.classList.remove('visible'), 5000);
    }

    function scheduleMenuHide() {
      showMenu();
    }

    function setPhotoList(list) {
      photos = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
      if (!photos.length) {
        running = false;
        clearTimers();
        emptyEl.classList.add('visible');
        layerA.removeAttribute('src');
        layerB.removeAttribute('src');
        resetLayer(layerA, true);
        resetLayer(layerB, true);
        return;
      }
      emptyEl.classList.remove('visible');
      if (index >= photos.length) index = 0;
      if (!running) {
        running = true;
        active.src = photos[index].url;
        active.alt = photos[index].filename;
        resetLayer(active, false);
        resetLayer(idle, true);
      }
      if (photos.length >= 2) scheduleHold();
    }

    function preload(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = url;
      });
    }

    function scheduleHold() {
      clearTimeout(holdTimer);
      if (photos.length < 2) return;
      holdTimer = setTimeout(advanceSlide, getDisplayMs());
    }

    async function advanceSlide() {
      if (transitioning || photos.length < 2) return;
      transitioning = true;
      clearTimeout(holdTimer);
      holdTimer = null;

      const nextIndex = (index + 1) % photos.length;
      const next = photos[nextIndex];
      const type = resolveTransitionType();
      const duration = getTransitionMs();

      try {
        try {
          await preload(next.url);
        } catch (_) {
          scheduleHold();
          return;
        }

        const out = active;
        const inn = idle;

        inn.src = next.url;
        inn.alt = next.filename;

        if (type === 'none') {
          finishSwap(out, inn, nextIndex);
          return;
        }

        if (type === 'static') {
          stage.classList.add('static-on');
          await waitMs(Math.round(duration * 0.5));
          finishSwap(out, inn, nextIndex);
          await waitMs(Math.round(duration * 0.5));
          stage.classList.remove('static-on');
          return;
        }

        out.className = 'layer from ' + type;
        inn.className = 'layer to ' + type;
        applyTransitionTiming(out, inn, type, duration);

        void out.offsetWidth;
        out.classList.add('animate');
        inn.classList.add('animate');

        await waitMs(duration);
        finishSwap(out, inn, nextIndex);
      } finally {
        transitioning = false;
      }
    }

    function applySettings() {
      updateLabels();
      if (!photos.length) return;
      transitioning = false;
      clearTimers();
      active = layerA;
      idle = layerB;
      active.src = photos[index].url;
      active.alt = photos[index].filename;
      resetLayer(active, false);
      resetLayer(idle, true);
      idle.removeAttribute('src');
      stage.classList.remove('static-on');
      if (photos.length >= 2) scheduleHold();
    }

    async function loadPhotos() {
      const res = await fetch('/slideshow/photos');
      const data = await res.json();
      setPhotoList(data.photos || []);
    }

    displayTimeInput.addEventListener('input', () => { scheduleMenuHide(); applySettings(); });
    transitionSpeedInput.addEventListener('input', () => { scheduleMenuHide(); applySettings(); });
    transitionTypeSelect.addEventListener('change', () => { scheduleMenuHide(); applySettings(); });
    menu.addEventListener('input', scheduleMenuHide);
    menu.addEventListener('click', scheduleMenuHide);
    menu.addEventListener('focusin', scheduleMenuHide);
    document.addEventListener('mousemove', scheduleMenuHide);

    const watch = new EventSource('/watch?initial=0');
    watch.addEventListener('photo', () => { void loadPhotos(); });

    updateLabels();
    void loadPhotos();
  </script>
</body>
</html>`;
