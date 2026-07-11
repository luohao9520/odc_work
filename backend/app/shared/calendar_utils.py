from __future__ import annotations

import calendar
import fnmatch
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import date, datetime

from ..core.config import PROXY_CONFIG

FALLBACK_HOLIDAYS = {
    2025: [
        {"date": "2025-01-01", "name": "元旦", "isHoliday": True},
        {"date": "2025-01-26", "name": "春节补班", "isHoliday": False},
        {"date": "2025-01-28", "name": "春节", "isHoliday": True},
        {"date": "2025-01-29", "name": "春节", "isHoliday": True},
        {"date": "2025-01-30", "name": "春节", "isHoliday": True},
        {"date": "2025-01-31", "name": "春节", "isHoliday": True},
        {"date": "2025-02-01", "name": "春节", "isHoliday": True},
        {"date": "2025-02-02", "name": "春节", "isHoliday": True},
        {"date": "2025-02-03", "name": "春节", "isHoliday": True},
        {"date": "2025-02-04", "name": "春节", "isHoliday": True},
        {"date": "2025-02-08", "name": "春节补班", "isHoliday": False},
        {"date": "2025-04-04", "name": "清明节", "isHoliday": True},
        {"date": "2025-04-05", "name": "清明节", "isHoliday": True},
        {"date": "2025-04-06", "name": "清明节", "isHoliday": True},
        {"date": "2025-04-27", "name": "劳动节补班", "isHoliday": False},
        {"date": "2025-05-01", "name": "劳动节", "isHoliday": True},
        {"date": "2025-05-02", "name": "劳动节", "isHoliday": True},
        {"date": "2025-05-03", "name": "劳动节", "isHoliday": True},
        {"date": "2025-05-04", "name": "劳动节", "isHoliday": True},
        {"date": "2025-05-05", "name": "劳动节", "isHoliday": True},
        {"date": "2025-05-31", "name": "端午节", "isHoliday": True},
        {"date": "2025-06-01", "name": "端午节", "isHoliday": True},
        {"date": "2025-06-02", "name": "端午节", "isHoliday": True},
        {"date": "2025-09-28", "name": "国庆节补班", "isHoliday": False},
        {"date": "2025-10-01", "name": "国庆节", "isHoliday": True},
        {"date": "2025-10-02", "name": "国庆节", "isHoliday": True},
        {"date": "2025-10-03", "name": "国庆节", "isHoliday": True},
        {"date": "2025-10-04", "name": "国庆节", "isHoliday": True},
        {"date": "2025-10-05", "name": "国庆节", "isHoliday": True},
        {"date": "2025-10-06", "name": "中秋节", "isHoliday": True},
        {"date": "2025-10-07", "name": "国庆节调休", "isHoliday": True},
        {"date": "2025-10-08", "name": "国庆节调休", "isHoliday": True},
        {"date": "2025-10-11", "name": "国庆节补班", "isHoliday": False},
    ],
    2026: [
        {"date": "2026-01-01", "name": "元旦", "isHoliday": True},
        {"date": "2026-02-16", "name": "春节", "isHoliday": True},
        {"date": "2026-02-17", "name": "春节", "isHoliday": True},
        {"date": "2026-02-18", "name": "春节", "isHoliday": True},
        {"date": "2026-02-19", "name": "春节", "isHoliday": True},
        {"date": "2026-02-20", "name": "春节", "isHoliday": True},
        {"date": "2026-02-21", "name": "春节", "isHoliday": True},
        {"date": "2026-02-22", "name": "春节", "isHoliday": True},
        {"date": "2026-04-04", "name": "清明节", "isHoliday": True},
        {"date": "2026-04-05", "name": "清明节", "isHoliday": True},
        {"date": "2026-04-06", "name": "清明节", "isHoliday": True},
        {"date": "2026-05-01", "name": "劳动节", "isHoliday": True},
        {"date": "2026-05-02", "name": "劳动节", "isHoliday": True},
        {"date": "2026-05-03", "name": "劳动节", "isHoliday": True},
        {"date": "2026-05-04", "name": "劳动节", "isHoliday": True},
        {"date": "2026-05-05", "name": "劳动节", "isHoliday": True},
        {"date": "2026-06-19", "name": "端午节", "isHoliday": True},
        {"date": "2026-06-20", "name": "端午节", "isHoliday": True},
        {"date": "2026-06-21", "name": "端午节", "isHoliday": True},
        {"date": "2026-09-25", "name": "中秋节", "isHoliday": True},
        {"date": "2026-09-26", "name": "中秋节", "isHoliday": True},
        {"date": "2026-09-27", "name": "中秋节", "isHoliday": True},
        {"date": "2026-10-01", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-02", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-03", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-04", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-05", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-06", "name": "国庆节", "isHoliday": True},
        {"date": "2026-10-07", "name": "国庆节", "isHoliday": True},
    ]
}


def normalize_holiday_name(raw_name: str | None, is_holiday: bool) -> str:
    """规范化官方节假日接口返回的放假/补班名称。

    示例:
    - 春节 -> 春节
    - 春节前调休 / 春节后调休 -> 春节调休
    - is_holiday=False 的春节前调休 -> 春节补班
    """
    name = (raw_name or "").strip()
    if not name:
        return "节假日" if is_holiday else "补班"

    if is_holiday and name in {"除夕", "初一", "初二", "初三", "初四", "初五", "初六", "初七"}:
        return "春节"

    base = re.sub(r"[前后]?(调休|补班|放假|假期)$", "", name).strip()
    base = base or name.replace("补班", "").replace("调休", "").strip()
    if not base:
        base = "节假日" if is_holiday else "调休"

    if is_holiday:
        return f"{base}调休" if "调休" in name else base
    return f"{base}补班"


def read_proxy_config(config_path=PROXY_CONFIG) -> dict[str, str]:
    if not config_path.exists():
        return {}
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        key: str(value).strip()
        for key, value in payload.items()
        if key in {"http", "https", "no_proxy"} and str(value).strip()
    }


def resolve_proxy_map(env: dict[str, str] | None = None, file_proxies: dict[str, str] | None = None) -> dict[str, str]:
    env = env or os.environ
    if str(env.get("ATTENDANCE_DISABLE_PROXY", default="")).strip().lower() in {"1", "true", "yes", "y", "on"}:
        return {}
    file_proxies = file_proxies if file_proxies is not None else read_proxy_config()
    proxies = dict(file_proxies)

    http_proxy = env.get("ATTENDANCE_HTTP_PROXY") or env.get("HTTP_PROXY") or env.get("http_proxy")
    https_proxy = env.get("ATTENDANCE_HTTPS_PROXY") or env.get("HTTPS_PROXY") or env.get("https_proxy")
    if http_proxy:
        proxies["http"] = http_proxy
    if https_proxy:
        proxies["https"] = https_proxy
    no_proxy = env.get("ATTENDANCE_NO_PROXY") or env.get("NO_PROXY") or env.get("no_proxy")
    if no_proxy:
        proxies["no_proxy"] = no_proxy
    return proxies


def no_proxy_patterns(proxies: dict[str, str]) -> list[str]:
    return [item.strip() for item in proxies.get("no_proxy", "").split(",") if item.strip()]


def should_bypass_proxy(url: str, proxies: dict[str, str]) -> bool:
    hostname = urllib.parse.urlsplit(url).hostname or ""
    for pattern in no_proxy_patterns(proxies):
        if fnmatch.fnmatch(hostname, pattern) or (pattern.startswith(".") and hostname.endswith(pattern)):
            return True
    return False


def build_url_opener(url: str | None = None):
    proxies = resolve_proxy_map()
    if url and should_bypass_proxy(url, proxies):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    handler_proxies = {key: value for key, value in proxies.items() if key in {"http", "https"}}
    if handler_proxies:
        return urllib.request.build_opener(urllib.request.ProxyHandler(handler_proxies))
    return urllib.request.build_opener()


def open_url(url: str, timeout: int = 8):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AttendanceCalculator/1.0",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    return build_url_opener(url).open(request, timeout=timeout)


def build_year_calendar(year: int, holidays: list[dict]) -> list[dict]:
    override_map = {item["date"]: item for item in holidays}
    months = []
    for month in range(1, 13):
        days = []
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            current = date(year, month, day)
            iso_date = current.isoformat()
            override = override_map.get(iso_date, {})
            is_holiday = bool(override.get("isHoliday", False))
            is_workday_override = override.get("isHoliday") is False
            days.append(
                {
                    "date": iso_date,
                    "day": day,
                    "weekday": current.weekday() + 1,
                    "isWeekend": current.weekday() >= 5,
                    "isHoliday": is_holiday,
                    "isWorkdayOverride": is_workday_override,
                    "dayType": "holiday" if is_holiday else "workday" if is_workday_override else "normal",
                    "name": override.get("name", ""),
                }
            )
        months.append({"month": month, "label": f"{year}-{month:02d}", "days": days})
    return months


def selectable_workdays(month: str, holidays: set[str], workday_overrides: set[str] | None = None) -> list[str]:
    year, month_num = map(int, month.split("-"))
    workday_overrides = workday_overrides or set()
    result = []
    for day in range(1, calendar.monthrange(year, month_num)[1] + 1):
        current = date(year, month_num, day)
        iso_date = current.isoformat()
        if (current.weekday() < 5 and iso_date not in holidays) or iso_date in workday_overrides:
            result.append(iso_date)
    return result


def fetch_china_holidays(year: int) -> tuple[list[dict], str]:
    try:
        with open_url(url=f"https://timor.tech/api/holiday/year/{year}", timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        holidays = []
        for month_day, item in (payload.get("holiday") or {}).items():
            is_holiday = item.get("holiday") is True
            holidays.append({"date": f"{year}-{month_day}", "name": normalize_holiday_name(item.get("name"), is_holiday), "isHoliday": is_holiday})
        holidays = sorted(holidays, key=lambda item: item["date"])
        if holidays:
            return holidays, "timor.tech 中国节假日接口"
    except Exception:
        pass

    try:
        with open_url(url=f"https://date.nager.at/api/v3/PublicHolidays/{year}/CN", timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        holidays = sorted(
            [
                {"date": item["date"], "name": normalize_holiday_name(item.get("localName") or item.get("name"), is_holiday=True), "isHoliday": True}
                for item in payload
                if valid_date(item.get("date", ""))
            ],
            key=lambda item: item["date"],
        )
        if holidays:
            return holidays, "Nager.Date Public Holidays API"
    except Exception:
        pass

    return FALLBACK_HOLIDAYS.get(year, []), "内置离线兜底数据"


def valid_month(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m")
        return True
    except ValueError:
        return False


def valid_date(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except (TypeError, ValueError):
        return False


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def today_iso() -> str:
    return date.today().isoformat()
