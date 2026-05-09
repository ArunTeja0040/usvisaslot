# How the US Visa Auto Booking Extension Works

## What It Does

This Chrome extension automates the entire US visa appointment booking process on usvisascheduling.com. Instead of manually refreshing pages and clicking buttons, the bot does it for you 24/7.

---

## The Big Picture

```
YOU (setup)          →  BOT (runs automatically)        →  YOU (get notification)
Enter credentials       Login → Solve CAPTCHA →             Telegram alert:
Pick date range         Check slots → Book if found          "Slot booked!"
Click START
```

---

## Step-by-Step Flow

### Step 1: Login Page (atlasauth.b2clogin.com)

```
┌─────────────────────────────────────────┐
│           LOGIN PAGE                     │
│                                          │
│  ┌─ Settings Panel (injected by bot) ─┐  │
│  │  Username: [________]              │  │
│  │  Password: [________]              │  │
│  │  Security Q1: [________]           │  │
│  │  Security Q2: [________]           │  │
│  │  Security Q3: [________]           │  │
│  │  [SAVE & START]                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  1. You fill in credentials              │
│  2. You click SAVE & START               │
│  3. Bot takes over from here             │
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│        AUTO-LOGIN SEQUENCE               │
│                                          │
│  1. Fill username field                  │
│  2. Fill password field                  │
│  3. Capture CAPTCHA image                │
│  4. Send to local OCR server (ddddocr)   │
│  5. Get 5-character answer               │
│  6. Fill CAPTCHA field                   │
│  7. Click "Continue"                     │
│                                          │
│  If CAPTCHA wrong → refresh → retry      │
│  (up to 5 attempts)                      │
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│      SECURITY QUESTIONS PAGE             │
│                                          │
│  Site asks 2 random questions like:      │
│  "What is your birth place?"             │
│  "What is your favorite food?"           │
│                                          │
│  Bot matches question → fills answer     │
│  → clicks Continue                       │
└─────────────────────────────────────────┘
```

### Step 2: Dashboard (usvisascheduling.com)

```
┌─────────────────────────────────────────┐
│           DASHBOARD                      │
│                                          │
│  Bot finds "Reschedule" or "Continue"    │
│  button → clicks it automatically        │
│  → goes to booking page                  │
└─────────────────────────────────────────┘
```

### Step 3: Booking Page (OFC or Interview)

This is where the main action happens.

```
┌─────────────────────────────────────────┐
│         BOOKING PAGE                     │
│                                          │
│  ┌─ Booking Panel (injected by bot) ──┐  │
│  │  From Date: [June 1]               │  │
│  │  To Date:   [Aug 31]               │  │
│  │  Locations:                         │  │
│  │  ☑ Mumbai  ☑ Hyderabad             │  │
│  │  ☐ Chennai ☐ Delhi ☐ Kolkata       │  │
│  │  [START] [STOP] [LOGOUT]           │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌─ Activity Log ─────────────────────┐  │
│  │  08:30 CYCLING Started             │  │
│  │  08:31 CYCLING Checking Mumbai     │  │
│  │  08:31 CYCLING No slots            │  │
│  │  08:32 CYCLING Checking Hyderabad  │  │
│  └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## How Slot Cycling Works

This is the core loop that runs continuously until a slot is found:

```
                    ┌──────────────┐
                    │  START ROUND │
                    │  Round #1    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ Shuffle       │
                    │ locations     │
                    │ randomly      │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │  Pick next location     │
              │  (e.g. Mumbai)          │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Change dropdown to     │
              │  Mumbai                 │
              │                         │
              │  Site makes API call    │
              │  to server for dates    │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Server responds with   │
              │  available dates        │
              │  (or empty)             │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │ Any dates   │
                    │ in your     │──── NO ──→ Next location
                    │ range?      │            (or next round)
                    └──────┬──────┘
                           │
                          YES
                           │
              ┌────────────▼────────────┐
              │  Select first in-range  │
              │  date in calendar       │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Wait for time slots    │
              │  to load                │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │ Time slot   │
                    │ available?  │──── NO ──→ Try next date
                    └──────┬──────┘            (up to 5 dates)
                           │
                          YES
                           │
              ┌────────────▼────────────┐
              │  SLOT FOUND!            │
              │                         │
              │  1. Send Telegram alert │
              │  2. Take screenshot     │
              │  3. Auto-submit (if on) │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │ Booking     │
                    │ confirmed?  │
                    └──────┬──────┘
                     │     │     │
                    YES  FAIL  TIMEOUT
                     │     │     │
                     │     └──┬──┘
                     │        │
                     ▼        ▼
                  DONE!   Refresh dates
                  Stop    for same location
                  cycling → try next untried
                          date → if none left
                          → grace period
```

---

## What Happens After Failed Submit

```
Submit failed for June 15
        │
        ▼
Re-trigger same location dropdown
(no page refresh needed)
        │
        ▼
Server sends fresh available dates
        │
        ▼
Filter: in range + not already tried
        │
        ├── New dates found → try them
        │
        └── No new dates → GRACE PERIOD
                │
                ▼
        Focus on this location only
        5 rounds × 10 seconds apart
        Skip idle gaps & long breaks
                │
                ▼
        If still nothing → back to
        normal cycling all locations
```

---

## Two-Stage Booking: OFC then Interview

```
┌──────────────┐     Submit      ┌──────────────┐     Submit      ┌──────────────┐
│              │    success      │              │    success      │              │
│  OFC Page    │ ──────────────→ │  Interview   │ ──────────────→ │ Confirmation │
│ /ofc-schedule│  (page auto-   │    Page      │  (booking      │    Page      │
│              │   navigates)   │  /schedule   │   complete)    │              │
│  Cycling     │                │              │                │  DONE!       │
│  runs here   │                │  Cycling     │                │              │
│  first       │                │  auto-starts │                │              │
│              │                │  here too    │                │              │
└──────────────┘                └──────────────┘                └──────────────┘

Same cycling code runs on both pages.
Same date range and location preferences apply.
```

---

## Anti-Detection (Looking Human)

The site has Cloudflare protection. Bot mimics human behavior:

| What | How |
|------|-----|
| Random delays | 3-6 seconds between locations (not fixed timing) |
| Mouse movement | Fake cursor movements with natural curves |
| Scrolling | Random scroll up/down between actions |
| Idle gaps | Every 4-8 rounds, pause 30-90 seconds |
| Long breaks | Every 15-25 rounds, pause 2-5 minutes |
| Location shuffle | Check locations in random order each round |
| Tab blur/focus | Simulate user switching tabs |

---

## Error Recovery

```
┌─────────────────┐
│  ERROR DETECTED  │
└────────┬────────┘
         │
    ┌────▼────┐
    │  Type?  │
    └────┬────┘
         │
    ┌────┴──────────┬───────────────┬──────────────┬──────────────┐
    │               │               │              │              │
    ▼               ▼               ▼              ▼              ▼
┌────────┐    ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐
│  401   │    │   429    │   │  Sign-in │   │  Site   │   │ Rate     │
│Expired │    │Rate Limit│   │  Failed  │   │  Error  │   │ Warning  │
└───┬────┘    └────┬─────┘   └────┬─────┘   └────┬────┘   └────┬─────┘
    │              │              │              │              │
    ▼              ▼              ▼              ▼              ▼
 Re-login      Backoff        Retry          Retry         Logout
 auto-fill     60s→120s      up to 3x       up to 5x     (protect
 credentials   →240s→5min                                 session)
 resume        then retry
 cycling
```

All errors show 15-second countdown before auto-recovery, so you can see what went wrong.

---

## Session Keep-Alive

```
Every 6-12 minutes (random):
  Bot makes background request to site
  → If 200 OK: session alive, do nothing
  → If 401: session expired, trigger re-login
```

Prevents session timeout during long cycling periods.

---

## CAPTCHA Solving

```
CAPTCHA image on page
        │
        ▼
Draw to canvas → convert to base64
        │
        ▼
Send to service worker
        │
        ▼
Service worker POSTs to localhost:5123
        │
        ▼
ddddocr (Python OCR library) reads text
        │
        ▼
Clean result:
  - Strip special characters
  - Convert to UPPERCASE
  - Must be exactly 5 characters
        │
        ├── Valid → fill in and submit
        │
        └── Invalid → refresh CAPTCHA image → retry
            (up to 5 attempts)
```

---

## Telegram Notifications

Bot sends you alerts for:

| Event | Message |
|-------|---------|
| Slot found | Location, date, screenshot |
| Booking confirmed | Success confirmation |
| Submit failed | Which date failed, trying next |
| Session expired | Auto re-logging in |
| Rate limited | Backoff duration |
| Login success | Which user logged in |
| Cycling started/stopped | Status update |
| Error | What went wrong |

You can also **send commands back** via Telegram to control the bot.

---

## Key Files

| File | What it does |
|------|-------------|
| `auto-booking.js` | All automation logic — login, CAPTCHA, cycling, booking |
| `sw-enhanced.js` | Service worker — CAPTCHA relay, Telegram, daily reports |
| `content.js` | Original slot display extension (processes XHR data) |
| `page.js` | Runs inside the website — intercepts API calls, fires events |
| `dashboard.js` | Dashboard UI — user cards, slot history, analytics |
| `captcha_server.py` | Local Python server that reads CAPTCHA images |

---

## Communication Between Scripts

```
┌──────────────┐  CustomEvent   ┌──────────────┐  chrome.runtime  ┌──────────────┐
│   page.js    │ ────(vSCP)───→ │ auto-booking │ ───.sendMessage──→│  sw-enhanced │
│              │                │    .js       │                   │    .js       │
│ MAIN world   │                │ ISOLATED     │                   │ Service      │
│ (inside site)│                │ world        │                   │ Worker       │
│              │                │ (extension)  │                   │ (background) │
│ Intercepts   │                │              │                   │              │
│ API calls    │                │ All the      │                   │ CAPTCHA      │
│ from site    │                │ automation   │                   │ solving      │
│              │                │ logic        │                   │ Telegram     │
│ Detects      │                │              │                   │ Daily reports│
│ 401/429      │                │              │                   │              │
└──────────────┘                └──────────────┘                   └──────────────┘
```

---

## Summary

1. **You set up** credentials, date range, locations — click START
2. **Bot logs in** automatically (solves CAPTCHA, answers security questions)
3. **Bot navigates** to booking page
4. **Bot cycles** through locations checking for available dates
5. **When slot found** → selects date, picks time, submits booking
6. **If submit fails** → refreshes dates, tries next available date
7. **If all dates fail** → grace period (rapid retry same location)
8. **If session expires** → auto re-login, resume cycling
9. **You get Telegram alerts** for every important event
10. **Booking confirmed** → bot stops, you're done!
