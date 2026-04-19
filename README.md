# US Visa Slot Booking Bot

Automated US visa appointment booking bot for [usvisascheduling.com](https://usvisascheduling.com), targeting Indian consulates (Mumbai, New Delhi, Chennai, Kolkata, Hyderabad). Built with Playwright for browser automation and Telegram for real-time notifications.

## How It Works

The bot follows the exact 6-step flow of the website:

```
Step 1: Login         → Azure B2C auth (username + password + image CAPTCHA)
Step 2: Security Qs   → Answers 2 of 3 security questions (fuzzy matched)
Step 3: Dashboard      → Clicks Schedule / Reschedule button
Step 4: OFC Booking    → Selects consulate, picks green date, chooses time slot
Step 5: Interview      → Picks interview date + time (waits up to 30 min if needed)
Step 6: Confirmation   → Downloads/screenshots the confirmation page
```

Each user gets an **isolated browser session** (separate cookies). Users are processed sequentially with random delays. Completed users are automatically skipped.

## Setup

### Prerequisites
- Python 3.10+
- Chromium browser (installed via Playwright)

### Installation

```bash
# Clone the repo
git clone https://github.com/ArunTeja0040/usvisaslot.git
cd usvisaslot

# Install dependencies
pip install -r requirements.txt
playwright install chromium

# Configure
cp .env.example .env          # Edit with your Telegram bot token + settings
cp users.json.example users.json  # Add your credentials
```

### Configuration

**`.env`** — Global settings:
| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications | (required) |
| `HEADLESS` | Run browser headless (`true`/`false`) | `true` |
| `CAPTCHA_MODE` | `manual` (solve in browser) or `2captcha` | `manual` |
| `POLL_DELAY_MIN` / `POLL_DELAY_MAX` | Slot polling interval (seconds) | 10 / 15 |
| `INTERVIEW_WAIT_MINUTES` | Max wait for interview dates after OFC | 30 |

**`users.json`** — Per-user credentials:
```json
[
  {
    "name": "YourName",
    "username": "your_username",
    "password": "your_password",
    "security_questions": {
      "Where did you meet your spouse?": "YourAnswer",
      "What is the name of the town/city where you were born?": "YourAnswer",
      "What was the first company that you worked for?": "YourAnswer"
    },
    "preferred_consulates": ["Mumbai", "New Delhi", "Hyderabad"],
    "date_range_start": "2026-05-01",
    "date_range_end": "2026-12-31",
    "telegram_chat_id": ""
  }
]
```

## Usage

```bash
python main.py
```

The bot will loop through all users, attempting to book appointments. It stops when all users are booked or you press `Ctrl+C`.

For manual CAPTCHA mode (`CAPTCHA_MODE=manual`), set `HEADLESS=false` so you can see and solve the CAPTCHA in the browser window.

## Architecture

```
main.py                  ← Orchestrator (loops users x cycles)
├── login.py             ← Step 1-2: Login + Security Questions
├── dashboard.py         ← Step 3: Navigate to scheduling page
├── ofc_booking.py       ← Step 4: OFC (biometric) appointment
├── interview_booking.py ← Step 5: Interview appointment
├── confirmation.py      ← Step 6: Download confirmation
├── notifier.py          ← Telegram notifications
├── models.py            ← UserProfile & BookingResult dataclasses
└── config.py            ← Environment & user config loading
```

### Edge Cases Handled
- **OFC Reset:** If the OFC appointment resets to PENDING during interview wait, the bot detects it and restarts from Step 4
- **Session Expiry:** Detected via Azure B2C redirect URL
- **Rate Limiting:** Dashboard warning banners are detected and reported
- **Calendar Navigation:** jQuery UI datepicker with 0-indexed months, dual-month view

## Tests

```bash
pip install -r requirements-test.txt
python -m pytest tests/ -v
```

**65 tests** covering all 6 steps, flow validation, edge cases, and multi-agent E2E scenarios.

## Telegram Notifications

The bot sends Telegram messages for key events:
- Login success/failure
- OFC date found and booked
- Interview date found and booked
- Booking confirmation
- Errors and session expiry

To set up: create a bot via [@BotFather](https://t.me/BotFather), get the token, and add each user's `telegram_chat_id`.

## Disclaimer

This tool is for personal use. Use responsibly and in compliance with the website's terms of service.
