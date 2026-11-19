# -*- coding: utf-8 -*-
"""مدیریت تاریخچه چت برای پنل اپراتور.

- ذخیره لوکال روی سرور (در حافظه/فایل)
- تاریخچه همیشه باقی می‌ماند (حتی اگر از ظاهر پاک شود)
- پشتیبانی از صف‌های مستقل خدمات سفر
- قابلیت جستجو، فیلتر، و آرشیو"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional

from app.core.storage_paths import DATABASE_DIR, LEGACY_DATA_ROOT, SERVICE_ROOT, STATE_DIR


@dataclass
class ChatMessage:
    """یک پیام در تاریخچه چت."""
    role: str  # "user" | "bot" | "operator_note" | "system"
    text: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    message_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    sender_name: Optional[str] = None
    sender_username: Optional[str] = None
    metadata: dict = field(default_factory=dict)  # service_type, status, offers, etc.


@dataclass
class ChatSession:
    """یک نشست چت کامل."""
    session_id: str
    chat_type: str
    title: str  # عنوان نمایشی (مثال: "تهران → مشهد، ۲ نفر، ون")
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    is_archived: bool = False  # در ظاهر مخفی، در سرور باقی می‌ماند
    is_active: bool = True  # در حال انجام یا بسته شده
    messages: list[ChatMessage] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)  # برچسب‌ها: "urgent", "vip", "follow_up"
    metadata: dict = field(default_factory=dict)  # draft data, reservation_id, etc.


class ChatHistoryManager:
    """مدیر تاریخچه چت‌ها - SQLite منبع پایدار و فایل‌های JSON ورودی سازگاری قدیمی‌اند."""

    SERVICE_DIR = SERVICE_ROOT
    STORAGE_PATH = STATE_DIR / "chat_history"
    DB_PATH = DATABASE_DIR / "chat_history.db"
    LEGACY_STORAGE_PATHS = (
        LEGACY_DATA_ROOT / "chat_history",
        SERVICE_DIR / "chat_history",
        SERVICE_DIR / "chatbot-service" / "chat_history",
    )
    LEGACY_DB_PATHS = (
        LEGACY_DATA_ROOT / "chat_history.db",
        SERVICE_DIR / "chat_history.db",
        SERVICE_DIR / "chatbot-service" / "chat_history.db",
    )

    def __init__(self):
        self._sessions: "OrderedDict[str, ChatSession]" = OrderedDict()
        self._lock = threading.RLock()
        self.assignment_counter = 0
        self.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.STORAGE_PATH.mkdir(parents=True, exist_ok=True)
        self._init_sqlite()
        self._load_from_disk()

    def _connect(self):
        """Open a short-lived connection configured for concurrent local readers/writers."""
        conn = sqlite3.connect(self.DB_PATH, timeout=15)
        conn.execute("PRAGMA busy_timeout=15000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_sqlite(self):
        """راه‌اندازی جداول SQLite برای ایندکس و تاریخچه چت‌ها و انتقال‌ها."""
        try:
            with self._connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        session_id TEXT PRIMARY KEY,
                        chat_type TEXT,
                        title TEXT,
                        customer_name TEXT,
                        customer_phone TEXT,
                        assigned_operator TEXT,
                        created_at TEXT,
                        updated_at TEXT,
                        is_archived INTEGER,
                        is_active INTEGER,
                        status TEXT,
                        metadata_json TEXT,
                        tags_json TEXT
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS messages (
                        message_id TEXT PRIMARY KEY,
                        session_id TEXT,
                        role TEXT,
                        sender_name TEXT,
                        sender_username TEXT,
                        text TEXT,
                        timestamp TEXT,
                        metadata_json TEXT,
                        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS transfers (
                        transfer_id TEXT PRIMARY KEY,
                        session_id TEXT,
                        from_operator TEXT,
                        to_operator TEXT,
                        transferred_at TEXT,
                        checkpoint_message_id TEXT
                    )
                """)
                session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
                if "tags_json" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN tags_json TEXT")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_operator_status ON sessions(assigned_operator, is_active, is_archived)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_transfers_session_time ON transfers(session_id, transferred_at)")
                conn.commit()
            self._migrate_legacy_databases()
        except Exception as exc:
            raise RuntimeError("SQLite chat history database could not be initialized") from exc

    def _migrate_legacy_databases(self):
        """Merge older SQLite stores idempotently; keep the source files untouched."""
        destination = self.DB_PATH.resolve()
        table_names = ("sessions", "messages", "transfers")
        for legacy_path in self.LEGACY_DB_PATHS:
            if not legacy_path.exists() or legacy_path.resolve() == destination:
                continue
            alias = "legacy_chat_history"
            try:
                with self._connect() as conn:
                    conn.execute(f"ATTACH DATABASE ? AS {alias}", (str(legacy_path),))
                    available = {row[0] for row in conn.execute(
                        f"SELECT name FROM {alias}.sqlite_master WHERE type='table'")}
                    for table in table_names:
                        if table not in available:
                            continue
                        source_columns = {row[1] for row in conn.execute(
                            f"PRAGMA {alias}.table_info({table})")}
                        target_columns = {row[1] for row in conn.execute(
                            f"PRAGMA main.table_info({table})")}
                        columns = [name for name in target_columns if name in source_columns]
                        if not columns:
                            continue
                        column_sql = ", ".join(f'"{name}"' for name in columns)
                        conn.execute(
                            f"INSERT OR IGNORE INTO main.{table} ({column_sql}) "
                            f"SELECT {column_sql} FROM {alias}.{table}"
                        )
                    conn.commit()
                    conn.execute(f"DETACH DATABASE {alias}")
            except sqlite3.Error as exc:
                raise RuntimeError(
                    f"Legacy chat database migration failed ({legacy_path.name})"
                ) from exc

    def _sync_sqlite_session(self, session: ChatSession,
                             messages: tuple[ChatMessage, ...] | list[ChatMessage] = ()):
        """ذخیرهٔ نشست و فقط پیام‌های تازه/واردشده در SQLite."""
        assigned = session.metadata.get("assigned_operator") if session.metadata else None
        status = session.metadata.get("status", "active") if session.metadata else "active"
        if not session.is_active:
            status = session.metadata.get("status", "closed")

        with self._connect() as conn:
            conn.execute("""
                    INSERT INTO sessions (
                        session_id, chat_type, title, customer_name, customer_phone,
                        assigned_operator, created_at, updated_at, is_archived, is_active, status, metadata_json, tags_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        chat_type=excluded.chat_type,
                        title=excluded.title,
                        customer_name=excluded.customer_name,
                        customer_phone=excluded.customer_phone,
                        assigned_operator=excluded.assigned_operator,
                        created_at=excluded.created_at,
                        updated_at=excluded.updated_at,
                        is_archived=excluded.is_archived,
                        is_active=excluded.is_active,
                        status=excluded.status,
                        metadata_json=excluded.metadata_json,
                        tags_json=excluded.tags_json
            """, (
                    session.session_id, session.chat_type, session.title,
                    session.customer_name, session.customer_phone, assigned,
                    session.created_at, session.updated_at,
                    1 if session.is_archived else 0, 1 if session.is_active else 0,
                    status, json.dumps(session.metadata or {}, ensure_ascii=False),
                    json.dumps(session.tags or [], ensure_ascii=False)
            ))

            for m in messages:
                conn.execute("""
                        INSERT INTO messages (
                            message_id, session_id, role, sender_name, sender_username, text, timestamp, metadata_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(message_id) DO NOTHING
                """, (
                        m.message_id, session.session_id, m.role, m.sender_name, m.sender_username,
                        m.text, m.timestamp, json.dumps(m.metadata or {}, ensure_ascii=False)
                ))
            conn.commit()

    def _load_from_disk(self):
        """بارگذاری SQLite و واردکردن فایل‌های JSON قدیمی به پایگاه اصلی."""
        try:
            self._load_from_sqlite()
            search_paths = (*self.LEGACY_STORAGE_PATHS, self.STORAGE_PATH)
            seen_paths = set()
            for storage_path in search_paths:
                resolved_path = storage_path.resolve()
                if resolved_path in seen_paths:
                    continue
                seen_paths.add(resolved_path)
                if not storage_path.exists():
                    continue
                for file_path in storage_path.glob("*.json"):
                    try:
                        with open(file_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        session = self._deserialize_session(data)
                        previous = self._sessions.get(session.session_id)
                        if not previous or session.updated_at >= previous.updated_at:
                            self._sessions[session.session_id] = session
                            self._sync_sqlite_session(session, session.messages)
                    except Exception:
                        continue
            # مرتب‌سازی بر اساس updated_at نزولی
            sorted_sessions = sorted(
                self._sessions.values(),
                key=lambda s: s.updated_at,
                reverse=True
            )
            self._sessions = OrderedDict((s.session_id, s) for s in sorted_sessions)
        except Exception as exc:
            raise RuntimeError("Chat history could not be loaded") from exc

    def _load_from_sqlite(self):
        """Load durable sessions absent from JSON (including migrated legacy records)."""
        try:
            with self._connect() as conn:
                rows = conn.execute("""
                    SELECT session_id, chat_type, title, customer_name, customer_phone,
                           created_at, updated_at, is_archived, is_active, metadata_json, tags_json
                    FROM sessions
                """).fetchall()
                message_rows = conn.execute("""
                    SELECT message_id, session_id, role, sender_name, sender_username,
                           text, timestamp, metadata_json
                    FROM messages ORDER BY timestamp, rowid
                """).fetchall()
            messages_by_session = {}
            for row in message_rows:
                try:
                    metadata = json.loads(row[7] or "{}")
                except (TypeError, json.JSONDecodeError):
                    metadata = {}
                messages_by_session.setdefault(row[1], []).append(ChatMessage(
                    message_id=row[0], role=row[2], sender_name=row[3],
                    sender_username=row[4], text=row[5], timestamp=row[6],
                    metadata=metadata,
                ))
            for row in rows:
                try:
                    metadata = json.loads(row[9] or "{}")
                    tags = json.loads(row[10] or "[]")
                except (TypeError, json.JSONDecodeError):
                    metadata, tags = {}, []
                session = ChatSession(
                    session_id=row[0], chat_type=row[1] or "ground", title=row[2] or "",
                    customer_name=row[3], customer_phone=row[4], created_at=row[5],
                    updated_at=row[6], is_archived=bool(row[7]), is_active=bool(row[8]),
                    metadata=metadata if isinstance(metadata, dict) else {},
                    tags=tags if isinstance(tags, list) else [],
                    messages=messages_by_session.get(row[0], []),
                )
                previous = self._sessions.get(session.session_id)
                if not previous or session.updated_at >= previous.updated_at:
                    self._sessions[session.session_id] = session
        except sqlite3.Error as exc:
            raise RuntimeError("SQLite chat history could not be loaded") from exc

    def _save_to_disk(self, session: ChatSession):
        """Persist a session to SQLite without serializing its full history to JSON."""
        self._sync_sqlite_session(session)

    def _serialize_session(self, session: ChatSession) -> dict:
        return {
            "session_id": session.session_id,
            "chat_type": session.chat_type,
            "title": session.title,
            "customer_name": session.customer_name,
            "customer_phone": session.customer_phone,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "is_archived": session.is_archived,
            "is_active": session.is_active,
            "tags": session.tags,
            "metadata": session.metadata,
            "messages": [asdict(m) for m in session.messages],
        }

    def _deserialize_session(self, data: dict) -> ChatSession:
        messages = [ChatMessage(**m) for m in data.get("messages", [])]
        return ChatSession(
            session_id=data["session_id"],
            chat_type=data["chat_type"],
            title=data["title"],
            customer_name=data.get("customer_name"),
            customer_phone=data.get("customer_phone"),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            is_archived=data.get("is_archived", False),
            is_active=data.get("is_active", True),
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
            messages=messages,
        )

    def create_session(self, chat_type: str, title: str = "",
                       customer_name: str = None, customer_phone: str = None,
                       session_id: str = None) -> ChatSession:
        """ایجاد نشست جدید."""
        with self._lock:
            session_id = session_id or f"{chat_type}_{uuid.uuid4().hex}"
            if not session_id.isascii() or not session_id.replace("_", "").replace("-", "").isalnum() or len(session_id) > 128:
                raise ValueError("session_id نامعتبر است")
            if session_id in self._sessions:
                raise ValueError("session_id از قبل وجود دارد")
            session = ChatSession(
                session_id=session_id,
                chat_type=chat_type,
                title=title or f"چت {chat_type} - {datetime.now().strftime('%Y/%m/%d %H:%M')}",
                customer_name=customer_name,
                customer_phone=customer_phone,
            )
            self._sessions[session_id] = session
            self._save_to_disk(session)
            return session

    def get_session(self, session_id: str) -> Optional[ChatSession]:
        """دریافت نشست با آیدی."""
        with self._lock:
            return self._sessions.get(session_id)

    def next_active_operator(self, auth_manager) -> Optional[dict]:
        """Round-robin selection with an atomic shared counter."""
        active = auth_manager.get_active_operators()
        if not active:
            return None
        with self._lock:
            chosen = active[self.assignment_counter % len(active)]
            self.assignment_counter += 1
            return chosen

    def customer_lifecycle(self, session: ChatSession, idle_minutes: int, touch: bool = False) -> str:
        """Expire only the customer's view; retain the company's transcript and assignment."""
        with self._lock:
            if session.metadata.get('customer_expired_at'):
                return 'expired'
            last_activity = session.metadata.get('customer_last_activity')
            if last_activity is None:
                last_turn = next((m for m in reversed(session.messages) if m.role == 'user'), None)
                try:
                    last_activity = datetime.fromisoformat(last_turn.timestamp if last_turn else session.created_at).timestamp()
                except (TypeError, ValueError):
                    last_activity = time.time()
            if time.time() - last_activity >= idle_minutes * 60:
                session.metadata['customer_expired_at'] = time.time()
                self._sync_sqlite_session(session)
                return 'expired'
            if not session.is_active or session.is_archived or session.metadata.get('status') == 'completed':
                return 'closed'
            if touch:
                session.metadata['customer_last_activity'] = time.time()
                self._sync_sqlite_session(session)
            return 'active'

    def add_message(self, session_id: str, role: str, text: str,
                    metadata: dict = None, sender_name: str = None,
                    sender_username: str = None) -> Optional[ChatMessage]:
        """افزودن پیام به نشست همراه با نام و نام‌کاربری فرستنده."""
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            msg = ChatMessage(
                role=role,
                text=text,
                sender_name=sender_name,
                sender_username=sender_username,
                metadata=metadata or {}
            )
            session.messages.append(msg)
            if role == 'user':
                session.metadata['customer_last_activity'] = time.time()
            session.updated_at = datetime.now().isoformat()
            self._sync_sqlite_session(session, (msg,))
            return msg

    def record_transfer(self, session_id: str, from_op: str, from_op_name: str,
                        to_op: str, to_op_name: str) -> bool:
        """ثبت انتقال چت بین دو اپراتور هم در پیام‌ها هم جدول SQLite transfers."""
        return self.assign_operator(session_id, to_op, to_op_name, from_op, from_op_name)

    def assign_operator(self, session_id: str, to_op: str, to_op_name: str,
                        from_op: str = "ai", from_op_name: str = "هوش مصنوعی") -> bool:
        """ثبت ارجاع اولیه یا انتقال و نگهداری بخش کاری هر اپراتور."""
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return False

            notice_text = (f"📥 این گفتگو به اپراتور «{to_op_name}» ارجاع شد."
                           if from_op == "ai" else
                           f"🔄 این گفتگو از اپراتور «{from_op_name}» به اپراتور «{to_op_name}» منتقل شد.")
            msg = self.add_message(
                session_id=session_id,
                role="system",
                text=notice_text,
                sender_name="سیستم انتقال",
                sender_username="system",
                metadata={
                    "type": "transfer",
                    "from_operator": from_op,
                    "to_operator": to_op,
                    "from_operator_name": from_op_name,
                    "to_operator_name": to_op_name
                }
            )

            try:
                with self._connect() as conn:
                    conn.execute("""
                        INSERT INTO transfers (
                            transfer_id, session_id, from_operator, to_operator, transferred_at, checkpoint_message_id
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    """, (
                        uuid.uuid4().hex,
                        session_id,
                        from_op,
                        to_op,
                        datetime.now().isoformat(),
                        msg.message_id if msg else None
                    ))
                    conn.commit()
            except Exception as e:
                print(f"Transfer DB log error: {e}")

            session.metadata["assigned_operator"] = to_op
            session.metadata["assigned_operator_name"] = to_op_name
            segments = session.metadata.setdefault("operator_segments", [])
            if segments and not segments[-1].get("ended_at"):
                segments[-1]["ended_at"] = datetime.now().isoformat()
                segments[-1]["checkpoint_message_id"] = msg.message_id if msg else None
            segments.append({"username": to_op, "full_name": to_op_name,
                             "started_at": datetime.now().isoformat(), "message_count": 0})
            self._save_to_disk(session)
            return True

    def update_session(self, session_id: str, **kwargs) -> Optional[ChatSession]:
        """به‌روزرسانی فیلدهای نشست."""
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            for key, value in kwargs.items():
                if hasattr(session, key):
                    setattr(session, key, value)
            session.updated_at = datetime.now().isoformat()
            self._save_to_disk(session)
            return session

    def archive_session(self, session_id: str) -> bool:
        """آرشیو کردن نشست (مخفی از ظاهر، در سرور باقی می‌ماند)."""
        session = self.update_session(session_id, is_archived=True, is_active=False)
        return session is not None

    def unarchive_session(self, session_id: str) -> bool:
        """بازگرداندن نشست از آرشیو."""
        session = self.update_session(session_id, is_archived=False)
        return session is not None

    def delete_session(self, session_id: str, permanent: bool = False) -> bool:
        """حذف نشست. permanent=True = حذف کامل از دیسک هم."""
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return False
            if not permanent:
                self.update_session(session_id, is_archived=True, is_active=False)
                return True
            self._sessions.pop(session_id, None)
            if permanent:
                for storage_path in (self.STORAGE_PATH, *self.LEGACY_STORAGE_PATHS):
                    try:
                        (storage_path / f"{session_id}.json").unlink(missing_ok=True)
                    except OSError as exc:
                        print(f"Chat history file deletion error ({session_id}): {exc}")
                try:
                    with self._connect() as conn:
                        conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
                        conn.execute("DELETE FROM transfers WHERE session_id = ?", (session_id,))
                        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
                        conn.commit()
                except Exception as exc:
                    print(f"Chat history deletion error ({session_id}): {exc}")
            return True

    def list_sessions(self, chat_type: str = None, include_archived: bool = False,
                      start_date: str = None, end_date: str = None,
                      operator_username: str = None,
                      status: str = None, transfer_state: str = None,
                      limit: int = 100, offset: int = 0) -> list[ChatSession]:
        """لیست نشست‌ها با فیلتر اپراتور مسئول و محدوده تاریخی."""
        with self._lock:
            sessions = list(self._sessions.values())
            if chat_type:
                sessions = [s for s in sessions if s.chat_type == chat_type]
            if not include_archived:
                sessions = [s for s in sessions if not s.is_archived]
            if operator_username:
                sessions = [s for s in sessions if s.metadata and s.metadata.get("assigned_operator") == operator_username]
            if start_date:
                sessions = [s for s in sessions if s.created_at[:10] >= start_date]
            if end_date:
                sessions = [s for s in sessions if s.created_at[:10] <= end_date]
            sessions = [s for s in sessions if self._matches_filters(s, status, transfer_state)]
            sessions.sort(key=lambda s: (s.is_active, s.updated_at), reverse=True)
            return sessions[offset:offset + limit]

    def search_sessions(self, query: str = "", chat_type: str = None,
                        include_archived: bool = True,
                        start_date: str = None, end_date: str = None,
                        operator_username: str = None, status: str = None,
                        transfer_state: str = None) -> list[ChatSession]:
        """جستجو در عنوان، پیام‌ها، نام مشتری همراه با محدوده تاریخی."""
        query = (query or "").lower().strip()
        with self._lock:
            results = []
            for session in self._sessions.values():
                if chat_type and session.chat_type != chat_type:
                    continue
                if not include_archived and session.is_archived:
                    continue
                if start_date and session.created_at[:10] < start_date:
                    continue
                if end_date and session.created_at[:10] > end_date:
                    continue
                if operator_username and (not session.metadata or session.metadata.get("assigned_operator") != operator_username):
                    continue
                if not self._matches_filters(session, status, transfer_state):
                    continue

                if not query:
                    results.append(session)
                    continue

                # جستجو در عنوان
                if query in session.title.lower():
                    results.append(session)
                    continue
                # جستجو در نام/شماره مشتری
                if session.customer_name and query in session.customer_name.lower():
                    results.append(session)
                    continue
                if session.customer_phone and query in session.customer_phone:
                    results.append(session)
                    continue
                # جستجو در پیام‌ها
                for msg in session.messages:
                    if query in msg.text.lower():
                        results.append(session)
                        break
            results.sort(key=lambda s: s.updated_at, reverse=True)
            return results[:100]

    @staticmethod
    def _matches_filters(session: ChatSession, status: str = None,
                         transfer_state: str = None) -> bool:
        meta = session.metadata or {}
        state = meta.get("status", "")
        waiting = state in ("pending_operator_assignment", "pending_operator_action")
        if status == "open" and (not session.is_active or state == "completed" or waiting):
            return False
        if status == "waiting" and not waiting:
            return False
        if status == "completed" and state != "completed":
            return False
        if status == "closed" and (session.is_active or state == "completed"):
            return False
        if transfer_state:
            transferred = len(meta.get("operator_segments") or []) > 1 or any(
                (message.metadata or {}).get("type") == "transfer"
                and (message.metadata or {}).get("from_operator") not in (None, "", "ai")
                for message in session.messages
            )
            if transfer_state == "transferred" and not transferred:
                return False
            if transfer_state == "not_transferred" and transferred:
                return False
        return True

    def get_stats(self) -> dict:
        """آمار کلی."""
        with self._lock:
            total = len(self._sessions)
            active = sum(1 for s in self._sessions.values() if s.is_active)
            archived = sum(1 for s in self._sessions.values() if s.is_archived)
            by_type = {}
            for s in self._sessions.values():
                by_type[s.chat_type] = by_type.get(s.chat_type, 0) + 1
            return {
                "total_sessions": total,
                "active_sessions": active,
                "archived_sessions": archived,
                "by_type": by_type,
            }

# نمونه سراسری (Singleton)
_chat_history_manager: Optional[ChatHistoryManager] = None
_chat_history_manager_lock = threading.Lock()


def get_chat_history_manager() -> ChatHistoryManager:
    global _chat_history_manager
    if _chat_history_manager is None:
        with _chat_history_manager_lock:
            if _chat_history_manager is None:
                _chat_history_manager = ChatHistoryManager()
    return _chat_history_manager
