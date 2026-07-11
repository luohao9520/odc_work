from __future__ import annotations

from flask import Blueprint, jsonify, request

from ...core.database import get_db
from ...domain.retention.cleanup import get_cleanup_settings, run_data_cleanup, update_cleanup_settings
from ...jobs.data_cleanup_scheduler import scheduler_status
from ...shared.calendar_utils import now_iso
from ..auth.routes import PAGE_DEFINITIONS, current_user, admin_required, normalize_role, replace_user_page_permissions, serialize_user

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


def _select_user(user_id: int):
    return get_db().execute("SELECT id, username, role, created_at, is_active, deactivated_at FROM users WHERE id = ?", (user_id,)).fetchone()


def _active_admin_count(exclude_user_id: int | None = None) -> int:
    params = []
    where = "WHERE role = 'admin' AND is_active = 1"
    if exclude_user_id is not None:
        where += " AND id != ?"
        params.append(exclude_user_id)
    return int(get_db().execute(f"SELECT COUNT(*) AS c FROM users {where}", params).fetchone()["c"])


def _guard_user_mutation(target, *, deleting: bool = False, deactivating: bool = False):
    if not target:
        return jsonify({"error": "用户不存在"}), 404
    actor = current_user()
    if actor and actor["id"] == target["id"] and (deleting or deactivating):
        return jsonify({"error": "不能删除或停用当前登录用户"}), 400
    if target["username"].strip().lower() == "luohao" and (deleting or deactivating):
        return jsonify({"error": "不能删除或停用当前管理员 luohao"}), 400
    if target["role"] == "admin" and bool(target["is_active"]) and (deleting or deactivating) and _active_admin_count(exclude_user_id=target["id"]) <= 0:
        return jsonify({"error": "至少需要保留一个启用状态的管理员"}), 400
    return None


@admin_bp.get("/users")
@admin_required
def list_users():
    rows = get_db().execute("SELECT id, username, role, created_at, is_active, deactivated_at FROM users ORDER BY username ASC").fetchall()
    users = []
    for row in rows:
        user = serialize_user(row)
        user["createdAt"] = row["created_at"]
        users.append(user)
    return jsonify({"users": users, "pages": PAGE_DEFINITIONS})


@admin_bp.put("/users/<int:user_id>")
@admin_required
def update_user_access(user_id: int):
    payload = request.get_json(silent=True) or {}
    db = get_db()
    target = _select_user(user_id)
    if not target:
        return jsonify({"error": "用户不存在"}), 404

    requested_role = normalize_role(target["username"], payload.get("role"), target["role"])
    actor = current_user()
    if actor and actor["id"] == user_id and requested_role != "admin":
        return jsonify({"error": "不能取消自己的管理员角色"}), 400

    pages = payload.get("accessiblePages")
    if pages is None:
        pages = serialize_user(target)["accessiblePages"]
    if not isinstance(pages, list):
        return jsonify({"error": "accessiblePages 必须是数组"}), 400

    db.execute("UPDATE users SET role = ? WHERE id = ?", (requested_role, user_id))
    cleaned_pages = replace_user_page_permissions(user_id, [str(page_id) for page_id in pages], requested_role, commit=False)
    db.commit()
    updated = _select_user(user_id)
    user = serialize_user(updated)
    user["createdAt"] = updated["created_at"]
    user["storedAccessiblePages"] = cleaned_pages
    return jsonify({"user": user, "pages": PAGE_DEFINITIONS})


@admin_bp.patch("/users/<int:user_id>/status")
@admin_required
def update_user_status(user_id: int):
    payload = request.get_json(silent=True) or {}
    if "isActive" not in payload:
        return jsonify({"error": "isActive 必须提供"}), 400
    active = bool(payload.get("isActive"))
    target = _select_user(user_id)
    guard = _guard_user_mutation(target, deactivating=not active)
    if guard:
        return guard

    db = get_db()
    db.execute(
        "UPDATE users SET is_active = ?, deactivated_at = ? WHERE id = ?",
        (1 if active else 0, now_iso() if not active else None, user_id)
    )
    db.commit()
    updated = _select_user(user_id)
    user = serialize_user(updated)
    user["createdAt"] = updated["created_at"]
    return jsonify({"user": user})


@admin_bp.delete("/users/<int:user_id>")
@admin_required
def delete_user(user_id: int):
    target = _select_user(user_id)
    guard = _guard_user_mutation(target, deleting=True)
    if guard:
        return guard
    db = get_db()
    username = target["username"]
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
    return jsonify({"ok": True, "deletedUserId": user_id, "deletedUsername": username})


@admin_bp.get("/cleanup")
@admin_required
def get_cleanup_config():
    return jsonify({"settings": get_cleanup_settings(), "scheduler": scheduler_status()})


@admin_bp.put("/cleanup")
@admin_required
def save_cleanup_config():
    payload = request.get_json(silent=True) or {}
    try:
        settings = update_cleanup_settings(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"settings": settings, "scheduler": scheduler_status()})


@admin_bp.post("/cleanup/run")
@admin_required
def run_cleanup_now():
    payload = request.get_json(silent=True) or {}
    dry_run = bool(payload.get("dryRun", False))
    vacuum = bool(payload.get("vacuum", not dry_run))
    result = run_data_cleanup(dry_run=dry_run, vacuum=vacuum)
    result["scheduler"] = scheduler_status()
    return jsonify(result)
