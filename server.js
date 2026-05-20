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
    .sync {
      background: #e5e7eb;
      color: #111;
    }
    #status {
      min-height: 1.25rem;
      font-size: 0.9rem;
      margin-top: 0.75rem;
      color: #374151;
    }
    #status.ok { color: #047857; }
    #status.err { color: #b91c1c; }
    #preview {
      display: none;
      width: 100%;
      border-radius: 8px;
      margin-top: 0.75rem;
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
      <li>Each photo is uploaded immediately to this server.</li>
      <li>Use <strong>Sync photos</strong> on another device to download new photos as a ZIP (already downloaded photos are skipped via cookies).</li>
      <li>On a desktop, open <a href="/receiver">Live receiver</a> to auto-download photos as they arrive.</li>
    </ol>
  </div>
  <div class="card">
    <button type="button" id="takeBtn">Take fotos</button>
    <input type="file" id="cameraInput" accept="image/*" capture="environment">
    <img id="preview" alt="Last capture preview">
    <p id="status"></p>
  </div>
  <div class="card">
    <a class="btn sync" href="/sync">Sync photos (download ZIP)</a>
  </div>
  <script>
    const takeBtn = document.getElementById('takeBtn');
    const input = document.getElementById('cameraInput');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');

    function setStatus(msg, type) {
      status.textContent = msg;
      status.className = type || '';
    }

    async function uploadFile(file) {
      const fd = new FormData();
      fd.append('photo', file, file.name || 'photo.jpg');
      const res = await fetch('/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || 'Upload failed');
      return data;
    }

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;

      takeBtn.disabled = true;
      setStatus('Uploading…');
      preview.style.display = 'none';

      try {
        const url = URL.createObjectURL(file);
        preview.src = url;
        preview.onload = () => URL.revokeObjectURL(url);
        preview.style.display = 'block';

        const result = await uploadFile(file);
        setStatus('Uploaded: ' + result.filename, 'ok');
      } catch (e) {
        setStatus(e.message || 'Upload failed', 'err');
      } finally {
        takeBtn.disabled = false;
      }
    });

    takeBtn.addEventListener('click', () => input.click());
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
