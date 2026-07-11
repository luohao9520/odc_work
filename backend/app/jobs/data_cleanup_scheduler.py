from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any

from flask import Flask

from ..core.database import get_db
from ..domain.retention.cleanup import get_cleanup_settings, run_data_cleanup, scheduled_cleanup_due
from .seat_booking_scheduler import FALSY, TRUTHY

SCHEDULER_NAME = "data_cleanup"
DEFAULT_ENABLED = True
DEFAULT_INTERVAL_SECONDS = 3600
DEFAULT_LEASE_SECONDS = 3300

_state: dict[str, Any] = {
    "enabled": False,
    "running": False,
    "intervalSeconds": DEFAULT_INTERVAL_SECONDS,
    "lastRunAt": None,
    "lastMessage": "未启用",
    "threadName": None,
}
_thread: threading.Thread | None = None
_thread_lock = threading.Lock()


def env_enabled(env: dict[str, str] | None = None) -> bool:
    env = env or os.environ
    configured = env.get("DATA_CLEANUP_SCHEDULER_ENABLED")
    if configured is None:
        configured = env.get("ATTENDANCE_DATA_CLEANUP_SCHEDULER")
    if configured is None or str(configured).strip() == "":
        return DEFAULT_ENABLED
    normalized = str(configured).strip().lower()
    if normalized in FALSY:
        return False
    return normalized in TRUTHY


def env_interval(env: dict[str, str] | None = None) -> int:
    env = env or os.environ
    try:
        return max(60, int(env.get("DATA_CLEANUP_SCHEDULER_INTERVAL", DEFAULT_INTERVAL_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_SECONDS


def configured_enabled(app: Flask) -> bool:
    configured = app.config.get("DATA_CLEANUP_SCHEDULER_ENABLED")
    if configured is not None:
        if isinstance(configured, str):
            return configured.strip().lower() in TRUTHY
        return bool(configured)
    return env_enabled()


def configured_interval(app: Flask) -> int:
    configured = app.config.get("DATA_CLEANUP_SCHEDULER_INTERVAL")
    if configured is not None:
        try:
            return max(60, int(configured))
        except (TypeError, ValueError):
            return DEFAULT_INTERVAL_SECONDS
    return env_interval()


def try_acquire_cleanup_lease(lease_seconds: int = DEFAULT_LEASE_SECONDS, now: datetime | None = None) -> bool:
    now = now or datetime.now()
    locked_until = (now + timedelta(seconds=lease_seconds)).replace(microsecond=0).isoformat()
    now_text = now.replace(microsecond=0).isoformat()
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT locked_until FROM secret_booking_scheduler_state WHERE name = ?", (SCHEDULER_NAME,)).fetchone()
    if row and row["locked_until"] > now_text:
        db.rollback()
        return False
    db.execute(
        "INSERT INTO secret_booking_scheduler_state(name, locked_until, updated_at) VALUES (?, ?, ?)"
        "ON CONFLICT (name) DO UPDATE SET locked_until = excluded.locked_until, updated_at = excluded.updated_at",
        (SCHEDULER_NAME, locked_until, now_text)
    )
    db.commit()
    return True


def scheduler_status() -> dict[str, Any]:
    status = dict(_state)
    status["envEnabled"] = env_enabled()
    try:
        settings = get_cleanup_settings()
        status["scheduledEnabled"] = settings["scheduledEnabled"]
        status["lastRunAt"] = settings.get("lastRunAt") or status.get("lastRunAt")
        status["lastMessage"] = settings.get("lastMessage") or status.get("lastMessage")
    except Exception:  # pragma: no cover - status must not break page rendering
        pass
    return status


def _scheduler_loop(app: Flask, interval_seconds: int) -> None:
    with app.app_context():
        _state.update({"enabled": True, "running": True, "intervalSeconds": interval_seconds, "threadName": threading.current_thread().name, "lastMessage": "运行中，等待清理开关"})
    while True:
        try:
            with app.app_context():
                settings = get_cleanup_settings()
                if not scheduled_cleanup_due(settings):
                    message = "清理开关未启用或已执行"
                elif try_acquire_cleanup_lease(lease_seconds=max(DEFAULT_LEASE_SECONDS, interval_seconds - 60)):
                    result = run_data_cleanup(dry_run=False, vacuum=True)
                    message = result["message"]
                else:
                    message = "其他进程持有清理锁，未释放"
                    _state.update({"running": True, "lastRunAt": datetime.now().replace(microsecond=0).isoformat(), "lastMessage": message})
        except Exception as exc:  # pragma: no cover - defensive guard for long-running service
            _state.update({"running": False, "lastRunAt": datetime.now().replace(microsecond=0).isoformat(), "lastMessage": f"清理调度异常: {exc}"})
        time.sleep(interval_seconds)


def start_data_cleanup_scheduler(app: Flask) -> bool:
    global _thread
    interval_seconds = configured_interval(app)
    if not configured_enabled(app) or app.config.get("TESTING"):
        _state.update({"enabled": False, "running": False, "intervalSeconds": interval_seconds, "lastMessage": "未启用"})
        return False
    with _thread_lock:
        if _thread and _thread.is_alive():
            return True
        _thread = threading.Thread(target=_scheduler_loop, args=(app, interval_seconds), name="data_cleanup_scheduler", daemon=True)
        _thread.start()
        _state.update({"enabled": True, "running": True, "intervalSeconds": interval_seconds, "threadName": _thread.name, "lastMessage": "已启动，等待清理开关"})
        return True
