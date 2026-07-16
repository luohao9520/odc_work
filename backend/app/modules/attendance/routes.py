from __future__ import annotations

from flask import Blueprint, jsonify, request, session

from ...core.config import VALID_STATUSES
from ...core.database import get_db
from ...domain.attendance.calculator import ACCEPTED_SMART_SCHEDULE_STRATEGIES, SMART_SCHEDULE_STRATEGIES, build_smart_schedule, calculate_attendance_summary, recommend_smart_strategy
from ...shared.calendar_utils import now_iso, selectable_workdays, today_iso, valid_date, valid_month
from ..auth.routes import login_required
from ..holidays.routes import ensure_holidays_for_user, read_day_overrides_for_year, read_holidays_for_year, read_workday_overrides_for_year
from ..seat_booking.routes import read_successful_seat_bookings_for_month

attendance_bp = Blueprint("attendance", __name__, url_prefix="/api")
SOURCE_MANUAL = "manual"
SOURCE_BULK = "bulk"
SOURCE_SMART = "smart"


def read_settings(user_id: int) -> dict:
    row = get_db().execute("SELECT target_rate FROM settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return {"targetRate": 60}
    return {"targetRate": row["target_rate"]}


def read_attendance_for_month(user_id: int, month: str) -> dict:
    return {date: entry["status"] for date, entry in read_attendance_entries_for_month(user_id, month).items()}


def read_attendance_entries_for_month(user_id: int, month: str) -> dict:
    """返回记录状态和来源，用于判断是否允许查看。

    普通的 `read_attendance_for_month` 会忽略隐藏 `source`，避免多数调用方关心元数据。
    智能推荐和批量操作需要读取来源，以保护用户手动选择。
    """
    rows = get_db().execute(
        "SELECT work_date, status, source FROM attendance WHERE user_id = ? AND work_date LIKE ?",
        (user_id, f"{month}-%"),
    ).fetchall()
    return {row["work_date"]: {"status": row["status"], "source": row["source"]} for row in rows}


def next_month_value(month: str) -> str:
    year, month_number = [int(part) for part in month.split("-")]
    if month_number == 12:
        return f"{year + 1}-01"
    return f"{year}-{month_number + 1:02d}"


def read_manual_attendance_history(user_id: int, through_month: str) -> list[dict]:
    """读取数据库里所有用户的手动进库，用于智能推荐。

    这里包含当前用户的手动进库，因此用户可以先标记几个偏好的公司，
    再让智能推荐学习这些偏好。bulk/smart 生成的记录会被忽略，因为那是系统决策，
    不能代表用户真实偏好。
    """
    rows = get_db().execute(
        "SELECT work_date, status FROM attendance WHERE user_id = ? AND source = ? AND work_date < ? ORDER BY work_date DESC LIMIT 240",
        (user_id, SOURCE_MANUAL, f"{next_month_value(through_month)}-01"),
    ).fetchall()
    return [{"date": row["work_date"], "status": row["status"]} for row in rows]


def parse_include_past(payload: dict) -> bool:
    """从 JSON 请求中解析“包含过去日期”开关。

    浏览器会发送布尔值，接口测试或手工调用时可能发送某些真的值字符串。
    其他情况默认发送安全的“仅未来日期”行为。
    """
    value = payload.get("includePast", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


def filter_adjustable_dates(dates: list[str], include_past: bool) -> list[str]:
    """根据用户选择限制批量/智能生成操作的日期范围。

    默认范围是严格晚于今天（明天及之后），今天被视为用户手动确认的事实日期。
    includePast=True 表示用户明确要求包含整个月，包括今天和过去日期。
    """
    if include_past:
        return dates
    today = today_iso()
    return [iso_date for iso_date in dates if iso_date > today]


@attendance_bp.get("/settings")
@login_required
def get_settings():
    return jsonify(read_settings(session["user_id"]))


@attendance_bp.put("/settings")
@login_required
def update_settings():
    payload = request.get_json(silent=True) or {}
    target_rate = max(0, min(100, int(payload.get("targetRate", 60))))
    db = get_db()
    db.execute(
        "INSERT INTO settings(user_id, target_rate) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET target_rate = excluded.target_rate",
        (session["user_id"], target_rate),
    )
    db.commit()
    return jsonify(read_settings(session["user_id"]))


@attendance_bp.get("/attendance")
@login_required
def get_attendance():
    month = request.args.get("month", "")
    if not valid_month(month):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400
    user_id = session["user_id"]
    year = int(month[:4])
    ensure_holidays_for_user(user_id, year)
    selections = read_attendance_for_month(user_id, month)
    holidays = read_holidays_for_year(user_id, year)
    workdays = read_workday_overrides_for_year(user_id, year)
    overrides = read_day_overrides_for_year(user_id, year)
    settings = read_settings(user_id)
    recommendation = recommend_smart_strategy(read_manual_attendance_history(user_id, month))
    seat_bookings = read_successful_seat_bookings_for_month(user_id, month)
    # 从 API 层传入今天日期，确保汇总计算、测试和智能排班共享同一个“今天”定义。
    today = today_iso()
    summary = calculate_attendance_summary(
        month,
        selections,
        {item["date"] for item in holidays},
        {item["date"] for item in workdays},
        settings["targetRate"],
        today,
    )
    return jsonify(
        {
            "month": month,
            "settings": settings,
            "selections": selections,
            "summary": summary,
            "holidays": [h for h in holidays if h["date"].startswith(month)],
            "workdays": [w for w in workdays if w["date"].startswith(month)],
            "dayOverrides": [item for item in overrides if item["date"].startswith(month)],
            "holidayCountForYear": len(holidays),
            "workdayCountForYear": len(workdays),
            "smartSchedule": {
                "strategies": [{"value": value, "label": label} for value, label in SMART_SCHEDULE_STRATEGIES.items()],
                "recommendation": recommendation,
            },
            "seatBookings": seat_bookings,
        }
    )


@attendance_bp.put("/attendance")
@login_required
def save_attendance():
    payload = request.get_json(silent=True) or {}
    iso_date = str(payload.get("date", ""))
    status = payload.get("status")
    if not valid_date(iso_date):
        return jsonify({"error": "日期格式应为 YYYY-MM-DD"}), 400
    if status is not None and status not in VALID_STATUSES:
        return jsonify({"error": "未知登记状态"}), 400
    db = get_db()
    if status is None:
        db.execute("DELETE FROM attendance WHERE user_id = ? AND work_date = ?", (session["user_id"], iso_date))
    else:
        db.execute(
            "INSERT INTO attendance(user_id, work_date, status, updated_at, source) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, work_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, source = excluded.source",
            (session["user_id"], iso_date, status, now_iso(), SOURCE_MANUAL),
        )
    db.commit()
    return jsonify({"ok": True})


@attendance_bp.post("/attendance/bulk")
@login_required
def bulk_attendance():
    payload = request.get_json(silent=True) or {}
    month = str(payload.get("month", ""))
    status = payload.get("status")
    include_past = parse_include_past(payload)
    if not valid_month(month):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400
    if status is not None and status not in VALID_STATUSES:
        return jsonify({"error": "未知登记状态"}), 400

    user_id = session["user_id"]
    year = int(month[:4])
    ensure_holidays_for_user(user_id, year)
    holidays = {item["date"] for item in read_holidays_for_year(user_id, year)}
    workday_overrides = {item["date"] for item in read_workday_overrides_for_year(user_id, year)}
    db = get_db()
    adjustable_dates = filter_adjustable_dates(selectable_workdays(month, holidays, workday_overrides), include_past)
    for iso_date in adjustable_dates:
        if status is None:
            # 清空操作在范围内是有意的破坏性操作：不同于”全设为公司“，它会同时删除
            # manual、bulk、smart 三类选择
            db.execute("DELETE FROM attendance WHERE user_id = ? AND work_date = ?", (user_id, iso_date))
        else:
            db.execute(
                "INSERT INTO attendance(user_id, work_date, status, updated_at, source) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(user_id, work_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, source = excluded.source "
                "WHERE attendance.source != ?",
                (user_id, iso_date, status, now_iso(), SOURCE_BULK, SOURCE_MANUAL),
            )
            # 上面的 SQL WHERE 子句就是手动选择保护：生成记录可以覆盖其他生成记录
            # 但永远不能覆盖手动记录
    db.commit()
    return jsonify({"ok": True, "selections": read_attendance_for_month(user_id, month), "adjustedDates": adjustable_dates, "includePast": include_past})


@attendance_bp.post("/attendance/smart-schedule")
@login_required
def smart_schedule():
    payload = request.get_json(silent=True) or {}
    month = str(payload.get("month", ""))
    strategy = str(payload.get("strategy", "weekly-balanced"))
    include_past = parse_include_past(payload)
    if not valid_month(month):
        return jsonify({"error": "月份格式应为 YYYY-MM"}), 400
    if strategy not in ACCEPTED_SMART_SCHEDULE_STRATEGIES:
        return jsonify({"error": "未知智能排班方式"}), 400

    user_id = session["user_id"]
    year = int(month[:4])
    ensure_holidays_for_user(user_id, year)
    holidays = {item["date"] for item in read_holidays_for_year(user_id, year)}
    workday_overrides = {item["date"] for item in read_workday_overrides_for_year(user_id, year)}
    settings = read_settings(user_id)
    # 智能排班只会写入这个集合中的日期。集合外日期仍会在排班器内部影响每周应达标/待补足数量
    adjustable_dates = set(filter_adjustable_dates(selectable_workdays(month, holidays, workday_overrides), include_past))
    entries = read_attendance_entries_for_month(user_id, month)
    selections = {date: entry["status"] for date, entry in entries.items()}
    # 手动日期同时由排班器和 upsert 的 WHERE 子句保护，双重保护可以避免未来重构是
    # 意外覆盖用户决策，同时仍允许重新生成 smart/bulk 记录/
    protected_dates = {date for date, entry in entries.items() if entry["source"] == SOURCE_MANUAL}
    history = read_manual_attendance_history(user_id, month)
    plan = build_smart_schedule(month, selections, holidays, workday_overrides, settings["targetRate"], protected_dates, strategy, history, adjustable_dates)

    db = get_db()
    for iso_date, status in plan["plannedSelections"].items():
        db.execute(
            "INSERT INTO attendance(user_id, work_date, status, updated_at, source) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, work_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, source = excluded.source "
            "WHERE attendance.source != ?",
            (user_id, iso_date, status, now_iso(), SOURCE_SMART, SOURCE_MANUAL),
        )
    db.commit()

    updated = read_attendance_for_month(user_id, month)
    summary = calculate_attendance_summary(month, updated, holidays, workday_overrides, settings["targetRate"], today_iso())
    return jsonify({
        "ok": True,
        "selections": updated,
        "summary": summary,
        "weeklyPlan": plan["weeklyPlan"],
        "strategy": plan["strategy"],
        "strategyLabel": plan["strategyLabel"],
        "requestedStrategy": plan["requestedStrategy"],
        "recommendation": plan["recommendation"],
        "recommendedDates": plan["recommendedDates"],
        "adjustedDates": sorted(adjustable_dates),
        "includePast": include_past
    })
