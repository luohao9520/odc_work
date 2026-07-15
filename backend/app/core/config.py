from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
TEMPLATE_DIR = FRONTEND_DIR / "templates"
STATIC_DIR = FRONTEND_DIR / "static"
INSTANCE_DIR = ROOT_DIR / "instances"
DATABASE = INSTANCE_DIR / "attendance.sqlite3"
PROXY_CONFIG = INSTANCE_DIR / "proxy.json"
SECRET_KEY = os.environ.get("ATTENDANCE_SECRET_KEY", "local-dev-attendance-secret")
VALID_STATUSES = {"office", "home", "leave"}
