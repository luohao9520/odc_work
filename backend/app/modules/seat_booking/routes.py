from __future__ import annotations

import re
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, session

from ...core.crypto import decrypt_secret, encrypt_secret
from ...core.database import get_db
from ...integrations.seat_booking_client import LIMIT_MESSAGE, SeatBookingClient, SeatBookingError, extract_bookings, extract_seats
from ...shared.calendar_utils import now_iso, valid_date
from ..auth.routes import login_required

seat_booking_bp = Blueprint("seat_booking", __name__, url_prefix="/api")


def valid_time(value: str) -> bool:
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except (TypeError, ValueError):
        return False


def clamp_advance_days(value) -> int:
    try:
        return max(0, min(7, int(value)))
    except (TypeError, ValueError):
        return 0


def due_datetime_for(booking_date: str, booking_time: str, advance_days: int) -> datetime:
    target = datetime.strptime(booking_date, "%Y-%m-%d") - timedelta(days=clamp_advance_days(advance_days))
    hour, minute = [int(part) for part in booking_time.split(":")]
    return target.replace(hour=hour, minute=minute)


def validate_booking_schedule(booking_date: str, booking_time: str, advance_days: int, enabled: bool, now: datetime | None = None) -> None:
    if not booking_date:
        return
    now = now or datetime.now()
    target_day = datetime.strptime(booking_date, "%Y-%m-%d").date()
    if target_day < now.date():
        raise ValueError("不支持预约当前日期之前的座位。")
    if enabled and due_datetime_for(booking_date, booking_time, advance_days) < now.replace(second=0, microsecond=0):
        raise ValueError("提前预约触发时间不能早于当前时间，请调整预约日期、提前天数或定时提交时间。")


def validate_direct_booking_window(booking_date: str, now: datetime | None = None) -> None:
    now = now or datetime.now()
    target_day = datetime.strptime(booking_date, "%Y-%m-%d").date()
    earliest = now.date() + timedelta(days=1)
    latest = now.date() + timedelta(days=7)
    if target_day < earliest or target_day > latest:
        raise ValueError("直接预约只能选择明天至 7 天后的日期。")


def seat_sort_key(seat_id: str) -> tuple:
    match = re.match(r"^(.*?)(\d+)$", str(seat_id or ""))
    if not match:
        return (str(seat_id or ""), 0)
    return (match.group(1), int(match.group(2)))


def choose_booking_seat(client: SeatBookingClient, booking_date: str, preferred_seat_id: str, preferred_seat_name: str = "") -> tuple[str, str, str]:
    result = client.get_seat_list(booking_date)
    seats = [seat for seat in extract_seats(result) if seat.get("available")]
    if not seats:
        return preferred_seat_id, preferred_seat_name or preferred_seat_id, "未获取到可用座位，按首选座位提交。"
    for seat in seats:
        if seat["id"] == preferred_seat_id:
            return seat["id"], seat.get("name") or seat["id"], "首选座位可用。"
    preferred_key = seat_sort_key(preferred_seat_id)
    fallback = min(seats, key=lambda seat: abs(seat_sort_key(seat["id"])[1] - preferred_key[1]) if seat_sort_key(seat["id"])[0] == preferred_key[0] else 10_000 + seat_sort_key(seat["id"])[1])
    return fallback["id"], fallback.get("name") or fallback["id"], f"首选座位{preferred_seat_id} 不可用，已选择 {fallback['id']}。"


def read_settings(user_id: int) -> dict:
    row = get_db().execute(
        "SELECT external_username, external_password, booking_date, preferred_seat_id, preferred_seat_name, booking_time, advance_days, enabled "
        "FROM seat_booking_settings WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        return {
            "externalUsername": "",
            "hasPassword": False,
            "bookingDate": "",
            "preferredSeatId": "",
            "preferredSeatName": "",
            "bookingTime": "08:30",
            "advanceDays": 0,
            "enabled": False,
        }
    return {
        "externalUsername": row["external_username"],
        "hasPassword": bool(row["external_password"]),
        "bookingDate": row["booking_date"],
        "preferredSeatId": row["preferred_seat_id"],
        "preferredSeatName": row["preferred_seat_name"],
        "bookingTime": row["booking_time"],
        "advanceDays": row["advance_days"],
        "enabled": bool(row["enabled"]),
    }


def read_secret_settings(user_id: int) -> dict:
    row = get_db().execute("SELECT * FROM seat_booking_settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return {}
    settings = dict(row)
    settings["external_password"] = decrypt_secret(settings.get("external_password", ""))
    return settings


def read_runs(user_id: int, limit: int = 20) -> list[dict]:
    rows = get_db().execute(
        "SELECT id, booking_date, seat_id, seat_name, status, message, run_at FROM seat_booking_runs "
        "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "bookingDate": row["booking_date"],
            "seatId": row["seat_id"],
            "seatName": row["seat_name"],
            "status": row["status"],
            "message": row["message"],
            "runAt": row["run_at"],
        }
        for row in rows
    ]


def read_successful_seat_bookings_for_month(user_id: int, month: str) -> dict:
    rows = get_db().execute(
        "SELECT booking_date, seat_id, seat_name, status, message, run_at FROM seat_booking_runs "
        "WHERE user_id = ? AND booking_date LIKE ? AND status = 'success' ORDER BY id DESC",
        (user_id, f"{month}-%"),
    ).fetchall()
    result = {}
    for row in rows:
        result.setdefault(
            row["booking_date"],
            {"seatId": row["seat_id"], "seatName": row["seat_name"], "status": row["status"], "message": row["message"], "runAt": row["run_at"]},
        )
    return result


def read_plans_for_month(user_id: int, month: str) -> dict:
    rows = get_db().execute(
        "SELECT booking_date, seat_id, seat_name, status, message, updated_at FROM seat_booking_plans WHERE user_id = ? AND booking_date LIKE ? ORDER BY booking_date",
        (user_id, f"{month}-%"),
    ).fetchall()
    plans = {
        row["booking_date"]: {
            "bookingDate": row["booking_date"],
            "seatId": row["seat_id"],
            "seatName": row["seat_name"],
            "status": row["status"],
            "message": row["message"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    }
    successful = read_successful_seat_bookings_for_month(user_id, month)
    for iso_date, booking in successful.items():
        plans[iso_date] = {"bookingDate": iso_date, **booking}
    return plans


def successful_booking_count_for_week(user_id: int, booking_date: str) -> int:
    current = datetime.strptime(booking_date, "%Y-%m-%d")
    week_start = (current - timedelta(days=current.weekday())).date().isoformat()
    week_end = (current + timedelta(days=6 - current.weekday())).date().isoformat()
    row = get_db().execute(
        "SELECT COUNT(DISTINCT booking_date) AS c FROM seat_booking_runs WHERE user_id = ? AND status = 'success' AND booking_date BETWEEN ? AND ?",
        (user_id, week_start, week_end),
    ).fetchone()
    return int(row["c"] if row else 0)


def save_run(user_id: int, booking_date: str, seat_id: str, seat_name: str, status: str, message: str) -> dict:
    db = get_db()
    cur = db.execute(
        "INSERT INTO seat_booking_runs(user_id, booking_date, seat_id, seat_name, status, message, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, booking_date, seat_id, seat_name, status, message[:500], now_iso()),
    )
    db.commit()
    return {"id": cur.lastrowid, "bookingDate": booking_date, "seatId": seat_id, "seatName": seat_name, "status": status, "message": message[:500]}


def seat_booking_sync_window(current_date=None) -> tuple:
    anchor = current_date or datetime.now().date()
    if isinstance(anchor, datetime):
        anchor = anchor.date()
    current_week_start = anchor - timedelta(days=anchor.weekday())
    return current_week_start - timedelta(days=7), current_week_start + timedelta(days=13)


def sync_platform_bookings(user_id: int, current_date=None) -> dict:
    settings = read_secret_settings(user_id)
    if not settings:
        raise ValueError("请先保存外部平台账号和密码。")
    client = platform_login(settings)
    book_list_result = client.get_book_list()
    if book_list_result.get("ok") is False:
        message = str(book_list_result.get("message") or "外部平台预约列表返回异常。")[:300]
        raise SeatBookingError(message)
    window_start, window_end = seat_booking_sync_window(current_date)
    bookings = [
        booking
        for booking in extract_bookings(book_list_result)
        if valid_date(booking.get("bookingDate", "")) and window_start <= datetime.strptime(booking["bookingDate"], "%Y-%m-%d").date() <= window_end
    ]
    db = get_db()
    synced = 0
    updated = 0
    for booking in bookings:
        booking_date = booking.get("bookingDate", "")
        if not valid_date(booking_date):
            continue
        seat_id = booking.get("seatId", "")
        seat_name = booking.get("seatName") or seat_id
        existing = db.execute(
            "SELECT id FROM seat_booking_runs WHERE user_id = ? AND booking_date = ? AND status = 'success' LIMIT 1",
            (user_id, booking_date),
        ).fetchone()
        if not existing:
            db.execute(
                "INSERT INTO seat_booking_runs(user_id, booking_date, seat_id, seat_name, status, message, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, booking_date, seat_id, seat_name, "success", "已从外部平台同步预约记录。", now_iso()),
            )
            synced += 1
        db.execute(
            "INSERT INTO seat_booking_plans(user_id, booking_date, seat_id, seat_name, status, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, booking_date) DO UPDATE SET seat_id = excluded.seat_id, seat_name = excluded.seat_name, status = excluded.status, message = excluded.message, updated_at = excluded.updated_at",
            (user_id, booking_date, seat_id, seat_name, "success", "已从外部平台同步预约记录。", now_iso()),
        )
        updated += 1
    db.commit()
    return {"ok": True, "synced": synced, "updated": updated, "bookings": bookings}


def normalize_settings_payload(payload: dict, current: dict | None = None) -> dict:
    current = current or {}
    booking_date = str(payload.get("bookingDate", "")).strip()
    booking_time = str(payload.get("bookingTime", current.get("booking_time", "08:30"))).strip() or "08:30"
    if booking_date and not valid_date(booking_date):
        raise ValueError("预约日期格式应为 YYYY-MM-DD")
    if not valid_time(booking_time):
        raise ValueError("定时预约时间格式应为 HH:MM")
    advance_days = clamp_advance_days(payload.get("advanceDays", current.get("advance_days", 0)))
    enabled = 1 if payload.get("enabled", bool(current.get("enabled", 0))) else 0
    if booking_date:
        validate_booking_schedule(booking_date, booking_time, advance_days, bool(enabled))
    password = payload.get("externalPassword")
    if password is None:
        password = current.get("external_password", "")
    return {
        "external_username": str(payload.get("externalUsername", current.get("external_username", ""))).strip(),
        "external_password": str(password or ""),
        "booking_date": booking_date,
        "preferred_seat_id": str(payload.get("preferredSeatId", current.get("preferred_seat_id", ""))).strip(),
        "preferred_seat_name": str(payload.get("preferredSeatName", current.get("preferred_seat_name", ""))).strip(),
        "booking_time": booking_time,
        "advance_days": advance_days,
        "enabled": enabled,
    }


def platform_login(settings: dict) -> SeatBookingClient:
    client = SeatBookingClient()
    client.login(settings.get("external_username", ""), settings.get("external_password", ""))
    return client


def save_plan(user_id: int, booking_date: str, seat_id: str, seat_name: str, settings: dict) -> dict:
    if not valid_date(booking_date):
        raise ValueError("预约日期格式应为 YYYY-MM-DD")
    if not seat_id:
        raise ValueError("请选择座位。")
    timed_enabled = bool(settings.get("enabled", 0))
    validate_booking_schedule(booking_date, settings.get("booking_time", "08:30"), settings.get("advance_days", 0), timed_enabled)
    message = "预约计划已保存，等待定时提交。" if timed_enabled else "已保存座位选择；定时预约未启用，不会自动提交。"
    db = get_db()
    db.execute(
        "INSERT INTO seat_booking_plans(user_id, booking_date, seat_id, seat_name, status, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id, booking_date) DO UPDATE SET seat_id = excluded.seat_id, seat_name = excluded.seat_name, status = excluded.status, message = excluded.message, updated_at = excluded.updated_at",
        (user_id, booking_date, seat_id, seat_name or seat_id, "pending", message, now_iso()),
    )
    db.commit()
    return read_plans_for_month(user_id, booking_date[:7]).get(booking_date, {})


def book_with_settings(user_id: int, booking_date: str | None = None, seat_id: str | None = None, seat_name: str | None = None, direct: bool = False) -> dict:
    settings = read_secret_settings(user_id)
    if not settings:
        raise ValueError("请先保存座位预约配置。")
    target_date = booking_date or settings.get("booking_date") or ""
    target_seat_id = seat_id or settings.get("preferred_seat_id") or ""
    target_seat_name = seat_name if seat_name is not None else settings.get("preferred_seat_name") or ""
    if not valid_date(target_date):
        raise ValueError("请先填写有效预约日期。")
    validate_booking_schedule(target_date, "00:00", 0, False)
    if direct:
        validate_direct_booking_window(target_date)
    if not target_seat_id:
        raise ValueError("请先选择或填写座位 ID。")
    if successful_booking_count_for_week(user_id, target_date) >= 3:
        message = "同一周已有 3 天座位预约成功，本次不再自动预约；如需继续，请先取消该周某天预约。"
        run = save_run(user_id, target_date, target_seat_id, target_seat_name, "skipped", message)
        return {"ok": True, "run": run}

    try:
        client = platform_login(settings)
        target_seat_id, target_seat_name, seat_note = choose_booking_seat(client, target_date, target_seat_id, target_seat_name)
        result = client.book_seat(target_date, target_seat_id, target_seat_name)
        message = str(result.get("message") or "预约请求已提交。")
        if seat_note and seat_note not in message:
            message = f"{seat_note}{message}"
        status = "limited" if LIMIT_MESSAGE in message else "success" if result.get("ok") else "failed"
    except Exception as exc:
        message = str(exc)
        status = "failed"
    run = save_run(user_id, target_date, target_seat_id, target_seat_name, status, message)
    if status == "success":
        get_db().execute(
            "UPDATE seat_booking_plans SET seat_id = ?, seat_name = ?, status = ?, message = ?, updated_at = ? WHERE user_id = ? AND booking_date = ?",
            (target_seat_id, target_seat_name, status, message[:500], now_iso(), user_id, target_date),
        )
        get_db().commit()
    return {"ok": status in {"success", "limited"}, "run": run}


@seat_booking_bp.get("/seat-booking")
@login_required
def get_seat_booking():
    user_id = session["user_id"]
    from ...jobs.seat_booking_scheduler import scheduler_status
    settings = read_settings(user_id)
    requested_month = str(request.args.get("month") or "")
    month = requested_month if len(requested_month) == 7 else (settings.get("bookingDate") or datetime.now().strftime("%Y-%m"))[:7]
    plans = read_plans_for_month(user_id, month)
    return jsonify({"settings": settings, "runs": read_runs(user_id), "scheduler": scheduler_status(), "seatBookings": read_successful_seat_bookings_for_month(user_id, month), "plans": plans})


@seat_booking_bp.get("/seat-booking/scheduler")
@login_required
def get_seat_booking_scheduler():
    from ...jobs.seat_booking_scheduler import scheduler_status
    return jsonify(scheduler_status())


@seat_booking_bp.post("/seat-booking/sync")
@login_required
def sync_seat_booking_from_platform():
    user_id = session["user_id"]
    try:
        result = sync_platform_bookings(user_id)
    except (SeatBookingError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"同步外部平台预约失败：{exc}"}), 502
    month = str(request.args.get("month") or datetime.now().strftime("%Y-%m"))[:7]
    return jsonify({**result, "plans": read_plans_for_month(user_id, month), "runs": read_runs(user_id)})


@seat_booking_bp.put("/seat-booking/settings")
@login_required
def update_seat_booking_settings():
    payload = request.get_json(silent=True) or {}
    user_id = session["user_id"]
    current = read_secret_settings(user_id)
    try:
        normalized = normalize_settings_payload(payload, current)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    db = get_db()
    db.execute(
        "INSERT INTO seat_booking_settings(user_id, external_username, external_password, booking_date, preferred_seat_id, preferred_seat_name, booking_time, advance_days, enabled, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET external_username = excluded.external_username, external_password = excluded.external_password, "
        "booking_date = excluded.booking_date, preferred_seat_id = excluded.preferred_seat_id, preferred_seat_name = excluded.preferred_seat_name, "
        "booking_time = excluded.booking_time, advance_days = excluded.advance_days, enabled = excluded.enabled, updated_at = excluded.updated_at",
        (
            user_id,
            normalized["external_username"],
            encrypt_secret(normalized["external_password"]),
            normalized["booking_date"],
            normalized["preferred_seat_id"],
            normalized["preferred_seat_name"],
            normalized["booking_time"],
            normalized["advance_days"],
            normalized["enabled"],
            now_iso(),
        ),
    )
    db.commit()
    return jsonify({"ok": True, "settings": read_settings(user_id)})


@seat_booking_bp.post("/seat-booking/seats")
@login_required
def fetch_seats():
    payload = request.get_json(silent=True) or {}
    user_id = session["user_id"]
    settings = read_secret_settings(user_id)
    booking_date = str(payload.get("bookingDate") or settings.get("booking_date") or "")
    if not valid_date(booking_date):
        return jsonify({"error": "预约日期格式应为 YYYY-MM-DD"}), 400
    try:
        client = platform_login(settings)
        result = client.get_seat_list(booking_date)
        return jsonify({"ok": True, "message": result.get("message", "OK"), "seats": extract_seats(result)})
    except (SeatBookingError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"获取座位列表失败：{exc}"}), 502


@seat_booking_bp.put("/seat-booking/plans")
@login_required
def upsert_seat_booking_plan():
    payload = request.get_json(silent=True) or {}
    user_id = session["user_id"]
    settings = read_secret_settings(user_id)
    if not settings:
        return jsonify({"error": "请先保存外部平台账号和定时配置。"}), 400
    booking_date = str(payload.get("bookingDate") or "").strip()
    seat_id = str(payload.get("seatId") or "").strip()
    seat_name = str(payload.get("seatName") or seat_id).strip()
    try:
        plan = save_plan(user_id, booking_date, seat_id, seat_name, settings)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "plan": plan, "plans": read_plans_for_month(user_id, booking_date[:7])})


@seat_booking_bp.delete("/seat-booking/plans")
@login_required
def cancel_seat_booking_plan():
    user_id = session["user_id"]
    booking_date = str(request.args.get("date") or "").strip()
    if not valid_date(booking_date):
        return jsonify({"error": "预约日期格式应为 YYYY-MM-DD"}), 400
    settings = read_secret_settings(user_id)
    successful = get_db().execute(
        "SELECT id FROM seat_booking_runs WHERE user_id = ? AND booking_date = ? AND status = 'success' LIMIT 1",
        (user_id, booking_date),
    ).fetchone()
    external_cancelled = False
    if successful:
        if not settings:
            return jsonify({"error": "请先保存外部平台账号和密码后再取消已成功预约。"}), 400
        try:
            result = platform_login(settings).cancel_seat(booking_date)
            if result.get("ok") is False:
                return jsonify({"error": result.get("message") or "外部平台取消预约失败。"}), 502
            external_cancelled = True
        except Exception as exc:
            return jsonify({"error": f"外部平台取消预约失败：{exc}"}), 502
    db = get_db()
    db.execute("DELETE FROM seat_booking_plans WHERE user_id = ? AND booking_date = ?", (user_id, booking_date))
    db.execute("DELETE FROM seat_booking_runs WHERE user_id = ? AND booking_date = ? AND status = 'success'", (user_id, booking_date))
    db.execute(
        "INSERT INTO seat_booking_runs(user_id, booking_date, seat_id, seat_name, status, message, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, booking_date, "", "", "cancelled", "已取消外部平台和本地座位预约记录。" if external_cancelled else "已取消本地座位预约计划。", now_iso()),
    )
    db.commit()
    return jsonify({"ok": True, "plans": read_plans_for_month(user_id, booking_date[:7])})


@seat_booking_bp.post("/seat-booking/book")
@login_required
def book_seat():
    payload = request.get_json(silent=True) or {}
    user_id = session["user_id"]
    booking_date = str(payload.get("bookingDate") or "").strip()
    if booking_date and not payload.get("seatId"):
        plan = read_plans_for_month(user_id, booking_date[:7]).get(booking_date, {})
        payload = {**payload, "seatId": plan.get("seatId"), "seatName": plan.get("seatName")}
    try:
        result = book_with_settings(
            user_id,
            str(payload.get("bookingDate") or "") or None,
            str(payload.get("seatId") or "") or None,
            str(payload.get("seatName") or "") or None,
            direct=True,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


def run_due_seat_bookings(current_time: datetime | None = None) -> list[dict]:
    current_time = current_time or datetime.now()
    db = get_db()
    rows = [dict(row) for row in db.execute(
        "SELECT p.user_id, p.booking_date, p.seat_id, p.seat_name, s.booking_time, s.advance_days "
        "FROM seat_booking_plans p JOIN seat_booking_settings s ON s.user_id = p.user_id "
        "WHERE s.enabled = 1 AND p.status = 'pending' AND p.seat_id != ''",
    ).fetchall()]
    existing_keys = {(row["user_id"], row["booking_date"]) for row in rows}
    legacy_rows = db.execute(
        "SELECT user_id, booking_date, preferred_seat_id AS seat_id, preferred_seat_name AS seat_name, booking_time, advance_days "
        "FROM seat_booking_settings WHERE enabled = 1 AND booking_date != '' AND preferred_seat_id != ''",
    ).fetchall()
    rows.extend(dict(row) for row in legacy_rows if (row["user_id"], row["booking_date"]) not in existing_keys)
    results = []
    for row in rows:
        user_id = row["user_id"]
        try:
            due_at = due_datetime_for(row["booking_date"], row["booking_time"], row["advance_days"])
        except ValueError:
            continue
        if current_time.replace(second=0, microsecond=0) < due_at.replace(second=0, microsecond=0):
            continue
        existing = db.execute(
            "SELECT id FROM seat_booking_runs WHERE user_id = ? AND booking_date = ? AND seat_id = ? AND status IN ('success', 'limited') LIMIT 1",
            (user_id, row["booking_date"], row["seat_id"]),
        ).fetchone()
        if existing:
            continue
        results.append(book_with_settings(user_id, row["booking_date"], row["seat_id"], row["seat_name"]))
    return results


@seat_booking_bp.post("/seat-booking/run-due")
@login_required
def run_due_for_current_user():
    user_id = session["user_id"]
    settings = read_secret_settings(user_id)
    if not settings:
        return jsonify({"error": "请先保存座位预约配置。"}), 400
    try:
        result = book_with_settings(user_id)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)
