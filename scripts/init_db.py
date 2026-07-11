from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

from werkzeug.security import generate_password_hash

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import create_app  # noqa: E402
from backend.app.core.config import DATABASE  # noqa: E402
from backend.app.core.database import get_db  # noqa: E402
from backend.app.modules.auth.routes import default_page_ids_for_role, replace_user_page_permissions, role_for_username  # noqa: E402
from backend.app.modules.holidays.routes import ensure_holidays_for_user  # noqa: E402
from backend.app.shared.calendar_utils import now_iso  # noqa: E402


def parse_args() -> argparse.Namespace:  # Ethan Luo
    parser = argparse.ArgumentParser(description="初始化考勤打卡系统 SQLite 数据库。")
    parser.add_argument("--reset", action="store_true", help="清空所有用户、出勤、节假日和同步配置数据。")
    parser.add_argument("--yes", action="store_true", help="--reset 时无需交互确认。")
    parser.add_argument("--username", help="可选：初始用户用户名。")
    parser.add_argument("--password", help="可选：初始用户密码，至少 6 位。")
    parser.add_argument("--sync-year", type=int, help="可选：为初始用户自动同步指定年份节假日与补班信息。")
    return parser.parse_args()


def reset_database() -> None:  # Ethan Luo
    db = get_db()
    existing_tables = {
        row["name"]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    for table in ("data_cleanup_settings", "seat_booking_scheduler_state", "seat_booking_runs", "seat_booking_plans", "seat_booking_settings", "holiday_sync", "holidays", "overtime", "attendances", "user_page_permissions", "settings", "users"):
        if table not in existing_tables:
            continue
        db.execute(f"DELETE FROM {table}")
    db.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('users', 'seat_booking_runs')"
    )
    db.commit()


def create_initial_user(username: str, password: str) -> int:  # Ethan Luo
    if len(username.strip()) < 3:
        raise ValueError("用户名至少 3 个字符。")
    if len(password) < 6:
        raise ValueError("密码至少 6 个字符。")

    db = get_db()
    normalized_username = username.strip()
    role = role_for_username(normalized_username)
    row = db.execute("SELECT id FROM users WHERE username = ?", (normalized_username,)).fetchone()
    if row:
        db.execute("UPDATE users SET role = ?, is_active = 1, deactivated_at = NULL WHERE id = ?", (role, row["id"]))
        replace_user_page_permissions(row["id"], default_page_ids_for_role(role), role, commit=False)
        db.commit()
        return row["id"]

    try:
        cur = db.execute(
            "INSERT INTO users(username, password_hash, created_at, role) VALUES (?, ?, ?, ?)",
            (normalized_username, generate_password_hash(password), now_iso(), role)
        )
        user_id = cur.lastrowid
        if user_id is None:
            raise ValueError("创建初始用户失败，未返回用户 ID。")
        db.execute("INSERT INTO settings(user_id, target_rate) VALUES (?, ?)", (user_id, 60))
        replace_user_page_permissions(user_id, default_page_ids_for_role(role), role, commit=False)
        db.commit()
        return user_id
    except sqlite3.IntegrityError as ex:
        raise ValueError("用户名已存在。") from ex


def main() -> int:  # Ethan Luo
    args = parse_args()
    app = create_app({"SEAT_BOOKING_SCHEDULER_ENABLED": False, "DATA_CLEANUP_SCHEDULER_ENABLED": False})
    print(f"数据库已初始化: {DATABASE}")

    if args.reset and not args.yes:
        print("清空数据需要同时提供 --reset --yes。", file=sys.stderr)
        return 2

    if bool(args.username) != bool(args.password):
        print("--username 和 --password 必须同时提供。", file=sys.stderr)
        return 2

    if args.reset:
        with app.app_context():
            reset_database()
        print("已清空所有用户、出勤、节假日和同步配置数据。")

    if args.username and args.password:
        with app.app_context():
            user_id = create_initial_user(args.username, args.password)
            print(f"初始用户已就绪: {args.username} (id={user_id})")
            if args.sync_year:
                ensure_holidays_for_user(user_id, args.sync_year)
                print(f"已为用户 {args.username} 初始化 {args.sync_year} 年节假日/补班信息。")
    elif args.sync_year:
        print("--sync-year 需要同时提供 --username 和 --password。", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
