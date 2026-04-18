from __future__ import annotations

import json
import os
import sys
from datetime import date
from dotenv import load_dotenv

load_dotenv()

_REQUIRED_VARS = ["TELEGRAM_BOT_TOKEN"]
_missing = [v for v in _REQUIRED_VARS if v not in os.environ]
if _missing:
    print(f"[Config] Missing required environment variables: {', '.join(_missing)}")
    print("[Config] Copy .env.example to .env and fill in your values.")
    sys.exit(1)

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
BASE_URL = os.getenv("BASE_URL", "https://usvisascheduling.com")

# Slot polling interval (seconds) — how often to re-check without page refresh
POLL_DELAY_MIN = int(os.getenv("POLL_DELAY_MIN", "10"))
POLL_DELAY_MAX = int(os.getenv("POLL_DELAY_MAX", "15"))

# Delay between processing different users (seconds)
USER_SWITCH_DELAY_MIN = int(os.getenv("USER_SWITCH_DELAY_MIN", "10"))
USER_SWITCH_DELAY_MAX = int(os.getenv("USER_SWITCH_DELAY_MAX", "30"))

HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"

CAPTCHA_MODE = os.getenv("CAPTCHA_MODE", "manual")
TWO_CAPTCHA_API_KEY = os.getenv("TWO_CAPTCHA_API_KEY", "")

INTERVIEW_WAIT_MINUTES = int(os.getenv("INTERVIEW_WAIT_MINUTES", "30"))

SCREENSHOTS_DIR = os.path.join(os.path.dirname(__file__), "screenshots")
DOWNLOADS_DIR = os.path.join(os.path.dirname(__file__), "downloads")
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

USERS_FILE = os.path.join(os.path.dirname(__file__), "users.json")

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def load_users() -> list[dict]:
    if not os.path.exists(USERS_FILE):
        print(f"[Config] Users file not found: {USERS_FILE}")
        print("[Config] Copy users.json.example to users.json and fill in user details.")
        sys.exit(1)
    with open(USERS_FILE) as f:
        users = json.load(f)
    if not users:
        print("[Config] No users defined in users.json")
        sys.exit(1)
    for i, user in enumerate(users):
        for field in ["username", "password", "security_questions"]:
            if field not in user:
                print(f"[Config] User #{i+1} missing required field: {field}")
                sys.exit(1)
        user.setdefault("name", f"User {i+1}")
        user.setdefault("preferred_consulates", ["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"])
        user.setdefault("date_range_start", "2026-05-01")
        user.setdefault("date_range_end", "2026-12-31")
        user.setdefault("telegram_chat_id", "")
    return users
