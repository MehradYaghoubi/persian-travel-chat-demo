"""Loopback-only travel chat with local operator accounts and SQLite history."""
import argparse
from dataclasses import asdict
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

from app.services.chat_history import ChatHistoryManager
from app.services.operator_auth import OperatorAuthManager

ROOT = Path(__file__).resolve().parent
CHANNELS = {'ground', 'flight', 'package'}
STATIC = {
    '/': 'index.html', '/operator': 'operator.html', '/operator.html': 'operator.html',
    **{'/' + f: f for f in ('styles.css', 'chat.js', 'operator.js', 'offer-picker.css', 'offer-picker.js')},
}


class Problem(Exception):
    def __init__(self, code, detail):
        self.code, self.detail = code, detail


def text(data, key, limit, required=False):
    value = data.get(key) or ''
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise Problem(400, 'مقدار واردشده معتبر نیست')
    return value.strip()


def session_view(session):
    row = asdict(session)
    messages = row.pop('messages')
    row['last_message'] = messages[-1]['text'] if messages else ''
    return row


class Application:
    def __init__(self):
        self.auth = OperatorAuthManager()
        self.history = ChatHistoryManager()

    def profile(self, operator):
        return {'username': operator.username, 'full_name': operator.full_name, 'role': operator.role,
                **self.auth.lunch_status(operator)}

    @staticmethod
    def result(outcome):
        success, message = outcome[:2]
        if not success:
            raise Problem(400, message)
        return {'success': True, 'message': message}

    def login(self, data):
        operator = self.auth.login(text(data, 'username', 64, True), text(data, 'password', 128, True))
        if not operator:
            raise Problem(401, 'نام کاربری یا رمز عبور اشتباه است')
        for session in self.history.list_sessions(status='waiting'):
            if operator.role == 'operator' and not session.metadata.get('assigned_operator'):
                self.history.assign_operator(session.session_id, operator.username, operator.full_name)
                self.history.update_session(session.session_id, metadata={
                    **session.metadata, 'status': 'pending_operator_action',
                })
        return {'success': True, 'token': operator.token}

    def customer(self, method, parts, data):
        if method == 'POST' and not parts:
            channel = text(data, 'channel', 12, True)
            if channel not in CHANNELS:
                raise Problem(400, 'خدمت انتخاب‌شده معتبر نیست')
            message = text(data, 'message', 2000, True)
            session = self.history.create_session(channel, 'درخواست پشتیبانی سفر')
            operator = self.history.next_active_operator(self.auth)
            if operator:
                self.history.assign_operator(session.session_id, operator['username'], operator['full_name'])
            self.history.update_session(session.session_id, metadata={
                **session.metadata, 'status': 'pending_operator_action' if operator else 'pending_operator_assignment',
            })
            self.history.add_message(session.session_id, 'user', message)
            return {'session_id': session.session_id}
        if len(parts) != 1:
            raise Problem(404, 'مسیر پیدا نشد')
        session = self.history.get_session(parts[0])
        if not session or session.title != 'درخواست پشتیبانی سفر':
            raise Problem(404, 'گفتگو پیدا نشد')
        if method == 'POST':
            if not session.is_active or session.is_archived:
                raise Problem(409, 'گفتگو بسته است')
            self.history.add_message(session.session_id, 'user', text(data, 'message', 2000, True))
        elif method != 'GET':
            raise Problem(405, 'روش درخواست معتبر نیست')
        return {'messages': [{'role': m.role, 'text': m.text} for m in session.messages
                             if m.role in {'user', 'operator_note'}], 'active': session.is_active and not session.is_archived}

    def accounts(self, method, parts, data):
        if method == 'GET' and not parts:
            return self.auth.list_all_accounts()
        if method == 'POST' and not parts:
            username = text(data, 'username', 64, True)
            if not re.fullmatch(r'[a-zA-Z0-9_-]+', username):
                raise Problem(400, 'نام کاربری باید از حروف لاتین یا اعداد باشد')
            return self.result(self.auth.create_operator(username, text(data, 'password', 128, True),
                               text(data, 'full_name', 120, True), text(data, 'role', 12, True)))
        if len(parts) == 1 and method == 'PUT':
            active = data.get('is_active')
            if active is not None and type(active) is not bool:
                raise Problem(400, 'وضعیت حساب معتبر نیست')
            return self.result(self.auth.update_operator_by_admin(
                parts[0], text(data, 'full_name', 120) or None, text(data, 'password', 128) or None,
                text(data, 'role', 12) or None, active))
        if len(parts) == 1 and method == 'DELETE':
            return self.result(self.auth.delete_operator(parts[0]))
        raise Problem(404, 'مسیر پیدا نشد')

    def dispatch(self, method, path, query, data, authorization):
        parts = path.strip('/').split('/')
        if parts[:2] == ['api', 'customer']:
            return self.customer(method, parts[2:], data)
        if method == 'POST' and path == '/api/operator/auth/login':
            return self.login(data)
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        operator = self.auth.get_session(token)
        if not operator:
            raise Problem(401, 'ورود اپراتور لازم است')
        if method == 'GET' and path == '/api/operator/auth/session':
            return self.profile(operator)
        if method == 'GET' and path == '/api/operator/auth/active':
            return [row for row in self.auth.get_active_operators() if row['username'] != operator.username]
        if method == 'POST' and path == '/api/operator/auth/logout':
            return self.result(self.auth.logout(token, self.history))
        if method == 'POST' and path == '/api/operator/auth/lunch':
            self.result(self.auth.start_lunch(operator))
            return self.profile(operator)
        if method in {'PUT', 'PATCH', 'POST'} and path == '/api/operator/auth/profile':
            password = text(data, 'password', 128)
            if password and len(password) < 12:
                raise Problem(400, 'رمز عبور باید حداقل ۱۲ نویسه باشد')
            self.auth.update_profile(operator.username, text(data, 'full_name', 120) or None, password or None)
            return {'success': True, **self.profile(operator)}
        if parts[:4] == ['api', 'operator', 'admin', 'operators']:
            if operator.role != 'admin':
                raise Problem(403, 'دسترسی فقط برای مدیر')
            return self.accounts(method, parts[4:], data)
        if parts[:3] != ['api', 'operator', 'chats']:
            raise Problem(404, 'مسیر پیدا نشد')
        return self.chats(method, parts[3:], query, data, operator)

    def chats(self, method, parts, query, data, operator):
        admin = operator.role == 'admin'
        if method == 'GET' and (not parts or parts == ['search']):
            get = lambda name: query.get(name, [None])[0]
            rows = self.history.search_sessions(
                get('q'), chat_type=get('chat_type'), include_archived=get('include_archived') == 'true',
                start_date=get('start_date'), end_date=get('end_date'), status=get('status'),
                transfer_state=get('transfer_state'),
                operator_username=get('operator_username') if admin else operator.username,
            )
            return [session_view(row) for row in rows]
        if method == 'POST' and not parts and not admin:
            channel = text(data, 'chat_type', 12, True)
            if channel not in CHANNELS:
                raise Problem(400, 'خدمت انتخاب‌شده معتبر نیست')
            message = text(data, 'initial_message', 2000, True)
            session = self.history.create_session(channel, 'گفتگوی اپراتور',
                        text(data, 'customer_name', 120), text(data, 'customer_phone', 32))
            self.history.assign_operator(session.session_id, operator.username, operator.full_name)
            self.history.add_message(session.session_id, 'operator_note', message, sender_name=operator.full_name)
            return session_view(session)
        session = self.history.get_session(parts[0]) if parts else None
        if not session or (not admin and session.metadata.get('assigned_operator') != operator.username):
            raise Problem(404, 'گفتگو پیدا نشد')
        sid = session.session_id
        action = parts[1] if len(parts) == 2 else ''
        if method == 'GET' and len(parts) == 1:
            return session_view(session)
        if method == 'GET' and action == 'messages':
            return {'messages': [asdict(message) for message in session.messages]}
        if admin:
            raise Problem(403, 'دسترسی مدیر به گفتگو فقط خواندنی است')
        if method == 'DELETE' and len(parts) == 1:
            self.history.delete_session(sid, permanent=True)
        elif method == 'POST' and action == 'messages':
            if not session.is_active or session.is_archived:
                raise Problem(409, 'گفتگو بسته است')
            self.history.add_message(sid, 'operator_note', text(data, 'message', 2000, True),
                                     sender_name=operator.full_name, sender_username=operator.username)
            self.history.update_session(sid, metadata={**session.metadata, 'status': 'active'})
        elif method == 'POST' and action == 'transfer':
            target = text(data, 'target_username', 64, True)
            row = next((item for item in self.auth.get_active_operators() if item['username'] == target), None)
            if not row or target == operator.username or not session.is_active or session.is_archived:
                raise Problem(400, 'اپراتور مقصد در دسترس نیست')
            self.history.record_transfer(sid, operator.username, operator.full_name, target, row['full_name'])
        elif method == 'POST' and action in {'close', 'reopen', 'complete'}:
            self.history.update_session(sid, is_active=action == 'reopen', metadata={
                **session.metadata, 'status': {'close': 'closed', 'reopen': 'active', 'complete': 'completed'}[action],
            })
        elif method == 'POST' and action in {'archive', 'unarchive'}:
            (self.history.archive_session if action == 'archive' else self.history.unarchive_session)(sid)
        else:
            raise Problem(404, 'عملیات پیدا نشد')
        return {'success': True}


class Handler(BaseHTTPRequestHandler):
    def output(self, code, body, content_type):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        self.connection.settimeout(5)
        parsed = urlsplit(self.path)
        port = self.server.server_port
        host = self.headers.get('Host')
        allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
        try:
            if host not in allowed:
                raise Problem(403, 'نشانی محلی معتبر نیست')
            if self.headers.get('Origin') not in (None, 'http://' + host):
                raise Problem(403, 'درخواست خارج از صفحه محلی پذیرفته نشد')
            if self.command == 'GET' and parsed.path in STATIC:
                path = ROOT / STATIC[parsed.path]
                self.output(200, path.read_bytes(), (mimetypes.guess_type(path)[0] or 'application/octet-stream') + '; charset=utf-8')
                return
            if not parsed.path.startswith('/api/'):
                raise Problem(404, 'صفحه پیدا نشد')
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 16384:
                raise Problem(413, 'درخواست بزرگ است')
            data = json.loads(self.rfile.read(size)) if size else {}
            if not isinstance(data, dict):
                raise Problem(400, 'بدنه درخواست معتبر نیست')
            body = self.server.app.dispatch(self.command, parsed.path, parse_qs(parsed.query), data,
                                            self.headers.get('Authorization', ''))
            code = 200
        except Problem as error:
            code, body = error.code, {'detail': error.detail}
        except (ValueError, UnicodeError):
            code, body = 400, {'detail': 'درخواست معتبر نیست'}
        self.output(code, json.dumps(body, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = route

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    fresh = not OperatorAuthManager.STORAGE_PATH.exists()
    generated = fresh and not os.environ.get('TRAVEL_DEMO_ADMIN_PASSWORD')
    if generated:
        os.environ['TRAVEL_DEMO_ADMIN_PASSWORD'] = secrets.token_urlsafe(18)
    app = Application()
    if generated:
        print('Initial admin password:', os.environ.pop('TRAVEL_DEMO_ADMIN_PASSWORD'), flush=True)
    with HTTPServer(('127.0.0.1', args.port), Handler) as server:
        server.app = app
        print(f'http://127.0.0.1:{server.server_port}/ | /operator', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
