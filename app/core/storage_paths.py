from pathlib import Path
import os

SERVICE_ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = DATABASE_DIR = LEGACY_DATA_ROOT = Path(
    os.environ.get('TRAVEL_DEMO_DATA_DIR', SERVICE_ROOT / '.local-data')
).resolve()
