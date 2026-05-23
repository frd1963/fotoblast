# Fotoblast

Self-contained Node.js web app for capturing photos in the browser, storing them locally, and syncing new photos as a ZIP.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload an image (`multipart/form-data`, field name `photo`) |
| `GET` | `/ui` | Camera UI with **Take fotos** button |
| `GET` | `/sync` | Download ZIP of photos not yet downloaded on this browser (tracked via cookie) |
| `GET` | `/watch` | **Server-Sent Events** — push stream of new uploads (add `?initial=0` to only receive future photos) |
| `GET` | `/photos/:filename` | Download a single stored photo |
| `GET` | `/receiver` | Browser page that connects to `/watch` and auto-downloads incoming photos |
| `GET` | `/slideshow` | Full-screen photo slideshow |
| `GET` | `/thumbnails` | Grid of photo thumbnails with checkboxes to include or exclude from the slideshow |
| `GET` | `/thumbnails/photos` | JSON list of all photos with `included` flag for slideshow |
| `PUT` | `/thumbnails/selection` | Save slideshow selection (`{ "excluded": ["filename.jpg", ...] }`) |
| `GET` | `/health` | Health check and photo count |

## Run with Docker

```bash
docker build -t fotoblast .
docker run --rm -p 3000:3000 -v fotoblast-data:/app/repo fotoblast
```

Open http://localhost:3000/ui on a phone or desktop.

## Run locally

```bash
npm install
npm start
```

Photos are stored in `./repo` by default.

## Live auto-download

Browsers cannot hold an HTTP download open forever, but they **can** keep a lightweight SSE connection open to `/watch`. When someone uploads a photo, every connected client gets a `photo` event and can fetch `/photos/<filename>` immediately.

Open `/receiver` on the machine that should collect photos (e.g. a laptop). Leave the tab open; uploads from phones on `/ui` trigger downloads on the receiver.

Use **Choose save folder…** on the receiver page to write auto-saved photos into a specific directory via the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API). This does not change the browser’s default Downloads location; if no folder is chosen, files fall back to normal Downloads behavior.

**Note:** Folder picking works in Chromium desktop browsers (Chrome, Edge). Without it, or if automatic Downloads are blocked, use the log links or `/sync` for a batch ZIP.

### Custom client

```javascript
const es = new EventSource('/watch?initial=0');
es.addEventListener('photo', (e) => {
  const { filename, url } = JSON.parse(e.data);
  // fetch(url) and save filename...
});
```

## Sync behavior

Each browser keeps a `synced_photos` cookie listing filenames already included in a prior `/sync` download. Calling `/sync` again only adds photos that are not in that list. Returns `204 No Content` when there is nothing new to download.
