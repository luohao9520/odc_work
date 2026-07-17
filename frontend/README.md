# Frontend

`frontend/` contains the browser-facing assets for the app. The project currently uses vanilla HTML, CSS, and JavaScript, served by Flask from the backend.

## Layout

```text
frontend/
├─ templates/          # HTML pages served at / and /*.html
└─ static/             # CSS, JavaScript, icons, manifest and service worker source files
```

## Runtime paths

Even though files live under `frontend/`, the browser-facing URLs are kept stable:

- HTML pages: `/`, `/index.html`, `/holidays.html`, `/seat-booking.html`, `/login.html`, `/api-docs.html`, `/offline.html`
- Static assets: `/static/*`
- PWA manifest: `/manifest.webmanifest`
- Service worker: `/service-worker.js`
- API calls: `/api/*`

## Development notes

- `frontend/static/js/app.js` exposes CommonJS exports for `tests/test_frontend_logic.js`; keep those exports when refactoring.
- `frontend/templates` and `frontend/static` are the only frontend source directories.
- If a future React/Vue/Vite migration is introduced, preserve the existing API route contract or add an explicit API base URL and CORS/session strategy.

## Local checks

```powershell
Set-Location "C:\Users\45498415\DataCode\Other\ODC"
node --check .\frontend\static\js\app.js
node .\tests\test_frontend_logic.js
```
