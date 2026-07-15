from __future__ import annotations

from datetime import date, datetime
from typing import Any

from ...core.database import get_db
from ...shared.calendar_utils import now_iso

DEFAULT_ATTENDANCE_RETENTION_MONTHS = 12
DEFAULT_OVERTIME_RETENTION_MONTHS = 12
DEFAULT_SEAT_BOOKING_PLAN_RETENTION_MONTHS = 6
DEFAULT_SEAT_BOOKING_RUN_RETENTION_MONTHS = 3

RETENTION_LIMITS = {
    "attendanceRetentionMonths": (1, 60),
    "overtimeRetentionMonths": (1, 60),
    "seatBookingPlanRetentionMonths": (1, 60),
    "seatBookingRunRetentionMonths": (1, 60),
}


def subtract_months(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 - months
    year = month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, _days_in_month(year, month))
    return date(year, month, day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return (next_month - date(year, month, 1)).days


def ensure_cleanup_settings() -> None:
    db = get_db()
    db.execute(
        "INSERT OR IGNORE INTO data_cleanup_settings("
        "id, scheduled_enabled, attendance_retention_months, overtime_retention_months, "
        "seat_booking_plan_retention_months, seat_booking_run_retention_months, updated_at"
        ") VALUES (1, 0, ?, ?, ?, ?, ?)",
        (
            DEFAULT_ATTENDANCE_RETENTION_MONTHS,
            DEFAULT_OVERTIME_RETENTION_MONTHS,
            DEFAULT_SEAT_BOOKING_PLAN_RETENTION_MONTHS,
            DEFAULT_SEAT_BOOKING_RUN_RETENTION_MONTHS,
            now_iso(),
        ),
    )
    db.commit()


def get_cleanup_settings() -> dict[str, Any]:
    ensure_cleanup_settings()
    row = get_db().execute("SELECT * FROM data_cleanup_settings WHERE id = 1").fetchone()
    return _settings_from_row(row)


def update_cleanup_settings(payload: dict[str, Any]) -> dict[str, Any]:
    ensure_cleanup_settings()
    current = get_cleanup_settings()
    scheduled_enabled = current["scheduledEnabled"]
    if "scheduledEnabled" in payload:
        scheduled_enabled = bool(payload.get("scheduledEnabled"))

    months = {
        "attendanceRetentionMonths": current["attendanceRetentionMonths"],
        "overtimeRetentionMonths": current["overtimeRetentionMonths"],
        "seatBookingPlanRetentionMonths": current["seatBookingPlanRetentionMonths"],
        "seatBookingRunRetentionMonths": current["seatBookingRunRetentionMonths"],
    }
    for key, (minimum, maximum) in RETENTION_LIMITS.items():
        if key not in payload:
            continue
        try:
            value = int(payload[key])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key}必须是整数。") from exc
        if value < minimum or value > maximum:
            raise ValueError(f"{key}必须在 {minimum}-{maximum} 个月之间。")
        months[key] = value

    db = get_db()
    db.execute(
        "UPDATE data_cleanup_settings SET "
        "scheduled_enabled = ?, attendance_retention_months = ?, overtime_retention_months = ?, "
        "seat_booking_plan_retention_months = ?, seat_booking_run_retention_months = ?, updated_at = ? "
        "WHERE id = 1",
        (
            1 if scheduled_enabled else 0,
            months["attendanceRetentionMonths"],
            months["overtimeRetentionMonths"],
            months["seatBookingPlanRetentionMonths"],
            months["seatBookingRunRetentionMonths"],
            now_iso(),
        ),
    )
    db.commit()
    return get_cleanup_settings()


def cleanup_cutoffs(settings: dict[str, Any] | None = None, today: date | None = None) -> dict[str, str]:
    settings = settings or get_cleanup_settings()
    today = today or date.today()
    return {
        "attendance": subtract_months(today, settings["attendanceRetentionMonths"]).isoformat(),
        "overtime": subtract_months(today, settings["overtimeRetentionMonths"]).isoformat(),
        "seatBookingPlans": subtract_months(today, settings["seatBookingPlanRetentionMonths"]).isoformat(),
        "seatBookingRuns": subtract_months(today, settings["seatBookingRunRetentionMonths"]).isoformat(),
    }


def run_data_cleanup(*, dry_run: bool = False, vacuum: bool = False, today: date | None = None) -> dict[str, Any]:
    settings = get_cleanup_settings()
    cutoffs = cleanup_cutoffs(settings, today=today)
    db = get_db()
    targets = [
        ("attendance", "attendance", "work_date", cutoffs["attendance"]),
        ("overtime", "overtime", "work_date", cutoffs["overtime"]),
        ("seatBookingPlans", "seat_booking_plans", "booking_date", cutoffs["seatBookingPlans"]),
        ("seatBookingRuns", "seat_booking_runs", "booking_date", cutoffs["seatBookingRuns"]),
    ]
    deleted: dict[str, int] = {}
    total = 0
    for public_name, table, column, cutoff in targets:
        count = db.execute(f"SELECT COUNT(*) AS c FROM {table} WHERE {column} < ?", (cutoff,)).fetchone()["c"]
        deleted[public_name] = int(count)
        total += int(count)
        if not dry_run and count:
            db.execute(f"DELETE FROM {table} WHERE {column} < ?", (cutoff,))

    message = f"预览完成：将清理 {total} 条记录" if dry_run else f"清理完成：删除 {total} 条记录"
    if not dry_run:
        db.execute(
            "UPDATE data_cleanup_settings SET last_run_at = ?, last_message = ?, updated_at = ? WHERE id = 1",
            (now_iso(), message, now_iso()),
        )
        db.commit()
        if vacuum:
            db.execute("VACUUM")
    return {
        "dryRun": dry_run,
        "cutoffs": cutoffs,
        "deleted": deleted,
        "totalDeleted": total,
        "message": message,
        "settings": get_cleanup_settings(),
    }


def scheduled_cleanup_due(settings: dict[str, Any] | None = None, now: datetime | None = None) -> bool:
    settings = settings or get_cleanup_settings()
    if not settings["scheduledEnabled"]:
        return False
    last_run_at = settings.get("lastRunAt")
    if not last_run_at:
        return True
    now = now or datetime.now()
    return str(last_run_at)[:10] < now.date().isoformat()


def _settings_from_row(row) -> dict[str, Any]:
    return {
        "scheduledEnabled": bool(row["scheduled_enabled"]),
        "attendanceRetentionMonths": int(row["attendance_retention_months"]),
        "overtimeRetentionMonths": int(row["overtime_retention_months"]),
        "seatBookingPlanRetentionMonths": int(row["seat_booking_plan_retention_months"]),
        "seatBookingRunRetentionMonths": int(row["seat_booking_run_retention_months"]),
        "updatedAt": row["updated_at"],
        "lastRunAt": row["last_run_at"],
        "lastMessage": row["last_message"],
    }
