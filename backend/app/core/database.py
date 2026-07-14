from __future__ import annotations

import sqlite3

from flask import current_app, g

# `attendance.source`  记录一条登记由谁产生：
# - manual：用户点击日期卡片产生，不能被智能/批量设置覆盖。
# - bulk：由“工作日全设为公司”产生，后续可以重新生成
# - smart： 由智能排班产生，后续可以重新生成。
# 使用简单文本列可以避免额外的元数据表，同时仍能存在 SQL upsert 中通过
# `WHERE source != 'manual'` 保护手动选择
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    deactivated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    target_rate INTEGER NOT NULL DEFAULT 60,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_page_permissions (
    user_id INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    PRIMARY KEY(user_id, page_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance (
    user_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('office', 'home', 'leave')),
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY(user_id, work_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS overtime (
    user_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    hours REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, work_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS holidays (
    user_id INTEGER NOT NULL,
    holiday_date TEXT NOT NULL,
    name TEXT NOT NULL,
    is_holiday INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, holiday_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS holiday_syncs (
    user_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, year),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS seat_booking_settings (
    user_id INTEGER PRIMARY KEY,
    external_username TEXT NOT NULL DEFAULT '',
    external_password TEXT NOT NULL DEFAULT '',
    booking_date TEXT NOT NULL DEFAULT '',
    preferred_seat_id TEXT NOT NULL DEFAULT '',
    preferred_seat_name TEXT NOT NULL DEFAULT '',
    booking_time TEXT NOT NULL DEFAULT '08:30',
    advance_days INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS seat_booking_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    seat_id TEXT NOT NULL,
    seat_name TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    run_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS seat_booking_plans (
    user_id INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    seat_id TEXT NOT NULL DEFAULT '',
    seat_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, booking_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS seat_booking_scheduler_state (
    name TEXT PRIMARY KEY,
    locked_until TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_cleanup_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    scheduled_enabled INTEGER NOT NULL DEFAULT 0,
    attendance_retention_months INTEGER NOT NULL DEFAULT 12,
    overtime_retention_months INTEGER NOT NULL DEFAULT 12,
    seat_booking_plan_retention_months INTEGER NOT NULL DEFAULT 6,
    seat_booking_run_retention_months INTEGER NOT NULL DEFAULT 3,
    updated_at TEXT NOT NULL,
    last_run_at TEXT,
    last_message TEXT
);
"""


def get_db() -> sqlite3.Connection:
    if "attendance_db" not in g:
        conn = sqlite3.connect(current_app.config["DATABASE"])
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.attendance_db = conn
    return g.attendance_db


def close_db(error=None) -> None:
    conn = g.pop("attendance_db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    db = get_db()
    db.executescript(SCHEMA_SQL)
    user_columns = {row["name"] for row in db.execute("PRAGMA table_info(users)").fetchall()}
    if "role" not in user_columns:
        db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
    if "is_active" not in user_columns:
        db.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
    if "deactivated_at" not in user_columns:
        db.execute("ALTER TABLE users ADD COLUMN deactivated_at TEXT")
    db.execute("UPDATE users SET role = 'admin' WHERE lower(username) = 'luohao'")
    attendance_columns = {row["name"] for row in db.execute("PRAGMA table_info(attendance)").fetchall()}
    if "source" not in attendance_columns:
        db.execute("ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    seat_booking_columns = {row["name"] for row in db.execute("PRAGMA table_info(seat_booking_settings)").fetchall()}
    if "advance_days" not in seat_booking_columns:
        db.execute("ALTER TABLE seat_booking_settings ADD COLUMN advance_days INTEGER NOT NULL DEFAULT 0")
    db.execute(
        "INSERT OR IGNORE INTO data_cleanup_settings "
        "(id, scheduled_enabled, attendance_retention_months, overtime_retention_months, "
        "seat_booking_plan_retention_months, seat_booking_run_retention_months, updated_at) "
        "VALUES (1, 0, 12, 12, 6, 3, datetime('now'))"
    )
    db.commit()

