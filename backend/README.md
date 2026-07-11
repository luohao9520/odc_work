# Backend

`backend/app` is the canonical Flask backend package.

## Layout

```text
backend/app/
├── main.py                # Flask app factory, blueprint registration, page/PWA routes
├── core/                  # Configuration, database, crypto and other infrastructure
├── shared/                # Shared utilities such as dates, calendars, proxy and HTTP helpers
├── domain/                # Pure domain logic, e.g. attendance calculations
├── modules/               # Business modules and Flask blueprints
├── integrations/          # External system clients
└── jobs/                  # Background jobs and schedulers
```

## Import rules

- New backend code should import from `backend.app.*`.
- Do not add new backend code outside `backend/app`.
- Keep public HTTP routes stable: `/api/*`, `/pages/*`, `/static/*`, `/manifest.webmanifest`, and `/service-worker.js`.

Local checks

```powershell
Set-Location "C:\Users\45490415\Data\Code\Other\OPC"
python -m pip install -q .\backend .\tests .\scripts .\run.py
python -m unittest tests.test_backend tests.test_init_db tests.test_run_config
```