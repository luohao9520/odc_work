from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app

ENCRYPTED_VALUE_PREFIX = "enc:v1:"


def _fernet() -> Fernet:
    secret_key = str(current_app.config["SECRET_KEY"]).encode("utf-8")
    digest = hashlib.sha256(b"attendance-seat-booking-password-v1|" + secret_key).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    if value.startswith(ENCRYPTED_VALUE_PREFIX):
        return value
    token = _fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return f"{ENCRYPTED_VALUE_PREFIX}{token}"


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    if not value.startswith(ENCRYPTED_VALUE_PREFIX):
        return value
    token = value[len(ENCRYPTED_VALUE_PREFIX):]
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("外部平台密码解密失败，请重新保存密码。") from exc
