# -*- coding: utf-8 -*-
"""مدیریت حساب‌ها، ورود/خروج، لایه‌ها و اپراتورهای فعال با پشتیبانی از Hash کلمه عبور."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import tempfile
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, List, Dict


from app.core.storage_paths import LEGACY_DATA_ROOT, SERVICE_ROOT, STATE_DIR


def hash_password(password: str) -> str:
    """Store passwords with a salted, deliberately slow standard-library hash."""
    if not password:
        return ""
    salt = secrets.token_bytes(16)
    rounds = 310_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return f"pbkdf2_sha256${rounds}${salt.hex()}${digest.hex()}"


def _password_matches(password: str, stored: str) -> bool:
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _, rounds, salt, digest = stored.split("$", 3)
            rounds = int(rounds)
            if not 200_000 <= rounds <= 1_000_000:
                return False
            actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), rounds)
            return hmac.compare_digest(actual.hex(), digest)
        except (ValueError, TypeError):
            return False
    # Upgrade existing SHA-256 and legacy plaintext accounts on successful login.
    encoded = password.encode("utf-8")
    sha256 = hashlib.sha256(encoded).hexdigest()
    try:
        legacy_plaintext = hmac.compare_digest(stored.encode("utf-8"), encoded)
    except (UnicodeEncodeError, TypeError):
        legacy_plaintext = False
    return hmac.compare_digest(stored, sha256) or legacy_plaintext


@dataclass
class OperatorAccount:
    username: str
    password_hash: str
    full_name: str
    role: str = "operator"  # "admin" | "operator"
    is_active: bool = True
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    lunch_used_on: Optional[str] = None
    can_manage_drivers: bool = False


@dataclass
class ActiveOperatorSession:
    token: str
    username: str
    full_name: str
    role: str
    login_time: str
    last_seen: str
    password_change_required: bool = False
    lunch_until: float = 0


class OperatorAuthManager:
    STORAGE_PATH = STATE_DIR / "operators.json"
    LEGACY_STORAGE_PATHS = (LEGACY_DATA_ROOT / "operators.json", SERVICE_ROOT / "operators.json")

    def __init__(self):
        self._lock = threading.RLock()
        self.accounts: Dict[str, OperatorAccount] = {}
        self.active_sessions: Dict[str, ActiveOperatorSession] = {}
        self._load_accounts()

    def _session_ttl_seconds(self) -> int:
        from app.core.config import get_settings
        return get_settings().operator_session_timeout_minutes * 60

    @staticmethod
    def _today_in_tehran() -> str:
        return datetime.now(timezone(timedelta(hours=3, minutes=30))).date().isoformat()

    def _session_expired(self, sess: ActiveOperatorSession) -> bool:
        if time.time() < sess.lunch_until:
            return False
        try:
            idle = (datetime.now() - datetime.fromisoformat(sess.last_seen)).total_seconds()
        except ValueError:
            idle = self._session_ttl_seconds() + 1
        return idle > self._session_ttl_seconds()

    def _load_accounts(self):
        """بارگذاری حساب‌ها یا bootstrap امن ادمین از متغیر محیطی."""
        source_path = self.STORAGE_PATH
        if not source_path.exists():
            source_path = next((path for path in self.LEGACY_STORAGE_PATHS if path.exists()), source_path)
        if source_path.exists():
            try:
                with open(source_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for u, acc in data.items():
                        self.accounts[u] = OperatorAccount(**acc)
                if "admin" not in self.accounts:
                    self._bootstrap_admin()
                elif source_path.resolve() != self.STORAGE_PATH.resolve():
                    self._save_accounts()
                return
            except Exception as exc:
                raise RuntimeError(f"فایل حساب اپراتورها خوانده نشد: {source_path}") from exc
        self._bootstrap_admin()

    def _bootstrap_admin(self):
        from app.core.config import get_settings
        password = get_settings().operator_admin_password
        if not password:
            return
        if len(password) < 12:
            raise RuntimeError("OPERATOR_ADMIN_PASSWORD باید حداقل ۱۲ کاراکتر باشد")
        self.accounts["admin"] = OperatorAccount(
            "admin", hash_password(password), "مدیر سیستم (ادمین)", role="admin")
        self._save_accounts()

    def _save_accounts(self):
        try:
            self.STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.STORAGE_PATH.parent,
                                             prefix=".operators-", suffix=".tmp", delete=False) as f:
                tmp_path = Path(f.name)
                json.dump({u: asdict(acc) for u, acc in self.accounts.items()}, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.STORAGE_PATH)
        except Exception as exc:
            try:
                if "tmp_path" in locals():
                    tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError("فایل حساب اپراتورها ذخیره نشد") from exc

    def login(self, username: str, password: str) -> Optional[ActiveOperatorSession]:
        with self._lock:
            acc = self.accounts.get(username)
            if not acc or not acc.is_active:
                return None

            if not _password_matches(password, acc.password_hash):
                return None

            if not acc.password_hash.startswith("pbkdf2_sha256$"):
                acc.password_hash = hash_password(password)
                self._save_accounts()

            # A second login replaces the old browser session for this account.
            self.active_sessions = {t: s for t, s in self.active_sessions.items() if s.username != username}
            token = f"optok_{uuid.uuid4().hex}"
            now_iso = datetime.now().isoformat()
            sess = ActiveOperatorSession(
                token=token,
                username=acc.username,
                full_name=acc.full_name,
                role=acc.role,
                login_time=now_iso,
                last_seen=now_iso,
                password_change_required=len(password) < 12,
            )
            self.active_sessions[token] = sess
            return sess

    def get_session(self, token: str) -> Optional[ActiveOperatorSession]:
        with self._lock:
            sess = self.active_sessions.get(token)
            if sess:
                acc = self.accounts.get(sess.username)
                if self._session_expired(sess) or not acc or not acc.is_active or acc.role != sess.role:
                    self.active_sessions.pop(token, None)
                    return None
                sess.last_seen = datetime.now().isoformat()
            return sess

    def start_lunch(self, sess: ActiveOperatorSession) -> tuple[bool, str, Optional[float]]:
        with self._lock:
            if self.active_sessions.get(sess.token) is not sess:
                return False, "نشست اپراتور معتبر نیست", None
            if sess.role != "operator":
                return False, "استراحت ناهار برای حساب اپراتور است", None
            acc = self.accounts.get(sess.username)
            if not acc or not acc.is_active:
                return False, "حساب اپراتور فعال نیست", None
            today = self._today_in_tehran()
            if acc.lunch_used_on == today:
                return False, "سهم استراحت ناهار امروز استفاده شده است", None
            until = time.time() + 60 * 60
            previous = acc.lunch_used_on
            acc.lunch_used_on = today
            try:
                self._save_accounts()
            except Exception:
                acc.lunch_used_on = previous
                raise
            sess.lunch_until = until
            return True, "نشست برای یک ساعت تمدید شد", until

    def lunch_status(self, sess: ActiveOperatorSession) -> dict:
        with self._lock:
            acc = self.accounts.get(sess.username)
            active = time.time() < sess.lunch_until
            return {
                "lunch_active": active,
                "lunch_until": datetime.fromtimestamp(sess.lunch_until, timezone.utc).isoformat() if active else None,
                "lunch_available_today": bool(acc and acc.lunch_used_on != self._today_in_tehran()),
            }

    def logout(self, token: str, history_mgr) -> tuple[bool, str]:
        with self._lock:
            sess = self.active_sessions.get(token)
            if not sess:
                return False, "نشست یافت نشد"

            if sess.role != "admin":
                assigned_chats = [
                    s for s in history_mgr._sessions.values()
                    if s.metadata.get("assigned_operator") == sess.username and s.is_active and s.metadata.get("status") != "completed"
                ]
                if assigned_chats:
                    return False, f"شما {len(assigned_chats)} چت اقدام‌نشده دارید. لطفاً ابتدا تکالیف چت‌ها را مشخص کنید یا منتقل نمایید."

            del self.active_sessions[token]
            return True, "خروج با موفقیت انجام شد"

    def update_profile(self, username: str, full_name: Optional[str] = None, password: Optional[str] = None) -> bool:
        with self._lock:
            acc = self.accounts.get(username)
            if not acc:
                return False
            if password and password.strip() and len(password) < 12:
                return False
            if full_name:
                acc.full_name = full_name
            if password and password.strip():
                acc.password_hash = hash_password(password)
                self.active_sessions = {t: s for t, s in self.active_sessions.items() if s.username != username}
            else:
                for sess in self.active_sessions.values():
                    if sess.username == username:
                        sess.full_name = acc.full_name
            self._save_accounts()
            return True

    def create_operator(self, username: str, password: str, full_name: str, role: str = "operator", can_manage_drivers: bool = False) -> tuple[bool, str]:
        with self._lock:
            if not username or len(username) > 64 or not username.replace("_", "").replace("-", "").isalnum():
                return False, "نام کاربری نامعتبر است"
            if len(password) < 12:
                return False, "رمز عبور باید حداقل ۱۲ کاراکتر باشد"
            if role not in ("operator", "admin"):
                return False, "نقش کاربر نامعتبر است"
            if username in self.accounts:
                return False, "این نام کاربری قبلاً وجود دارد"
            self.accounts[username] = OperatorAccount(
                username=username,
                password_hash=hash_password(password),
                full_name=full_name,
                role=role,
                can_manage_drivers=can_manage_drivers
            )
            self._save_accounts()
            return True, "حساب کاربر با موفقیت ایجاد شد"

    def update_operator_by_admin(self, username: str, full_name: Optional[str] = None,
                                 password: Optional[str] = None, role: Optional[str] = None,
                                 is_active: Optional[bool] = None, can_manage_drivers: Optional[bool] = None) -> tuple[bool, str]:
        with self._lock:
            acc = self.accounts.get(username)
            if not acc:
                return False, "حساب اپراتور یافت نشد"
            if password is not None and password.strip() and len(password) < 12:
                return False, "رمز عبور باید حداقل ۱۲ کاراکتر باشد"
            if role is not None and role not in ("operator", "admin"):
                return False, "نقش کاربر نامعتبر است"
            if username == "admin" and (role == "operator" or is_active is False):
                return False, "حساب ادمین اصلی قابل تنزل یا غیرفعال‌سازی نیست"
            if full_name is not None:
                acc.full_name = full_name
            if password is not None and password.strip():
                acc.password_hash = hash_password(password)
            if role is not None:
                acc.role = role
            if is_active is not None:
                acc.is_active = is_active
            if can_manage_drivers is not None:
                acc.can_manage_drivers = can_manage_drivers
            if password is not None or role is not None or is_active is False:
                self.active_sessions = {t: s for t, s in self.active_sessions.items() if s.username != username}
            else:
                for sess in self.active_sessions.values():
                    if sess.username == username:
                        sess.full_name = acc.full_name
            self._save_accounts()
            return True, "اطلاعات اپراتور به روز شد"

    def delete_operator(self, username: str) -> tuple[bool, str]:
        with self._lock:
            if username not in self.accounts:
                return False, "حساب یافت نشد"
            if username == "admin":
                return False, "حساب ادمین اصلی قابل حذف نیست"
            del self.accounts[username]
            self.active_sessions = {t: s for t, s in self.active_sessions.items() if s.username != username}
            self._save_accounts()
            return True, "حساب اپراتور حذف شد"

    def list_all_accounts(self) -> List[dict]:
        with self._lock:
            return [
                {
                    "username": acc.username,
                    "full_name": acc.full_name,
                    "role": acc.role,
                    "is_active": acc.is_active,
                    "can_manage_drivers": acc.can_manage_drivers,
                    "created_at": acc.created_at
                }
                for acc in self.accounts.values()
            ]

    def get_active_operators(self) -> List[dict]:
        with self._lock:
            out = {}
            for token, sess in list(self.active_sessions.items()):
                acc = self.accounts.get(sess.username)
                if self._session_expired(sess) or not acc or not acc.is_active or acc.role != sess.role:
                    self.active_sessions.pop(token, None)
                    continue
                if sess.role == "operator":
                    out[sess.username] = {
                        "username": sess.username,
                        "full_name": sess.full_name,
                        "role": sess.role,
                        "login_time": sess.login_time,
                    }
            return list(out.values())

    def is_operator_active(self, username: str) -> bool:
        return any(op["username"] == username for op in self.get_active_operators())

    def select_next_operator_round_robin(self, current_counter: int) -> Optional[dict]:
        """انتخاب اپراتور بعدی فقط از بین کاربران با نقش 'operator' (استثنا کردن admin)."""
        active_ops = [o for o in self.get_active_operators() if o["role"] == "operator"]
        if not active_ops:
            return None
        idx = current_counter % len(active_ops)
        return active_ops[idx]


_auth_manager: Optional[OperatorAuthManager] = None
_auth_manager_lock = threading.Lock()

def get_operator_auth_manager() -> OperatorAuthManager:
    global _auth_manager
    if _auth_manager is None:
        with _auth_manager_lock:
            if _auth_manager is None:
                _auth_manager = OperatorAuthManager()
    return _auth_manager
