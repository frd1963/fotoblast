const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const REPO_DIR = process.env.REPO_DIR || path.join(__dirname, 'repo');
const ICONS_DIR = path.join(__dirname, 'icons');
let QRCodeLib;
try {
  QRCodeLib = require('qrcode');
} catch {
  QRCodeLib = null;
}
const SYNC_COOKIE = 'synced_photos';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const ICON_PUBLIC_NAMES = [
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'favicon-96x96.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
];

fs.mkdirSync(REPO_DIR, { recursive: true });

for (const name of ICON_PUBLIC_NAMES) {
  const filePath = path.join(ICONS_DIR, name);
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: missing icon ${name} at ${filePath}`);
  }
}

function sendIcon(res, name) {
  const filePath = path.join(ICONS_DIR, name);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  if (name.endsWith('.ico')) res.type('image/x-icon');
  else res.type('png');
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

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

for (const name of ICON_PUBLIC_NAMES) {
  app.get(`/${name}`, (_req, res) => sendIcon(res, name));
}

app.use(
  '/icons',
  express.static(ICONS_DIR, {
    maxAge: '7d',
    immutable: true,
    fallthrough: false,
  }),
);

app.get('/site.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.json({
    name: 'Fotoblast',
    short_name: 'Fotoblast',
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: '#4f46e5',
    background_color: '#ffffff',
    display: 'standalone',
  });
});

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

function slideshowDefaultPort(proto) {
  const p = String(proto || '').toLowerCase().replace(/:$/, '');
  return p === 'https' ? '443' : '80';
}

function hostWithPort(hostname, port, proto) {
  if (!hostname) return '';
  const p = String(port || '').trim();
  if (!p || p === slideshowDefaultPort(proto)) return hostname;
  if (hostname.includes(':')) return hostname;
  return `${hostname}:${p}`;
}

function slideshowRequestOrigin(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const hostHeader = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!hostHeader) return '';

  if (hostHeader.includes(':')) return `${proto}://${hostHeader}`;

  const portHint = req.get('x-forwarded-port') || req.query.port;
  const host = hostWithPort(hostHeader, portHint, proto);
  return `${proto}://${host}`;
}

function slideshowCameraUiUrl(req, override) {
  const portHint = typeof req.query.port === 'string' ? req.query.port : '';

  if (override) {
    try {
      const u = new URL(override);
      if (u.pathname === '/ui' || u.pathname === '/ui/') {
        const host = u.port ? u.host : hostWithPort(u.hostname, u.port || portHint, u.protocol);
        return `${u.protocol}//${host}/ui`;
      }
    } catch {
      /* use request origin */
    }
  }

  const origin = slideshowRequestOrigin(req);
  return origin ? `${origin}/ui` : '/ui';
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

app.get('/slideshow/qr.png', async (req, res) => {
  if (!QRCodeLib) {
    res.status(503).type('text/plain').send('QR not available');
    return;
  }
  const w = Math.min(512, Math.max(64, Number(req.query.w) || 176));
  const ecRaw = String(req.query.ec || 'M').toUpperCase();
  const errorCorrectionLevel = ['L', 'M', 'Q', 'H'].includes(ecRaw) ? ecRaw : 'M';
  const target = slideshowCameraUiUrl(req, typeof req.query.url === 'string' ? req.query.url : '');
  try {
    const buf = await QRCodeLib.toBuffer(target, {
      type: 'png',
      width: w,
      margin: 1,
      errorCorrectionLevel,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});

app.get('/slideshow/photos', (_req, res) => {
  res.json({
    photos: listPhotos().map((filename) => {
      const stat = fs.statSync(path.join(REPO_DIR, filename));
      return {
        filename,
        url: `/photos/${encodeURIComponent(filename)}`,
        mtime: stat.mtimeMs,
      };
    }),
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

const FAVICON_LINK = `<link rel="icon" href="/favicon.ico" type="image/x-icon">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48x48.png">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">`;
const BRAND_LOGO_HTML =
  '<img class="brand-logo" src="/favicon-96x96.png" width="36" height="36" alt="">';

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>Fotoblast</title>
  ${FAVICON_LINK}
  <script>
    (function () {
      var k = 'fotoblast-theme', t = localStorage.getItem(k);
      if (t !== 'light' && t !== 'dark') {
        t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
  <style>
    * { box-sizing: border-box; }
    [data-theme="light"] {
      color-scheme: light;
      --bg: #f4f6fb;
      --bg-accent: radial-gradient(ellipse 120% 80% at 50% -20%, rgba(99, 102, 241, 0.12), transparent 55%);
      --surface: #ffffff;
      --surface-muted: #f1f5f9;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-text: #ffffff;
      --secondary: #e2e8f0;
      --secondary-text: #1e293b;
      --success: #059669;
      --danger: #dc2626;
      --code-bg: #f1f5f9;
      --link: #4f46e5;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b0f17;
      --bg-accent: radial-gradient(ellipse 120% 80% at 50% -20%, rgba(99, 102, 241, 0.18), transparent 55%);
      --surface: #151b26;
      --surface-muted: #1e2736;
      --border: #2a3544;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --accent-text: #ffffff;
      --secondary: #2a3544;
      --secondary-text: #e2e8f0;
      --success: #34d399;
      --danger: #f87171;
      --code-bg: #1e2736;
      --link: #818cf8;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      margin: 0;
      min-height: 100vh;
      line-height: 1.55;
      color: var(--text);
      background: var(--bg);
      background-image: var(--bg-accent);
      transition: background 0.2s ease, color 0.2s ease;
    }
    .app {
      max-width: 28rem;
      margin: 0 auto;
      padding: 1rem 1.1rem 2rem;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .brand { display: flex; align-items: center; gap: 0.65rem; min-width: 0; }
    .brand-mark {
      flex-shrink: 0;
      width: 2.25rem;
      height: 2.25rem;
      display: block;
      line-height: 0;
    }
    .brand-logo {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .brand h1 {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .theme-switch {
      display: flex;
      padding: 3px;
      border-radius: 10px;
      background: var(--surface-muted);
      border: 1px solid var(--border);
    }
    .theme-switch button {
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.35rem 0.55rem;
      border-radius: 7px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .theme-switch button[aria-pressed="true"] {
      background: var(--surface);
      color: var(--text);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.1rem 1.15rem;
      box-shadow: var(--shadow);
      margin-bottom: 0.85rem;
      transition: background 0.2s, border-color 0.2s;
    }
    .card-title {
      margin: 0 0 0.65rem;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    ol { margin: 0; padding-left: 1.15rem; color: var(--text); }
    li { margin-bottom: 0.4rem; }
    li:last-child { margin-bottom: 0; }
    button, .btn {
      display: inline-block;
      width: 100%;
      padding: 0.9rem 1rem;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: background 0.15s, transform 0.1s, opacity 0.15s;
    }
    button:active:not(:disabled) { transform: scale(0.98); }
    #takeBtn {
      background: var(--accent);
      color: var(--accent-text);
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35);
    }
    #takeBtn:hover:not(:disabled) { background: var(--accent-hover); }
    #takeBtn:disabled { opacity: 0.55; cursor: wait; box-shadow: none; }
    #status {
      min-height: 1.25rem;
      font-size: 0.88rem;
      margin-top: 0.75rem;
      color: var(--text-muted);
    }
    #status.ok { color: var(--success); }
    #status.err { color: var(--danger); }
    #clearBtn {
      background: var(--secondary);
      color: var(--secondary-text);
      margin-bottom: 0.75rem;
    }
    #clearBtn:hover:not(:disabled) { filter: brightness(0.96); }
    #clearBtn:disabled { opacity: 0.4; cursor: default; }
    #stackCard { display: none; }
    #stackCard.visible { display: block; }
    #photoStack {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }
    .stack-item {
      border-radius: 12px;
      overflow: hidden;
      background: var(--surface-muted);
      border: 1px solid var(--border);
    }
    .stack-item img {
      width: 100%;
      display: block;
      vertical-align: middle;
    }
    .stack-item .stack-label {
      font-size: 0.72rem;
      color: var(--text-muted);
      padding: 0.4rem 0.55rem 0.5rem;
      word-break: break-all;
    }
    input[type="file"] { display: none; }
    code {
      font-size: 0.85em;
      background: var(--code-bg);
      color: var(--text);
      padding: 0.12em 0.4em;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${BRAND_LOGO_HTML}</span>
        <h1>Fotoblast</h1>
      </div>
      <div class="theme-switch" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light">Light</button>
        <button type="button" data-theme-set="dark">Dark</button>
      </div>
    </header>
    <section class="card">
      <p class="card-title">How it works</p>
      <ol>
        <li id="howCapture">Tap <strong>Take fotos</strong> to open your device camera.</li>
        <li>Each photo is uploaded immediately.</li>
      </ol>
    </section>
    <section class="card">
      <p class="card-title">Capture</p>
      <button type="button" id="takeBtn">Take fotos</button>
      <input type="file" id="cameraInput" accept="image/*" capture="environment">
      <p id="status"></p>
    </section>
    <section class="card" id="stackCard">
      <p class="card-title">Recent uploads</p>
      <button type="button" id="clearBtn" disabled>Clear</button>
      <div id="photoStack"></div>
    </section>
  </div>
  <script>
    (function () {
      var KEY = 'fotoblast-theme';
      function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem(KEY, t);
        document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
          btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-set') === t ? 'true' : 'false');
        });
      }
      document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          applyTheme(btn.getAttribute('data-theme-set'));
        });
      });
      applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    })();

    const MAX_STACK = 25;
    const takeBtn = document.getElementById('takeBtn');
    const input = document.getElementById('cameraInput');
    const howCapture = document.getElementById('howCapture');
    const status = document.getElementById('status');
    const stackCard = document.getElementById('stackCard');
    const photoStack = document.getElementById('photoStack');
    const clearBtn = document.getElementById('clearBtn');

    function isMobileDevice() {
      return /Android|iPhone|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function applyCaptureMode() {
      const mobile = isMobileDevice();
      takeBtn.textContent = mobile ? 'Take fotos' : 'Select Photos';
      howCapture.innerHTML = mobile
        ? 'Tap <strong>Take fotos</strong> to open your device camera.'
        : 'Click <strong>Select Photos</strong> to choose one or more images.';
      if (mobile) {
        input.setAttribute('capture', 'environment');
        input.multiple = false;
      } else {
        input.removeAttribute('capture');
        input.multiple = true;
      }
    }

    function isImageFile(file) {
      if (!file) return false;
      if (file.type && file.type.startsWith('image/')) return true;
      if (file.name && /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif|tif?f)$/i.test(file.name)) return true;
      return !file.type;
    }

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
      const result = await uploadFile(imageFile);
      addToStack(result);
      return result;
    }

    async function processSelectedFiles(files) {
      const list = files.filter(isImageFile);
      if (!list.length) {
        setStatus('No image files selected', 'err');
        return;
      }

      takeBtn.disabled = true;
      let ok = 0;
      let fail = 0;
      const total = list.length;

      for (let i = 0; i < total; i++) {
        setStatus(total > 1 ? 'Uploading ' + (i + 1) + ' of ' + total + '…' : 'Uploading…');
        try {
          await processCapture(list[i]);
          ok++;
        } catch (e) {
          fail++;
          if (total === 1) {
            setStatus(e.message || 'Upload failed', 'err');
            takeBtn.disabled = false;
            return;
          }
        }
      }

      takeBtn.disabled = false;
      if (fail === 0) {
        setStatus('Uploaded: ' + ok + (ok === 1 ? ' photo' : ' photos'), 'ok');
      } else if (ok === 0) {
        setStatus('Upload failed', 'err');
      } else {
        setStatus('Uploaded ' + ok + ', failed ' + fail, 'err');
      }
    }

    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      void processSelectedFiles(files);
    });

    takeBtn.addEventListener('click', () => {
      if (typeof input.showPicker === 'function') {
        try {
          input.showPicker();
          return;
        } catch (_) {}
      }
      input.click();
    });
    clearBtn.addEventListener('click', clearStack);
    applyCaptureMode();
  </script>
</body>
</html>`;

const RECEIVER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Fotoblast Receiver</title>
  ${FAVICON_LINK}
  <script>
    (function () {
      var k = 'fotoblast-theme', t = localStorage.getItem(k);
      if (t !== 'light' && t !== 'dark') {
        t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
  <style>
    * { box-sizing: border-box; }
    [data-theme="light"] {
      color-scheme: light;
      --bg: #f4f6fb;
      --bg-accent: radial-gradient(ellipse 120% 80% at 50% -20%, rgba(99, 102, 241, 0.12), transparent 55%);
      --surface: #ffffff;
      --surface-muted: #f1f5f9;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --accent-text: #ffffff;
      --secondary: #e2e8f0;
      --secondary-text: #1e293b;
      --success: #059669;
      --danger: #dc2626;
      --code-bg: #f1f5f9;
      --link: #4f46e5;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.06);
      --nav-active: #eef2ff;
      --nav-active-text: #4338ca;
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b0f17;
      --bg-accent: radial-gradient(ellipse 120% 80% at 50% -20%, rgba(99, 102, 241, 0.18), transparent 55%);
      --surface: #151b26;
      --surface-muted: #1e2736;
      --border: #2a3544;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --accent-text: #ffffff;
      --secondary: #2a3544;
      --secondary-text: #e2e8f0;
      --success: #34d399;
      --danger: #f87171;
      --code-bg: #1e2736;
      --link: #818cf8;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 12px 32px rgba(0, 0, 0, 0.35);
      --nav-active: #1e1b4b;
      --nav-active-text: #a5b4fc;
    }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      margin: 0;
      min-height: 100vh;
      line-height: 1.55;
      color: var(--text);
      background: var(--bg);
      background-image: var(--bg-accent);
      transition: background 0.2s ease, color 0.2s ease;
    }
    .app {
      max-width: 36rem;
      margin: 0 auto;
      padding: 1rem 1.1rem 2rem;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .brand { display: flex; align-items: center; gap: 0.65rem; min-width: 0; }
    .brand-mark {
      flex-shrink: 0;
      width: 2.25rem;
      height: 2.25rem;
      display: block;
      line-height: 0;
    }
    .brand-logo {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .brand h1 {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .theme-switch {
      display: flex;
      padding: 3px;
      border-radius: 10px;
      background: var(--surface-muted);
      border: 1px solid var(--border);
    }
    .theme-switch button {
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.35rem 0.55rem;
      border-radius: 7px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .theme-switch button[aria-pressed="true"] {
      background: var(--surface);
      color: var(--text);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    }
    .nav {
      display: flex;
      gap: 0.35rem;
      margin-bottom: 1rem;
      padding: 0.25rem;
      border-radius: 12px;
      background: var(--surface-muted);
      border: 1px solid var(--border);
    }
    .nav-link {
      flex: 1;
      text-align: center;
      padding: 0.5rem 0.4rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;
      border-radius: 9px;
      transition: background 0.15s, color 0.15s;
    }
    .nav-link:hover { color: var(--text); }
    .nav-link.is-active {
      background: var(--nav-active);
      color: var(--nav-active-text);
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.1rem 1.15rem;
      box-shadow: var(--shadow);
      margin-bottom: 0.85rem;
      transition: background 0.2s, border-color 0.2s;
    }
    .card-title {
      margin: 0 0 0.65rem;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .card > p:first-of-type:not(.card-title) { margin-top: 0; color: var(--text-muted); }
    #state {
      font-weight: 600;
      margin: 0.75rem 0 0;
      padding: 0.55rem 0.7rem;
      border-radius: 10px;
      background: var(--surface-muted);
      border: 1px solid var(--border);
      font-size: 0.9rem;
    }
    #state.live { color: var(--success); border-color: rgba(5, 150, 105, 0.25); }
    #state.err { color: var(--danger); border-color: rgba(220, 38, 38, 0.25); }
    #log {
      margin: 0;
      padding: 0;
      list-style: none;
      max-height: 22rem;
      overflow: auto;
      font-size: 0.88rem;
    }
    #log li {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
      color: var(--text);
    }
    #log li:last-child { border-bottom: none; }
    #log a { color: var(--link); font-weight: 500; }
    label {
      display: flex;
      gap: 0.55rem;
      align-items: center;
      margin-top: 0.75rem;
      font-size: 0.9rem;
      color: var(--text);
      cursor: pointer;
    }
    label input { accent-color: var(--accent); }
    .folder-row { margin-top: 1rem; }
    .folder-row strong { font-size: 0.95rem; }
    #folderPath {
      font-size: 0.88rem;
      color: var(--text-muted);
      margin: 0.45rem 0 0;
      word-break: break-all;
    }
    .btn-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.65rem; }
    .btn {
      padding: 0.65rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      background: var(--accent);
      color: var(--accent-text);
      transition: background 0.15s, transform 0.1s;
    }
    .btn:hover:not(:disabled) { background: var(--accent-hover); }
    .btn:active:not(:disabled) { transform: scale(0.98); }
    .btn.secondary { background: var(--secondary); color: var(--secondary-text); box-shadow: none; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .hint { font-size: 0.82rem; color: var(--text-muted); margin: 0.55rem 0 0; line-height: 1.45; }
    code {
      font-size: 0.85em;
      background: var(--code-bg);
      color: var(--text);
      padding: 0.12em 0.4em;
      border-radius: 6px;
    }
    a { color: var(--link); }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${BRAND_LOGO_HTML}</span>
        <h1>Receiver</h1>
      </div>
      <div class="theme-switch" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light">Light</button>
        <button type="button" data-theme-set="dark">Dark</button>
      </div>
    </header>
    <nav class="nav" aria-label="Pages">
      <a class="nav-link" href="/ui">Camera</a>
      <a class="nav-link is-active" href="/receiver" aria-current="page">Receiver</a>
      <a class="nav-link" href="/slideshow">Slideshow</a>
    </nav>
    <section class="card">
      <p class="card-title">Connection</p>
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
    </section>
    <section class="card">
      <p class="card-title">Activity</p>
      <ul id="log"></ul>
    </section>
  </div>
  <script>
    (function () {
      var KEY = 'fotoblast-theme';
      function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem(KEY, t);
        document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
          btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-set') === t ? 'true' : 'false');
        });
      }
      document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          applyTheme(btn.getAttribute('data-theme-set'));
        });
      });
      applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    })();

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
  ${FAVICON_LINK}
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
      max-height: min(85vh, calc(100vh - 2rem));
      overflow-y: auto;
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
    .menu-btn {
      width: 100%;
      padding: 0.55rem 0.75rem;
      font-size: 0.85rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      background: #334155;
      color: #f8fafc;
      cursor: pointer;
    }
    .menu-btn:hover { background: #475569; }
    .menu-btn:disabled { opacity: 0.45; cursor: default; }
    .field-group-title {
      margin: 0.5rem 0 0.35rem;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: #e2e8f0;
      cursor: pointer;
    }
    .check-row input { accent-color: #6366f1; }
    .field input[type="text"] {
      width: 100%;
      padding: 0.4rem 0.5rem;
      border-radius: 6px;
      border: 1px solid #334155;
      background: #0f172a;
      color: #f8fafc;
      font-size: 0.85rem;
    }
    .qr-options.disabled { opacity: 0.45; pointer-events: none; }
    #qrOverlay {
      position: fixed;
      z-index: 18;
      pointer-events: none;
      padding: 1rem;
    }
    #qrOverlay[hidden] { display: none !important; }
    #qrOverlay.pos-tl { top: 0; left: 0; }
    #qrOverlay.pos-tr { top: 0; right: 0; left: auto; }
    #qrOverlay.pos-bl { bottom: 0; left: 0; top: auto; }
    #qrOverlay.pos-br { bottom: 0; right: 0; top: auto; left: auto; }
    .qr-card {
      background: rgba(255, 255, 255, 0.94);
      border-radius: 12px;
      padding: 0.6rem 0.7rem 0.45rem;
      box-shadow: 0 6px 28px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .qr-frame { position: relative; line-height: 0; }
    #qrCanvas { display: block; width: 100%; height: auto; }
    .qr-brand-custom { margin-top: 0.35rem; }
    .qr-brand-custom.hidden { display: none; }
    .qr-brand-custom label {
      display: block;
      font-size: 0.8rem;
      margin-bottom: 0.25rem;
      color: #cbd5e1;
    }
    .qr-brand-custom input[type="file"] {
      width: 100%;
      font-size: 0.75rem;
      color: #e2e8f0;
    }
    #qrOverlay.size-small .qr-card { width: 9.5rem; }
    #qrOverlay.size-medium .qr-card { width: 13rem; }
    #qrOverlay.size-large .qr-card { width: 17.5rem; }
    #qrOverlay.size-small #qrLabel { font-size: 0.8rem; }
    #qrOverlay.size-medium #qrLabel { font-size: 0.95rem; }
    #qrOverlay.size-large #qrLabel { font-size: 1.1rem; }
    #qrLabel {
      margin: 0.45rem 0 0;
      font-weight: 800;
      color: #0f172a;
      line-height: 1.2;
      word-break: break-word;
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
  <div id="qrOverlay" class="pos-bl size-medium" hidden>
    <div class="qr-card">
      <div class="qr-frame">
        <canvas id="qrCanvas" aria-label="QR code to open Camera UI"></canvas>
      </div>
      <p id="qrLabel">FotoBlast</p>
    </div>
  </div>
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
    <div class="field">
      <p class="field-group-title">QR code (Camera UI)</p>
      <label class="check-row">
        <input type="checkbox" id="qrShow" checked>
        Show QR code
      </label>
    </div>
    <div class="field qr-options" id="qrOptions">
      <label for="qrCorner">Corner</label>
      <select id="qrCorner">
        <option value="tl">Top left</option>
        <option value="tr">Top right</option>
        <option value="bl" selected>Bottom left</option>
        <option value="br">Bottom right</option>
      </select>
      <label for="qrSize">Size</label>
      <select id="qrSize">
        <option value="small">Small</option>
        <option value="medium" selected>Medium</option>
        <option value="large">Large</option>
      </select>
      <label for="qrBrandMode">Branding</label>
      <select id="qrBrandMode">
        <option value="fotoblast" selected>FotoBlast</option>
        <option value="custom">Custom image</option>
      </select>
      <div class="qr-brand-custom hidden" id="qrBrandCustom">
        <label for="qrBrandFile">Brand image file</label>
        <input type="file" id="qrBrandFile" accept="image/png,image/jpeg,image/webp,image/gif,image/*">
      </div>
      <label for="qrBrand">Label</label>
      <input type="text" id="qrBrand" placeholder="FotoBlast" maxlength="48" autocomplete="off">
    </div>
    <div class="field">
      <button type="button" id="fullscreenBtn" class="menu-btn">Fullscreen</button>
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
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const qrShow = document.getElementById('qrShow');
    const qrCorner = document.getElementById('qrCorner');
    const qrSize = document.getElementById('qrSize');
    const qrBrand = document.getElementById('qrBrand');
    const qrBrandMode = document.getElementById('qrBrandMode');
    const qrBrandCustom = document.getElementById('qrBrandCustom');
    const qrBrandFile = document.getElementById('qrBrandFile');
    const qrOptions = document.getElementById('qrOptions');
    const qrOverlay = document.getElementById('qrOverlay');
    const qrCanvas = document.getElementById('qrCanvas');
    const qrLabel = document.getElementById('qrLabel');

    const QR_DEFAULT_LABEL = 'FotoBlast';
    const QR_DEFAULT_ICON = '/icons/favicon-96x96.png';
    const QR_MARK_RATIO = 0.22;
    const QR_PIXEL = { small: 120, medium: 176, large: 240 };
    let qrBrandObjectUrl = null;

    let photos = [];
    let index = 0;
    const photoLastShown = new Map();
    const photoFirstSeen = new Map();
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

    function markPhotoShown(filename) {
      photoLastShown.set(filename, Date.now());
    }

    function prunePhotoTracking() {
      const names = new Set(photos.map((p) => p.filename));
      for (const key of photoLastShown.keys()) {
        if (!names.has(key)) photoLastShown.delete(key);
      }
      for (const key of photoFirstSeen.keys()) {
        if (!names.has(key)) photoFirstSeen.delete(key);
      }
    }

    function pickNextIndex(excludeCurrent) {
      if (!photos.length) return 0;
      if (photos.length === 1) return 0;

      const currentName = photos[index]?.filename;
      let candidates = photos.map((p, i) => ({ i, p }));
      if (excludeCurrent && currentName) {
        candidates = candidates.filter((c) => c.p.filename !== currentName);
      }
      if (!candidates.length) return index;

      const neverShown = candidates.filter((c) => !photoLastShown.has(c.p.filename));
      if (neverShown.length) {
        neverShown.sort((a, b) => {
          const aTime = photoFirstSeen.get(a.p.filename) || a.p.mtime || 0;
          const bTime = photoFirstSeen.get(b.p.filename) || b.p.mtime || 0;
          return aTime - bTime;
        });
        return neverShown[0].i;
      }

      candidates.sort(
        (a, b) => (photoLastShown.get(a.p.filename) || 0) - (photoLastShown.get(b.p.filename) || 0),
      );
      return candidates[0].i;
    }

    function finishSwap(out, inn, nextIndex) {
      resetLayer(out, true);
      resetLayer(inn, false);
      active = inn;
      idle = out;
      index = nextIndex;
      markPhotoShown(photos[index].filename);
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

    function getQrBrandLabel() {
      const text = qrBrand.value.trim();
      return text || QR_DEFAULT_LABEL;
    }

    function syncQrBrandFields() {
      const custom = qrBrandMode.value === 'custom';
      qrBrandCustom.classList.toggle('hidden', !custom);
      if (!custom && !qrBrand.value.trim()) qrBrand.placeholder = QR_DEFAULT_LABEL;
    }

    function getQrMarkSrc() {
      if (qrBrandMode.value === 'custom') return qrBrandObjectUrl;
      return QR_DEFAULT_ICON;
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }

    function drawImageCover(ctx, img, x, y, w, h) {
      const ir = img.naturalWidth / img.naturalHeight;
      const dr = w / h;
      let sw;
      let sh;
      let sx;
      let sy;
      if (ir > dr) {
        sh = img.naturalHeight;
        sw = sh * dr;
        sx = (img.naturalWidth - sw) / 2;
        sy = 0;
      } else {
        sw = img.naturalWidth;
        sh = sw / dr;
        sx = 0;
        sy = (img.naturalHeight - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }

    async function renderBrandedQr(canvas, qrUrl, markSrc) {
      const qrImg = await loadImage(qrUrl);
      const size = qrImg.naturalWidth;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(qrImg, 0, 0, size, size);
      if (!markSrc) return;

      const mark = await loadImage(markSrc);
      const markSize = Math.round(size * QR_MARK_RATIO);
      const pad = Math.max(4, Math.round(markSize * 0.14));
      const box = markSize + pad * 2;
      const bx = (size - box) / 2;
      const by = (size - box) / 2;
      const radius = Math.round(pad * 0.85);
      ctx.fillStyle = '#ffffff';
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(bx, by, box, box, radius);
        ctx.fill();
      } else {
        ctx.fillRect(bx, by, box, box);
      }
      drawImageCover(ctx, mark, bx + pad, by + pad, markSize, markSize);
    }

    function applyQrChrome() {
      const on = qrShow.checked;
      qrOptions.classList.toggle('disabled', !on);
      if (!on) {
        qrOverlay.hidden = true;
        return;
      }
      qrOverlay.hidden = false;
      qrOverlay.className = 'pos-' + qrCorner.value + ' size-' + qrSize.value;
    }

    async function updateQrOverlay() {
      applyQrChrome();
      syncQrBrandFields();
      if (!qrShow.checked) return;

      qrLabel.textContent = getQrBrandLabel();
      const px = QR_PIXEL[qrSize.value] || QR_PIXEL.medium;
      const uiUrl = location.protocol + '//' + location.host + '/ui';
      const markSrc = getQrMarkSrc();
      let qrSrc = '/slideshow/qr.png?w=' + px + '&url=' + encodeURIComponent(uiUrl);
      if (location.port) qrSrc += '&port=' + encodeURIComponent(location.port);
      if (markSrc) qrSrc += '&ec=H';

      try {
        await renderBrandedQr(qrCanvas, qrSrc, markSrc);
        qrLabel.textContent = getQrBrandLabel();
      } catch (_) {
        qrLabel.textContent = markSrc ? 'Could not load QR' : 'Choose a brand image';
      }
    }

    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function fullscreenSupported() {
      const el = document.documentElement;
      return !!(el.requestFullscreen || el.webkitRequestFullscreen);
    }

    function updateFullscreenBtn() {
      if (!fullscreenSupported()) {
        fullscreenBtn.disabled = true;
        fullscreenBtn.textContent = 'Fullscreen unavailable';
        return;
      }
      fullscreenBtn.disabled = false;
      fullscreenBtn.textContent = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
    }

    async function toggleFullscreen() {
      scheduleMenuHide();
      if (!fullscreenSupported()) return;
      try {
        if (isFullscreen()) {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else {
          const el = document.documentElement;
          if (el.requestFullscreen) await el.requestFullscreen();
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        }
      } catch (_) {}
      updateFullscreenBtn();
    }

    function setPhotoList(list) {
      const prevCurrent = photos[index];
      const prevNames = new Set(photos.map((p) => p.filename));
      const now = Date.now();

      photos = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
      for (const p of photos) {
        if (!prevNames.has(p.filename) && !photoFirstSeen.has(p.filename)) {
          photoFirstSeen.set(p.filename, now);
        }
      }
      prunePhotoTracking();

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

      if (prevCurrent) {
        const kept = photos.findIndex((p) => p.filename === prevCurrent.filename);
        index = kept >= 0 ? kept : 0;
      } else if (index >= photos.length) {
        index = 0;
      }

      if (!running) {
        running = true;
        index = pickNextIndex(false);
        active.src = photos[index].url;
        active.alt = photos[index].filename;
        markPhotoShown(photos[index].filename);
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

      const nextIndex = pickNextIndex(true);
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
      markPhotoShown(photos[index].filename);
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
    fullscreenBtn.addEventListener('click', () => { void toggleFullscreen(); });
    qrShow.addEventListener('change', () => { scheduleMenuHide(); void updateQrOverlay(); });
    qrCorner.addEventListener('change', () => { scheduleMenuHide(); void updateQrOverlay(); });
    qrSize.addEventListener('change', () => { scheduleMenuHide(); void updateQrOverlay(); });
    qrBrandMode.addEventListener('change', () => { scheduleMenuHide(); void updateQrOverlay(); });
    qrBrand.addEventListener('input', () => { scheduleMenuHide(); void updateQrOverlay(); });
    qrBrandFile.addEventListener('change', () => {
      scheduleMenuHide();
      if (qrBrandObjectUrl) URL.revokeObjectURL(qrBrandObjectUrl);
      qrBrandObjectUrl = null;
      const file = qrBrandFile.files && qrBrandFile.files[0];
      if (file) {
        qrBrandMode.value = 'custom';
        qrBrandObjectUrl = URL.createObjectURL(file);
      }
      syncQrBrandFields();
      void updateQrOverlay();
    });
    document.addEventListener('fullscreenchange', updateFullscreenBtn);
    document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);
    menu.addEventListener('input', scheduleMenuHide);
    menu.addEventListener('click', scheduleMenuHide);
    menu.addEventListener('focusin', scheduleMenuHide);
    document.addEventListener('mousemove', scheduleMenuHide);

    const watch = new EventSource('/watch?initial=0');
    watch.addEventListener('photo', () => { void loadPhotos(); });

    updateLabels();
    updateFullscreenBtn();
    syncQrBrandFields();
    void updateQrOverlay();
    void loadPhotos();
  </script>
</body>
</html>`;
