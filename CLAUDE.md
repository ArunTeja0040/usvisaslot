# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Multi-user automated US visa appointment bot targeting https://usvisascheduling.com for Indian consulates (Mumbai, New Delhi, Chennai, Kolkata, Hyderabad). Handles the full 6-step booking flow: login → security questions → dashboard → OFC booking → interview booking → confirmation download. Uses Playwright for browser automation and Telegram for notifications.

## Setup & Run

```bash
pip install -r requirements.txt
playwright install chromium
cp .env.example .env          # fill in Telegram token + settings
cp users.json.example users.json  # or edit users.json directly — add each user's credentials
python main.py
```

## Architecture

The bot follows the exact 6-step flow of usvisascheduling.com:

```
main.py (orchestrator — loops users × cycles)
  ├── login.py          Step 1: Login (username + password + CAPTCHA)
  │                     Step 2: Security Questions (2 of 3, randomly selected)
  ├── dashboard.py      Step 3: Click Schedule or Reschedule button
  ├── ofc_booking.py    Step 4: OFC — select location, green date box, time slot, submit
  ├── interview_booking.py  Step 5: Interview — date dropdown, time slot, submit
  │                         Handles 20-30 min edge case + OFC reset detection
  ├── confirmation.py   Step 6: Download/screenshot confirmation document
  ├── notifier.py       Telegram notifications (per-user chat_id)
  ├── models.py         UserProfile and BookingResult dataclasses
  └── config.py         .env + users.json loading
```

### Multi-user flow
- Each user gets an isolated browser context (separate cookies/session)
- Users are processed sequentially with random delays between them
- Completed users are skipped in subsequent cycles
- Bot stops when all users are booked or manually stopped (Ctrl+C)

### Edge case: OFC → Interview timing gap
After OFC booking, interview dates may not appear for 20-30 minutes. The bot retries within `INTERVIEW_WAIT_MINUTES`. If OFC becomes unblocked during this wait (status resets to PENDING), it raises `OFCResetRequired` and restarts from Step 4.

## Critical: Selectors Need Updating

All CSS selectors across `login.py`, `dashboard.py`, `ofc_booking.py`, `interview_booking.py`, and `confirmation.py` are **placeholders** marked with `--- UPDATE ---` comments. You must:

1. Open https://usvisascheduling.com in a browser with DevTools
2. Inspect each page (login form, security questions, dashboard, OFC calendar, interview dropdown, confirmation)
3. Update the selectors in each file to match the real DOM

## Configuration

- `.env` — global settings (Telegram token, delays, CAPTCHA mode, headless)
- `users.json` — per-user credentials, security answers, consulate preferences, date ranges, Telegram chat IDs

## CAPTCHA Handling

Set `CAPTCHA_MODE` in `.env`:
- `manual` — bot pauses and waits up to 3 min for you to solve in the browser (requires `HEADLESS=false`)
- `2captcha` — placeholder for 2Captcha API integration (not yet implemented)
