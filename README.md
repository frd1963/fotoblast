# Fotoblast

Self-contained Node.js web app for capturing photos in the browser, storing them locally, and syncing new photos as a ZIP.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload an image (`multipart/form-data`, field name `photo`) |
| `GET` | `/ui` | Camera UI with **Take fotos** button |
| `GET` | `/sync` | Download ZIP of photos not yet downloaded on this browser (tracked via cookie) |
| `GET` | `/download` | Download ZIP of **all** photos in the repo (no cookie tracking) |
| `GET` | `/watch` | **Server-Sent Events** — push stream of new uploads (add `?initial=0` to only receive future photos) |
| `GET` | `/photos/:filename` | Download a single stored photo |
| `GET` | `/receiver` | Browser page that connects to `/watch` and auto-downloads incoming photos |
| `GET` | `/slideshow` | Full-screen photo slideshow (supports query params below) |
| `GET` | `/demo` | Split view: camera UI + slideshow (top/bottom when tall, side-by-side when wide; reflows on rotate/resize) |
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

### Build multiarch image for Docker Hub

To build and push a multiarch image supporting both `linux/amd64` and `linux/arm64`:

```bash
# Set up a multiarch builder (one-time only)
docker buildx create --name multiarch-builder
docker buildx use multiarch-builder

# Build and push
docker buildx build --platform linux/amd64,linux/arm64 -t frd1963/fotoblast:latest --push .
```

Replace `frd1963/fotoblast:latest` with your own registry and tag. The `--push` flag uploads to Docker Hub; omit it to build locally if your buildx builder supports it.

### Rebuild, push, and run locally

```bash
./scripts/rebuild-and-run.sh
```

Stops any container named `fotoblast`, builds/pushes the multiarch image, pulls it, and runs it on port 3000.

Useful overrides:

```bash
PUSH=0 ./scripts/rebuild-and-run.sh                          # current arch only, no push
IMAGE=frd1963/fotoblast:multiarch ./scripts/rebuild-and-run.sh
EVENT_NAME=smith-wedding PORT=8080 ./scripts/rebuild-and-run.sh
```

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

## Slideshow query parameters

Open `/slideshow` with optional settings in the URL. Omitted params keep the page defaults.

| Parameter | Aliases | Values | Default |
|-----------|---------|--------|---------|
| `display` | `displayTime` | `1`–`30` (seconds per photo) | `5` |
| `transitionSpeed` | `speed` | `0.1`–`10` (seconds) | `0.8` |
| `transitions` | — | Comma-separated transition ids, `all`, or `none` | none selected (instant cut) |
| `kenBurns` | `kb` | `1`/`0`, `true`/`false` | `false` |
| `kenBurnsZoom` | `kbZoom` | `1`/`0`, `true`/`false` | `false` (zoom in during motion) |
| `kenBurnsDir` | `kbDir` | `up`, `down`, `left`, `right`, `up-left`, `up-right`, `down-left`, `down-right` (comma-separated), `all`, `auto`, or `none` | `auto` (path chosen from each photo’s aspect ratio) |
| `qr` | `qrShow` | `1`/`0`, `true`/`false`, `on`/`off` | `true` |
| `qrCorner` | — | `tl`, `tr`, `bl`, `br` | `bl` |
| `qrSize` | — | `smallest`, `small`, `medium`, `large` | `smallest` (adapts to screen; minimum reliably scannable size) |
| `qrBrandImage` | — | `none`, `fotoblast`, `custom` | `fotoblast` |
| `qrBrand` | `qrLabel` | Text, max 48 chars | `FotoBlast` |
| `showEventName` | `eventName` | `1`/`0`, `true`/`false` | `false` (shows banner text when enabled) |
| `eventNameText` | `bannerText` | Banner text string (max 120 chars) | `EVENT_NAME` display name |
| `eventNameFont` | `bannerFont` | See font list below | `system` |
| `eventNameSize` | `bannerSize` | `2`–`100` (% of screen height); also accepts legacy `small`/`medium`/`large`/`xlarge` | `6` |
| `eventNamePosX` | `bannerPosX` | `0`–`100` (% from left; text centered on point) | `50` |
| `eventNamePosY` | `bannerPosY` | `0`–`100` (% from top; `0` top, `100` bottom) | `5` |
| `eventNameColor` | `bannerColor` | `#RRGGBB` | `#f8fafc` |
| `eventNameOutline` | `bannerOutline` | `1`/`0`, `true`/`false` | `false` |
| `eventNameOutlineColor` | `bannerOutlineColor` | `#RRGGBB` | `#000000` |
| `eventNameOutlineSize` | `bannerOutlineSize` | `1`–`16` (relative; scales with text size) | `2` |
| `eventNameShadow` | `bannerShadow` | `1`/`0`, `true`/`false` | `true` |
| `eventNameShadowDist` | `bannerShadowDist` | `0`–`24` (relative; scales with text size) | `4` |
| `eventNameShadowBlur` | `bannerShadowBlur` | `0`–`24` (relative; scales with text size) | `2` |
| `eventNameShadowDir` | `bannerShadowDir` | `0`–`359` (degrees; `0` right, `90` down) | `90` |
| `eventNameScroll` | `bannerScroll` | `1`/`0`, `true`/`false` | `false` |
| `eventNameWrap` | `bannerWrap` | `1`/`0`, `true`/`false` (viewport edge wrap while scrolling) | `true` |
| `eventNameScrollDir` | `bannerScrollDir` | `0`–`359` (degrees; travel direction; `180` left) | `180` |
| `eventNameScrollSpeed` | `bannerScrollSpeed` | `1`–`10` (10 is very fast) | `5` |
| `fullscreen` | — | `1`/`0`, `true`/`false` | `false` (if blocked, a hint appears after 5s or on click) |

Event name fonts:

- Clean: `system`, `montserrat`, `oswald`, `bebas`, `roboto-slab`
- Elegant: `playfair`, `cormorant`, `cinzel`, `libre-baskerville`, `merriweather`, `great-vibes`, `parisienne`
- Playful: `dancing`, `pacifico`, `lobster`, `fredoka`, `comfortaa`, `comic-neue`, `bubblegum`, `caveat`, `permanent-marker`, `bangers`

Transition ids include: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom-in`, `zoom-out`, `blur`, `scan`, `rotate`, `flip-h`, `flip-v`, `wipe-left`, `dissolve`, `push`, `fade-black`, `morph`, `shatter`, `static`, `tuner`, `smash`, `bounce`.

Example:

```text
/slideshow?display=8&speed=1.2&transitions=fade,blur,tuner&kenBurns=1&kenBurnsZoom=1&kenBurnsDir=left,right,up-left&qr=1&qrCorner=br&qrSize=large&qrBrand=Scan%20to%20share
```

## Sync behavior

Each browser keeps a `synced_photos` cookie listing filenames already included in a prior `/sync` download. Calling `/sync` again only adds photos that are not in that list. Returns `204 No Content` when there is nothing new to download.

Use `/download` to always get a ZIP of every photo currently in the repo (also `204` when empty).
