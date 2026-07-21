# US Visa Auto Booking — Complete Flow Diagram & Test Cases

## MASTER FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│                        DASHBOARD                                 │
│  Click "Start Now" on user card                                  │
│  → activateUser() loads credentials into storage                 │
│  → Sets activeAutomationUser = username (PERSISTENT)             │
│  → Sets userStatus = "logging_in"                                │
│  → Opens usvisascheduling.com/en-US/                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              SITE LOADS (init() runs)                             │
│  Reads: activeAutomationUser, RELOGIN_FLAG                       │
│  Sets: automationActive = true/false                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
          ┌───────────┼────────────┬──────────────┐
          ▼           ▼            ▼              ▼
     ┌─────────┐ ┌─────────┐ ┌──────────┐  ┌──────────┐
     │WAITING  │ │PAGE NOT │ │b2clogin  │  │VISA SITE │
     │ROOM     │ │FOUND    │ │LOGIN     │  │PAGES     │
     └────┬────┘ └────┬────┘ └────┬─────┘  └────┬─────┘
          │           │           │              │
          ▼           ▼           ▼              │
  ┌──────────────┐ ┌──────────┐                  │
  │automationAct │ │automati- │                  │
  │ive = true?   │ │onActive? │                  │
  │              │ │          │                  │
  │YES: refresh  │ │YES:retry │                  │
  │  every 10s   │ │ up to 10 │                  │
  │              │ │          │                  │
  │NO: stop,     │ │NO: stop  │                  │
  │  do nothing  │ │          │                  │
  └──────────────┘ └──────────┘                  │
                                                 │
          ┌──────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│         b2clogin.com — handleLoginPage()                         │
│                                                                   │
│  waitForB2CPageReady() — waits up to 15s for form elements       │
│                                                                   │
│  Result = "login" ──────────────────────────────┐                │
│  Result = "security" ───────────────┐           │                │
│  Result = "unknown" ───┐            │           │                │
│                        ▼            ▼           ▼                │
│              ┌──────────────┐  ┌─────────┐  ┌────────────────┐  │
│              │activeAutoUser│  │Go to     │  │Check           │  │
│              │exists?       │  │Security  │  │activeAutoUser  │  │
│              │              │  │Questions │  │or RELOGIN_FLAG │  │
│              │YES: reload   │  │flow ─────┼──┼──────┐         │  │
│              │up to 5 times │  │          │  │      ▼         │  │
│              │              │  └─────────┘  │  ┌──────────┐  │  │
│              │NO: show      │               │  │Load user │  │  │
│              │settings only │               │  │creds from│  │  │
│              └──────────────┘               │  │storage   │  │  │
│                                             │  │          │  │  │
│                                             │  │Fill form │  │  │
│                                             │  │Run login │  │  │
│                                             │  └────┬─────┘  │  │
│                                             │       │        │  │
│                                             └───────┼────────┘  │
└─────────────────────────────────────────────────────┼───────────┘
                                                      │
                      ┌───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│               runLogin() — Auto Login Flow                       │
│                                                                   │
│  1. Fill username (signInName)                                   │
│  2. Fill password (password)                                     │
│  3. Check __abortAll → if true, STOP                             │
│  4. Solve CAPTCHA:                                               │
│     a. Capture image → canvas → base64                           │
│     b. Send to service worker → localhost:5123 (ddddocr)         │
│     c. Clean: uppercase, alphanumeric, must be 5 chars           │
│     d. Fill answer, click Continue                               │
│     e. If wrong → refresh CAPTCHA, retry (up to 5 times)         │
│     f. Check __abortAll each attempt                             │
│  5. Click Continue                                               │
│                                                                   │
│  → Navigates to Security Questions OR Dashboard                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────────────────────────────┐
│SECURITY QUESTIONS│    │ Skip to Dashboard (if no security Qs)    │
│                  │    └──────────────────┬───────────────────────┘
│ 1. Check abort   │                      │
│ 2. Detect 2 Qs   │                      │
│ 3. Fuzzy match:  │                      │
│    normalizeQ()  │                      │
│    strips non-   │                      │
│    alphanumeric  │                      │
│ 4. Fill answers  │                      │
│ 5. Click Continue│                      │
│                  │                      │
│ updateUserStatus │                      │
│ ("security_      │                      │
│  questions")     │                      │
└────────┬─────────┘                      │
         │                                │
         └───────────────┬────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│          VISA DASHBOARD (usvisascheduling.com/en-US/)            │
│                                                                   │
│  handleDashboard()                                               │
│  1. trackEvent("Reached dashboard")                              │
│  2. updateUserStatus("on_dashboard")                             │
│  3. Check activeAutomationUser OR reloginState                   │
│     → If neither + auto-dashboard disabled → STOP                │
│  4. Check rate limit warning                                     │
│     → If exceeded → updateStatus("rate_limited"), STOP           │
│  5. Wait for button (check __abortAll each second):              │
│     → "Reschedule Appointment" → click it                        │
│     → "Continue Application" → click it                          │
│  6. Timeout after 30 seconds                                     │
│                                                                   │
│  → Navigates to Booking Page                                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│         BOOKING PAGE (ofc-schedule or schedule)                   │
│                                                                   │
│  handleBookingPage()                                             │
│  1. Wait for #post_select dropdown (up to 10s)                   │
│  2. injectBookingPanel() — dates, locations, START/STOP          │
│  3. Check reloginState (401 recovery):                           │
│     → If active → restore dates/locations/round → startCycling  │
│  4. Check activeAutomationUser:                                  │
│     → If set → auto-start cycling (1s delay)                     │
│  5. Otherwise → wait for manual START click                      │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CYCLING LOOP                                    │
│                                                                   │
│  startCycling() → runCycleLoop()                                 │
│  1. updateUserStatus("cycling")                                  │
│  2. Start keep-alive (refresh every 8 min)                       │
│  3. For each selected location:                                  │
│     a. Check __abortAll → if true, STOP                          │
│     b. Select location in dropdown                               │
│     c. Wait 3-6 seconds (random, avoid Cloudflare)               │
│     d. Listen for vSCP events (schedule data from page.js)       │
│     e. Check if dates in preferred range                         │
│     f. If slots found:                                           │
│        → updateUserStatus("slot_found")                          │
│        → Stop cycling                                            │
│        → Select date                                             │
│        → If auto-submit → select time, click Submit              │
│     g. If no slots → continue to next location                   │
│  4. After all locations → start next round                       │
│  5. Check for 401 (session expired):                             │
│     → Save cycling state → set RELOGIN_FLAG → redirect to login  │
│  6. Check for 429 (rate limited):                                │
│     → Exponential backoff: 60s → 120s → 240s → max 5min         │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│                    STOP FLOW                                      │
│                                                                   │
│  Dashboard "Stop" button:                                        │
│  1. chrome.storage.local.remove("activeAutomationUser")          │
│     (PERSISTENT — survives all page reloads)                     │
│  2. Send "stopAll" message to ALL tabs:                          │
│     - usvisascheduling.com tabs                                  │
│     - b2clogin.com tabs                                          │
│  3. Content script receives "stopAll":                           │
│     - __abortAll = true (in-memory kill switch)                  │
│     - __autoBookingLoginActive = false                           │
│     - chrome.storage.local.remove("activeAutomationUser")        │
│     - stopCycling() if active                                    │
│     - clearInterval(keepAliveTimer)                              │
│  4. Set userStatus = "idle"                                      │
│                                                                   │
│  After stop, ANY page reload:                                    │
│  - init() checks activeAutomationUser → null                     │
│  - automationActive = false                                      │
│  - Waiting room: no refresh                                      │
│  - Page Not Found: no retry                                      │
│  - Login page: no auto-login                                     │
│  - Dashboard: no auto-click                                      │
│  - Booking page: no auto-cycling                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## TEST CASES

### TC-01: Start Now → Full Happy Path
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Click "Start Now" on dashboard | Status → "Logging In", visa tab opens | Dashboard badge, new tab |
| 2 | Site loads | Redirects to b2clogin.com login page | URL changes |
| 3 | Login page ready | Username & password auto-filled | Form fields populated |
| 4 | CAPTCHA | Auto-solved via OCR, Continue clicked | Activity log shows "Auto-solving CAPTCHA" |
| 5 | Security questions | 2 answers auto-filled, Continue clicked | Activity log shows "Answered 2 questions" |
| 6 | Visa dashboard | "Reschedule Appointment" auto-clicked | Activity log shows "Clicking Reschedule" |
| 7 | Booking page | Panel injected with correct dates/locations | Dates & checkboxes match profile |
| 8 | Cycling starts | START auto-clicked, locations cycling | Status → "Cycling" on dashboard |

### TC-02: Stop During Login
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user from dashboard | Login begins | Status = "Logging In" |
| 2 | Click "Stop" while on login page | All automation halts | Status → "Idle" |
| 3 | Refresh the visa/login tab | No auto-login happens | Page shows normal login form |
| 4 | Console log | "[AutoBook]" shows no automation activity | F12 → Console |

### TC-03: Stop During CAPTCHA Solving
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user, wait until CAPTCHA solving | CAPTCHA being solved | Activity log shows CAPTCHA events |
| 2 | Click "Stop" on dashboard | CAPTCHA loop exits | Log: "CAPTCHA aborted" |
| 3 | Refresh page | No auto-login | activeAutomationUser is null |

### TC-04: Stop During Cycling
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user, let it reach cycling | Locations being cycled | Status = "Cycling" |
| 2 | Click "Stop" on dashboard | Cycling stops immediately | Status → "Idle", panel shows "Stopped" |
| 3 | Refresh booking page | No auto-cycling starts | Panel shows START enabled, no cycling |
| 4 | Wait 8 minutes | No keep-alive refresh | Page stays static |

### TC-05: Waiting Room with Automation Active
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user from dashboard | activeAutomationUser set | Storage has the username |
| 2 | Site shows waiting room | Auto-refreshes every 10 seconds | Activity log: "Waiting room detected (attempt N)" |
| 3 | After waiting room clears | Redirects to login, auto-fills, continues | Full flow resumes |

### TC-06: Waiting Room with Automation Stopped
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Stop the user from dashboard | activeAutomationUser removed | Storage cleared |
| 2 | Visa tab shows waiting room | No auto-refresh | Console: "automation is stopped — not refreshing" |
| 3 | Page stays on waiting room | No further action | Idle |

### TC-07: Page Not Found with Automation Active
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user, site returns "Page Not Found" | Auto-retries up to 10 times | Log: "Page Not Found — retry N/10" |
| 2 | After page loads correctly | Continues to dashboard flow | Normal flow resumes |

### TC-08: Page Not Found with Automation Stopped
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Stop the user, visa tab shows Page Not Found | No auto-retry | Console: "automation is stopped — not retrying" |

### TC-09: Login Page Doesn't Load (Unknown State)
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start a user, b2clogin loads but form missing | Auto-reloads up to 5 times (5s each) | Log: "Login page not ready, retrying (N/5)" |
| 2 | After 5 failures | Stops retrying, shows error | Activity log: "Login page failed to load after 5 retries" |

### TC-10: CAPTCHA Wrong Answer → Retry
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | CAPTCHA OCR returns wrong answer | Detects error, refreshes CAPTCHA | Log: "Wrong answer" |
| 2 | Retries up to 5 times | New CAPTCHA each time | Activity log shows attempts |
| 3 | After correct answer | Continues to security questions | Page navigates |

### TC-11: CAPTCHA OCR Returns Invalid (Not 5 Chars)
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | OCR returns "ABC" (3 chars) | Rejected, CAPTCHA refreshed | Log: "OCR result rejected (not 5 chars)" |
| 2 | Retries with new CAPTCHA | Continues until valid 5-char answer | Normal flow resumes |

### TC-12: Security Questions — Fuzzy Matching
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Saved Q: "What is your pet's name?" | Page shows slightly different text | — |
| 2 | Page Q: "What is your pet's name ?" (extra space) | normalizeQ matches → answer filled | Log: "Answered" |
| 3 | Both questions answered | Continue clicked | Flow proceeds to dashboard |

### TC-13: Security Questions — No Match Found
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Page shows question not in saved Q&A | No answer filled | Log: "No answer found for..." |
| 2 | Less than 2 answered | Continue NOT auto-clicked | Manual intervention needed |

### TC-14: 401 Session Expired During Cycling
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Cycling active, 401 detected | Saves cycling state to sessionStorage | Log: "401/session expired detected" |
| 2 | Sets RELOGIN_FLAG, redirects to login | Auto-logins with same credentials | RELOGIN_FLAG in sessionStorage |
| 3 | After successful re-login | Reaches booking page, restores cycling | Same dates/locations/round restored |

### TC-15: Rate Limited on Dashboard
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Dashboard shows "exceeded maximum" warning | Detects rate limit | Log: "Rate limited" |
| 2 | Does NOT click Reschedule | Status → "rate_limited" | Dashboard shows error state |

### TC-16: Keep-Alive Refresh During Cycling
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Cycling active for 8+ minutes | Page refreshes automatically | Keep-alive timer fires |
| 2 | After refresh | Cycling state restored, continues | Same round/locations |

### TC-17: Start → Stop → Start Again (Same User)
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start user A | Full flow begins | Status = active |
| 2 | Stop user A | Everything halts | Status = "Idle" |
| 3 | Start user A again | Fresh login flow begins | New activeAutomationUser set |
| 4 | Completes full flow | Reaches cycling | Status = "Cycling" |

### TC-18: Start User A → Stop → Start User B
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start user A | User A logging in | activeAutomationUser = A |
| 2 | Stop user A | User A idle | activeAutomationUser removed |
| 3 | Start user B | User B credentials loaded | activeAutomationUser = B |
| 4 | Login page | User B's username/password filled | Different creds from A |

### TC-19: Edit Profile from Dashboard
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Click "Edit" on a user card | Modal opens with current data | All fields populated |
| 2 | Change dates, add location | Fields updated in modal | Visual check |
| 3 | Click "Save" | Profile saved to storage | userProfilesList updated |
| 4 | Card reflects changes | New dates/locations shown | Dashboard re-renders |

### TC-20: Delete Profile from Dashboard
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Click "Edit" → "Delete" | Confirm dialog | User prompted |
| 2 | Confirm deletion | Profile removed from storage | Card disappears |
| 3 | Total Users count decreases | Stats bar updates | Count -1 |

### TC-21: Dashboard Stats Accuracy
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | No users active | Active=0, Errors=0 | Stats bar |
| 2 | Start 1 user, reaches cycling | Active=1 | Stats bar updates |
| 3 | Simulate error | Errors count increases | Check eventLog |
| 4 | CAPTCHA events in log | CAPTCHA Rate calculated correctly | solved/total × 100 |

### TC-22: Activity Log Filtering
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Select specific user in filter | Only that user's events shown | Log entries filtered |
| 2 | Select "Error" type filter | Only error events shown | Type filter works |
| 3 | Click "Clear" | All events removed | Log empty |

### TC-23: Slot Found → Auto-Submit Disabled
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Cycling finds slot in date range | Cycling stops | Status = "slot_found" |
| 2 | Date selected automatically | Calendar shows selected date | Visual check |
| 3 | Waits for manual submit | Submit button NOT auto-clicked | User must click |

### TC-24: Slot Found → Auto-Submit Enabled
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Profile has autoSubmit = true | Cycling finds slot | Status = "slot_found" |
| 2 | Date auto-selected | Time slot auto-selected | Both filled |
| 3 | Submit auto-clicked | Confirmation page reached | Status = "confirmed" |

### TC-25: Dashboard Auto-Refresh
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Dashboard open while user cycling | Status updates every 2 seconds | Cards refresh |
| 2 | Activity log fills in real-time | New events appear at top | Log auto-updates |
| 3 | Stats bar updates | Active count, CAPTCHA rate update | Numbers change |

### TC-26: Multiple Page Reloads During Active Automation
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start user, reach booking page | Cycling active | — |
| 2 | Manually refresh page 3 times | Each time: auto-starts cycling | activeAutomationUser persists |
| 3 | Check dashboard | Status still "Cycling" | Consistent state |

### TC-27: Browser Tab Closed and Reopened
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Start user, close visa tab | activeAutomationUser still in storage | Dashboard shows active |
| 2 | Open usvisascheduling.com manually | Should detect activeAutoUser | Auto-login begins |

### TC-28: Location Checkbox Matching
| Step | Action | Expected | Check |
|------|--------|----------|-------|
| 1 | Profile has locations: ["Chennai", "Hyderabad"] | — | — |
| 2 | Booking page loads | "CHENNAI VAC" and "HYDERABAD VAC" checked | Fuzzy match works |
| 3 | Other locations unchecked | Mumbai, Kolkata, New Delhi unchecked | Only profile locations |

---

## HOW TO DEBUG

1. **Dashboard Activity Log** — Real-time event stream, filter by user or type
2. **Browser Console (F12)** — On visa tab, filter by `[AutoBook]` for all automation logs
3. **Chrome Storage Inspector** — Go to `chrome://extensions/` → service worker "Inspect" → Application → Storage → check:
   - `activeAutomationUser` — should be set when started, null when stopped
   - `loginDetails` — current user's credentials
   - `userStatuses` — all user statuses
   - `eventLog` — event history
   - `userProfilesList` — all saved profiles
4. **Session Storage** — On visa tab, F12 → Application → Session Storage → check:
   - `__autoBookingRelogin` — set during 401 recovery
   - `ab-cycling-state` — saved cycling state for restoration
   - `__abWaitingRoomCount` — waiting room retry count
   - `__abLoginRetryCount` — login page retry count
