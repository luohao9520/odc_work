from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from typing import Any

from ..shared.calendar_utils import build_url_opener

BASE_URL = "http://meet.fxodc.clps.com.cn"
LOGIN_PATH = "/Mobile/login/login"
LOGIN_POST_PATH = "/Mobile/login/loginpost"
BOOK_LIST_PATH = "/Mobile/seat/getbooklist"
SEAT_LIST_PATH = "/Mobile/seat/getseatlist"
BOOK_SEAT_PATH = "/Mobile/seat/bookseat"
CANCEL_SEAT_PATH = "/Mobile/seat/cancelbookseat"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SeatBookingAssistant/1.0"
LIMIT_MESSAGE = "预定次数不可超过3次"


class SeatBookingError(RuntimeError):
    pass


class SeatBookingClient:
    """Small urllib-based client for the external seat booking platform.

    The target system is an internal mobile site. Its exact response shape may vary, so this
    client keeps payload keys conservative and normalizes common JSON/list/message formats.
    """

    def __init__(self, base_url: str = BASE_URL, timeout: int = 12):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.cookies = CookieJar()
        self.opener = build_url_opener(self.base_url)
        self.opener.add_handler(urllib.request.HTTPCookieProcessor(self.cookies))

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _post_form(self, path: str, payload: dict[str, Any]) -> dict:
        data = urllib.parse.urlencode({key: value for key, value in payload.items() if value is not None}).encode("utf-8")
        request = urllib.request.Request(
            self._url(path),
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": self._url(LOGIN_PATH),
            },
            method="POST",
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            text = response.read().decode("utf-8", "ignore")
        return parse_platform_response(text)

    def _get(self, path: str) -> dict:
        request = urllib.request.Request(
            self._url(path),
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": self._url("/Mobile/seat/index"),
            },
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            text = response.read().decode("utf-8", "ignore")
        return parse_platform_response(text)

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._url(path),
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": self._url("/Mobile/seat/index"),
            },
            method="POST",
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            text = response.read().decode("utf-8", "ignore")
        return parse_platform_response(text)

    def login(self, username: str, password: str) -> dict:
        if not username or not password:
            raise SeatBookingError("请先填写外部预约平台账号和密码。")
        payload = {
            "username": username,
            "password": password,
            "zropenid": "",
        }
        # The mobile login page posts this exact form to /Mobile/login/loginpost;
        # response {"code":1,"desc":"} means success.
        result = self._post_form(LOGIN_POST_PATH, payload)
        if is_error_response(result):
            raise SeatBookingError(result.get("message") or "外部预约平台登录失败。")
        return result

    def get_book_list(self) -> dict:
        return self._get(BOOK_LIST_PATH)

    def get_seat_list(self, booking_date: str) -> dict:
        return self._post_json(SEAT_LIST_PATH, {"book_date": booking_date})

    def book_seat(self, booking_date: str, seat_id: str, seat_name: str = "") -> dict:
        return self._post_json(BOOK_SEAT_PATH, {"book_date": booking_date, "seat_no": seat_id})

    def cancel_seat(self, booking_date: str) -> dict:
        return self._post_json(CANCEL_SEAT_PATH, {"book_date": booking_date})


def parse_platform_response(text: str) -> dict:
    stripped = (text or "").strip()
    if not stripped:
        return {"ok": False, "message": "外部平台返回空响应。", "raw": ""}
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        return {"ok": LIMIT_MESSAGE in stripped or "成功" in stripped, "message": stripped, "raw": stripped}
    if isinstance(payload, list):
        return {"ok": True, "data": payload, "message": "OK", "raw": payload}
    if not isinstance(payload, dict):
        return {"ok": True, "data": payload, "message": str(payload), "raw": payload}
    message = str(payload.get("msg") or payload.get("message") or payload.get("info") or payload.get("errmsg") or "")
    status = payload.get("status", payload.get("code", payload.get("success", payload.get("ok"))))
    ok = status in {True, 1, "1", "true", "True", "success", "SUCCESS", "ok", "OK", 200, "200"}
    if not ok and (LIMIT_MESSAGE in message or "成功" in message):
        ok = True
    payload.setdefault("message", message or "OK")
    payload.setdefault("ok", ok)
    payload.setdefault("raw", payload.copy())
    return payload


def is_error_response(result: dict) -> bool:
    message = str(result.get("message") or "")
    if LIMIT_MESSAGE in message:
        return False
    return result.get("ok") is False and any(word in message for word in ("失败", "错误", "error", "Error", "无效"))


def extract_seats(result: dict) -> list[dict]:
    data = result.get("seatinfo") or result.get("data") or result.get("rows") or result.get("list") or result.get("seatlist") or result.get("seats") or []
    if isinstance(data, dict):
        data = data.get("list") or data.get("rows") or data.get("data") or []
    if not isinstance(data, list):
        return []
    seats = []
    for item in data:
        if isinstance(item, str):
            seat_id = item.strip()
            if seat_id:
                seats.append({"id": seat_id, "name": seat_id, "available": True, "raw": item})
            continue
        if not isinstance(item, dict):
            continue
        seat_id = str(item.get("seatid") or item.get("seatId") or item.get("id") or item.get("value") or "").strip()
        seat_name = str(item.get("seatname") or item.get("seatName") or item.get("name") or item.get("label") or seat_id).strip()
        status = str(item.get("status") or item.get("state") or item.get("isbook") or item.get("disabled") or "").lower()
        available = status not in {"1", "true", "booked", "disabled", "unavailable", "已预订", "不可用"}
        if seat_id:
            seats.append({"id": seat_id, "name": seat_name, "available": available, "raw": item})
    return seats


def extract_bookings(result: dict) -> list[dict]:
    """Normalize existing booking records returned by the external platform.

    The platform has returned several shapes in practice (top-level lists, nested
    data/list/rows containers, and mixed key names), so this keeps parsing
    conservative: a record is synced only when it contains a recognizable date.
    """
    date_keys = ("book_date", "bookDate", "bookingDate", "date", "day", "bookday", "bookDay", "book_time", "bookTime")
    seat_keys = ("seat_no", "seatNo", "seat_id", "seatId", "seatid", "id", "value", "seat", "seatNoText")
    seat_name_keys = ("seat_name", "seatName", "seatname", "name", "label", "seat", "seatNoText")
    status_keys = ("status", "state", "book_status", "bookStatus")

    def normalize_date(value) -> str:
        match = re.search(r"(20\d{2})\D?(\d{1,2})\D?(\d{1,2})", str(value or ""))
        if not match:
            return ""
        year, month, day = match.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"

    def walk(value):
        if isinstance(value, list):
            for item in value:
                yield from walk(item)
            return
        if not isinstance(value, dict):
            return
        if any(value.get(key) for key in date_keys):
            yield value
            return
        for key in ("data", "rows", "list", "items", "records", "result", "results", "bookinfo", "bookInfo", "booklist", "bookList", "bookingList", "seatlist"):
            if key in value:
                yield from walk(value[key])

    bookings = []
    seen = set()
    for item in walk(result):
        booking_date = normalize_date(next((item.get(key) for key in date_keys if item.get(key)), ""))
        if not booking_date:
            continue
        seat_id = str(next((item.get(key) for key in seat_keys if item.get(key)), "")).strip()
        seat_name = str(next((item.get(key) for key in seat_name_keys if item.get(key)), seat_id)).strip() or seat_id
        status = str(next((item.get(key) for key in status_keys if item.get(key)), "success")).strip().lower() or "success"
        key = (booking_date, seat_id, seat_name)
        if key in seen:
            continue
        seen.add(key)
        bookings.append({"bookingDate": booking_date, "seatId": seat_id, "seatName": seat_name, "status": status, "raw": item})
    return bookings
