import os
from types import SimpleNamespace


def get_settings():
    return SimpleNamespace(
        operator_session_timeout_minutes=30,
        operator_admin_password=os.environ.get('TRAVEL_DEMO_ADMIN_PASSWORD', ''),
    )
