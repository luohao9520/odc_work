from __future__ import annotations

from datetime import date
from flask import Blueprint, jsonify, request, session

from ...core.database import get_db
from ...shared.calendar_utils import build_year_calendar, fetch_china_holidays, now_iso, valid_date
from ..auth.routes import login_required

holidays_bp = Blueprint("holidays", __name__, url_prefix="/api")


def read_holidays_for_year(user_id: int, year: int) -> list[dict]:
    return [item for item in read_day_overrides_for_year(user_id, year) if item["isHoliday"]]


def read_workday_overrides_for_year(user_id: int, year: int) -> list[dict]:
    return [item for item in read_day_overrides_for_year(user_id, year) if not item["isHoliday"]]


def read_day_overrides_for_year(user_id: int, year: int) -> list[dict]:
    rows = get_db().execute(
        "SELECT holiday_date, name, is_holiday, source, updated_at FROM holidays "
        "WHERE user_id = ? AND holiday_date LIKE ? ORDER BY holiday_date",
        (user_id, f"{year}-%")
    ).fetchall()
    return [
        {
            "date": row["holiday_date"],
            "name": row["name"],
            "isHoliday": bool(row["is_holiday"]),
            "source": row["source"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def read_holiday_sync(user_id: int, year: int) -> dict | None:
    row = get_db().execute(
        "SELECT source, updated_at FROM holiday_syncs WHERE user_id = ? AND year = ?",
        (user_id, year)
    ).fetchone()
    if not row:
        return None
    return {"source": row["source"], "updatedAt": row["updated_at"]}


def ensure_holidays_for_user(user_id: int, year: int) -> None:
    count = get_db().execute(
        "SELECT COUNT(*) AS c FROM holidays WHERE user_id = ? AND holiday_date LIKE ?",
        (user_id, f"{year}-%")
    ).fetchone()
    if count and count["c"] > 0:
        return
    holidays, source = fetch_china_holidays(year)
    replace_holidays_for_year(user_id, year, holidays, source)


def replace_holidays_for_year(user_id: int, year: int, holidays: list[dict], source: str) -> None:
    db = get_db()
    db.execute("DELETE FROM holidays WHERE user_id = ? AND holiday_date LIKE ?", (user_id, f"{year}-%"))
    for item in holidays:
        iso_date = item["date"]
        if valid_date(iso_date) and iso_date.startswith(f"{year}-"):
            is_holiday = bool(item.get("isHoliday", True))
            db.execute(
                "INSERT INTO holidays(user_id, holiday_date, name, is_holiday, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, iso_date, item.get("name") or ("节假日" if is_holiday else "补班"), 1 if is_holiday else 0, source, now_iso())
            )
    db.execute(
        "INSERT INTO holiday_syncs(user_id, year, source, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id, year) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at",
        (user_id, year, source, now_iso())
    )
    db.commit()


def copy_holidays_between_users(source_user_id: int, target_user_id: int, year: int, source_label: str) -> int:
    db = get_db()
    rows = db.execute(
        "SELECT holiday_date, name, is_holiday FROM holidays WHERE user_id = ? AND holiday_date LIKE ? ORDER BY holiday_date",
        (source_user_id, f"{year}-%")
    ).fetchall()
    db.execute("DELETE FROM holidays WHERE user_id = ? AND holiday_date LIKE ?", (target_user_id, f"{year}-%"))
    for row in rows:
        db.execute(
            "INSERT INTO holidays(user_id, holiday_date, name, is_holiday, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (target_user_id, row["holiday_date"], row["name"], row["is_holiday"], source_label, now_iso())
        )
    db.execute(
        "INSERT INTO holiday_syncs(user_id, year, source, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id, year) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at",
        (target_user_id, year, source_label, now_iso())
    )
    db.commit()
    return len(rows)


@holidays_bp.get("/holiday-source-users")
@login_required
def get_holiday_source_users():
    year = int(request.args.get("year", date.today().year))
    current_user_id = session["user_id"]
    rows = get_db().execute(
        "SELECT u.id, u.username, COUNT(h.holiday_date) AS override_count "
        "FROM users u LEFT JOIN holidays h ON h.user_id = u.id AND h.holiday_date LIKE ? "
        "WHERE u.id <> ? AND u.is_active = 1 GROUP BY u.id, u.username ORDER BY u.username",
        (f"{year}-%", current_user_id)
    ).fetchall()
    return jsonify(
        {
            "year": year,
            "users": [
                {"id": row["id"], "username": row["username"], "overrideCount": row["override_count"]}
                for row in rows
            ]
        }
    )


@holidays_bp.post("/holidays/copy")
@login_required
def copy_holidays():
    payload = request.get_json(silent=True) or {}
    year = int(payload.get("year", date.today().year))
    source_user_id = int(payload.get("sourceUserId", 0))
    target_user_id = session["user_id"]
    if source_user_id == target_user_id:
        return jsonify({"error": "不能从当前用户同步到自己"}), 400

    source_user = get_db().execute("SELECT id, username FROM users WHERE id = ? AND is_active = 1", (source_user_id,)).fetchone()
    if not source_user:
        return jsonify({"error": "源用户不存在"}), 404

    source_label = f"同步自 {source_user['username']}"
    copied = copy_holidays_between_users(source_user_id, target_user_id, year, source_label)
    overrides = read_day_overrides_for_year(target_user_id, year)
    return jsonify(
        {
            "ok": True,
            "year": year,
            "copied": copied,
            "holidays": [item for item in overrides if item["isHoliday"]],
            "workdays": [item for item in overrides if not item["isHoliday"]],
            "dayOverrides": overrides,
            "calendar": build_year_calendar(year, overrides),
            "meta": read_holiday_sync(target_user_id, year),
        }
    )


@holidays_bp.get("/holidays")
@login_required
def get_holidays():
    year = int(request.args.get("year", date.today().year))
    user_id = session["user_id"]
    ensure_holidays_for_user(user_id, year)
    holidays = read_holidays_for_year(user_id, year)
    workdays = read_workday_overrides_for_year(user_id, year)
    overrides = read_day_overrides_for_year(user_id, year)
    meta = read_holiday_sync(user_id, year)
    return jsonify({"year": year, "holidays": holidays, "workdays": workdays, "dayOverrides": overrides, "calendar": build_year_calendar(year, overrides), "meta": meta, })


@holidays_bp.post("/holidays/sync")
@login_required
def sync_holidays():
    payload = request.get_json(silent=True) or {}
    year = int(payload.get("year", date.today().year))
    holidays, source = fetch_china_holidays(year)
    replace_holidays_for_year(session["user_id"], year, holidays, source)
    saved = read_holidays_for_year(session["user_id"], year)
    workdays = read_workday_overrides_for_year(session["user_id"], year)
    overrides = read_day_overrides_for_year(session["user_id"], year)
    return jsonify(
        {
            "year": year,
            "holidays": saved,
            "workdays": workdays,
            "dayOverrides": overrides,
            "calendar": build_year_calendar(year, overrides),
            "meta": read_holiday_sync(session["user_id"], year),
        }
    )


@holidays_bp.patch("/holidays")
@login_required
def patch_holiday():
    payload = request.get_json(silent=True) or {}
    iso_date = str(payload.get("date", "")).strip()
    if not valid_date(iso_date):
        return jsonify({"error": "日期格式应为 YYYY-MM-DD"}), 400
    day_type = str(payload.get("dayType") or ("holiday" if payload.get("isHoliday") else "normal"))
    if day_type not in {"normal", "holiday", "workday"}:
        return jsonify({"error": "未知日期类型"}), 400
    is_holiday = day_type == "holiday"
    name = str(payload.get("name", "")).strip() or ("节假日" if is_holiday else "上班" if day_type == "workday" else "")
    db = get_db()
    if day_type == "normal":
        db.execute("DELETE FROM holidays WHERE user_id = ? AND holiday_date = ?", (session["user_id"], iso_date))
    else:
        db.execute(
            "INSERT INTO holidays(user_id, holiday_date, name, is_holiday, source, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, holiday_date) DO UPDATE SET name = excluded.name, is_holiday = excluded.is_holiday, source = excluded.source, updated_at = excluded.updated_at",
            (session["user_id"], iso_date, name, 1 if is_holiday else 0, '手动维护', now_iso())
        )
    db.execute(
        "INSERT INTO holiday_syncs(user_id, year, source, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id, year) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at",
        (session["user_id"], int(iso_date[:4]), "手动维护", now_iso())
    )
    db.commit()
    holidays = read_holidays_for_year(session["user_id"], int(iso_date[:4]))
    workdays = read_workday_overrides_for_year(session["user_id"], int(iso_date[:4]))
    overrides = read_day_overrides_for_year(session["user_id"], int(iso_date[:4]))
    return jsonify(
        {
            "ok": True,
            "holidays": holidays,
            "workdays": workdays,
            "dayOverrides": overrides,
            "calendar": build_year_calendar(int(iso_date[:4]), overrides),
        }
    )
