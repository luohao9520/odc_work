from __future__ import annotations

import sqlite3
from functools import wraps

from flask import Blueprint, jsonify, session, request
from werkzeug.security import check_password_hash, generate_password_hash

from ...core.database import get_db
from ...shared.calendar_utils import now_iso

auth_bp = Blueprint("auth", __name__, url_prefix="/api")

PAGE_DEFINITIONS = [
    {"id": "attendance", "label": "出勤登记", "path": "index.html"},
    {"id": "holidays", "label": "节假日调整", "path": "holidays.html"},
    {"id": "seat-booking", "label": "座位预约", "path": "seat-booking.html"},
    {"id": "api-docs", "label": "接口测试", "path": "api-docs.html"},
    {"id": "admin", "label": "系统管理", "path": "admin.html", "adminOnly": True},
]
PAGE_IDS = {page["id"] for page in PAGE_DEFINITIONS}
DEFAULT_USER_PAGE_IDS = [page["id"] for page in PAGE_DEFINITIONS if not page.get("adminOnly")]
ADMIN_PAGE_IDS = [page["id"] for page in PAGE_DEFINITIONS]


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    row = get_db().execute("SELECT id, username, role, is_active, deactivated_at FROM users WHERE id = ?", (user_id,)).fetchone()
    if row and not bool(row["is_active"]):
        session.clear()
        return None
    return row


def role_for_username(username: str) -> str:
    return "admin" if username.strip().lower() == "luohao" else "user"


def normalize_role(username: str, role: str | None) -> str:
    if username.strip().lower() == "luohao":
        return "admin"
    return "admin" if str(role or "user").strip().lower() == "admin" else "user"


def default_page_ids_for_role(role: str) -> list[str]:
    return list(ADMIN_PAGE_IDS if role == "admin" else DEFAULT_USER_PAGE_IDS)


def replace_user_page_permissions(user_id: int, page_ids: list[str], role: str, *, commit: bool = True) -> list[str]:
    allowed = set(PAGE_IDS)
    cleaned = []
    for page_id in page_ids:
        if page_id in allowed and page_id not in cleaned:
            cleaned.append(page_id)
    if role != "admin":
        cleaned = [page_id for page_id in cleaned if page_id != "admin"]
    if not cleaned:
        cleaned = default_page_ids_for_role(role)
    db = get_db()
    db.execute("DELETE FROM user_page_permissions WHERE user_id = ?", (user_id,))
    db.executemany(
        "INSERT INTO user_page_permissions(user_id, page_id) VALUES (?, ?)",
        [(user_id, page_id) for page_id in cleaned],
    )
    if commit:
        db.commit()
    return cleaned


def ensure_user_page_permissions(user_id: int, role: str) -> list[str]:
    db = get_db()
    rows = db.execute("SELECT page_id FROM user_page_permissions WHERE user_id = ? ORDER BY page_id", (user_id,)).fetchall()
    if rows:
        selected = {row["page_id"] for row in rows if row["page_id"] in PAGE_IDS}
        return [page_id for page_id in ADMIN_PAGE_IDS if page_id in selected]
    return replace_user_page_permissions(user_id, default_page_ids_for_role(role), role)


def page_permissions_for_user(user_id: int, role: str) -> list[str]:
    if role == "admin":
        ensure_user_page_permissions(user_id, role)
        return list(ADMIN_PAGE_IDS)
    return [page_id for page_id in ensure_user_page_permissions(user_id, role) if page_id != "admin"]


def serialize_user(row) -> dict:
    role = normalize_role(row["username"], row["role"] if "role" in row.keys() else role_for_username(row["username"]))
    is_admin = role == "admin"
    is_active = bool(row.get("is_active", True))
    deactivated_at = row.get("deactivated_at")
    return {
        "id": row["id"],
        "username": row["username"],
        "role": role,
        "isAdmin": is_admin,
        "isActive": is_active,
        "deactivatedAt": deactivated_at,
        "accessiblePages": page_permissions_for_user(row["id"], role),
    }


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id") or not current_user():
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        row = current_user()
        if not row:
            return jsonify({"error": "unauthorized"}), 401
        if not serialize_user(row)["isAdmin"]:
            return jsonify({"error": "forbidden"}), 403
        return fn(*args, **kwargs)

    return wrapper


@auth_bp.post("/register")
def register():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if len(username) < 3:
        return jsonify({"error": "用户名至少 3 个字符"}), 400
    if len(password) < 6:
        return jsonify({"error": "密码至少 6 个字符"}), 400

    db = get_db()
    role = role_for_username(username)
    try:
        cur = db.execute(
            "INSERT INTO users(username, password_hash, created_at, role) VALUES (?, ?, ?, ?)",
            (username, generate_password_hash(password), now_iso(), role),
        )
        db.execute("INSERT INTO settings(user_id, target_rate) VALUES (?, ?)", (cur.lastrowid, 60))
        replace_user_page_permissions(cur.lastrowid, default_page_ids_for_role(role), role, commit=False)
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "用户名已存在"}), 409

    session["user_id"] = cur.lastrowid
    return jsonify({"user": serialize_user(get_db().execute("SELECT id, username, role, is_active, deactivated_at FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())})


@auth_bp.post("/login")
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    row = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "用户名或密码不正确"}), 401
    if not bool(row["is_active"]):
        return jsonify({"error": "用户已停用，请联系管理员"}), 403
    session["user_id"] = row["id"]
    return jsonify({"user": serialize_user(row)})


@auth_bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.get("/me")
@login_required
def me():
    row = current_user()
    return jsonify({"user": serialize_user(row)})
