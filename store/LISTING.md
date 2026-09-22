# Chrome Web Store submission — copy/paste sheet

Everything below is written to be pasted straight into the Developer Dashboard.
Publish as **Unlisted**: installable by link, not searchable, no Workspace domain needed.

---

## Store listing

**Extension name**

```
SlotHunter
```

**Short description** (132 char max — this is 118)

```
Appointment assistant for visa scheduling: watches for openings, alerts you, and books the slot your client asked for.
```

**Category:** Workflow & Planning
**Language:** English

**Detailed description**

```
SlotHunter is a private tool for a visa appointment booking service. It is used by one business and its own staff, and is distributed by invitation only.

WHAT IT DOES

Appointment openings on the US visa scheduling site appear without warning and are taken within seconds. Checking by hand around the clock is not realistic. SlotHunter watches the consulates you select and acts the moment something opens.

- Watches the locations you choose and reports what is available
- Books only dates inside the range agreed with that client, and refuses to book if no range is set
- Picks the earliest suitable date, then a time slot on that date
- Sends Telegram alerts when a slot is found, a booking confirms, or something needs a person
- Keeps one shared client list across the machines your team uses
- Staff accounts see only the clients assigned to them

PRIVACY

Client passwords and security answers are encrypted on the device before they are stored or synced, using a master password only the operator knows.

No analytics. No tracking. No advertising. Nothing sold or shared. The extension acts on the visa scheduling site and its login page, and nowhere else.

NOT AFFILIATED

SlotHunter is independent. It is not affiliated with, endorsed by, or connected to the U.S. Department of State, any consulate or embassy, or the operators of usvisascheduling.com. It does not guarantee an appointment.
```

**Privacy policy URL**

```
https://<your-github-username>.github.io/slothunter-privacy/
```

---

## Permission justifications

Paste each into its box under **Privacy practices**. Reviewers reject vague answers — each one below names the concrete feature.

**`storage`**

```
Stores the operator's client list, appointment preferences and extension settings on the device. Credentials within that list are encrypted before being written.
```

**`scripting`**

```
Registers one script into the page context of the visa scheduling site so the extension can read the appointment availability the site has already loaded. The site's own Content Security Policy blocks inline injection, so registerContentScripts is the only workable route.
```

**`tabs`**

```
Opens the extension's dashboard in a tab, and returns to the booking tab when a slot needs acting on.
```

**`alarms`**

```
Schedules periodic checks for Telegram commands sent by the operator, and the daily activity summary.
```

**`identity`**

```
Google sign-in for the optional Google Sheets backup, so the operator can export their own client list to their own spreadsheet. Used only when they connect a sheet.
```

**Host permission — `usvisascheduling.com`, `atlasauth.b2clogin.com`**

```
The appointment site and its login page. This is where the extension does its work: signing in, reading availability, and booking the appointment.
```

**Host permission — `http://localhost/*`**

```
Sends rotation commands to a VPN client running on the same computer. The request never leaves the machine. Needed because the appointment site rate-limits by IP address and blocks one outright after repeated requests.
```

**Host permission — `sheets.googleapis.com`, `docs.google.com`**

```
Writes the operator's client list to their own Google Sheet when they use the backup feature.
```

**Host permission — `api.telegram.org`**

```
Sends status alerts to the operator's own Telegram bot: slot found, booking confirmed, error needing attention.
```

**Host permission — `sbuaojiamicreyysvnqj.supabase.co`**

```
The operator's own database. Keeps one shared client list and booking history across the machines their team uses.
```

**Remote code**

```
No. All code is contained in the extension package.
```

---

## Data usage disclosure

Tick these, and nothing else:

| Question | Answer |
|---|---|
| Personally identifiable information | **Yes** — client names and login credentials |
| Authentication information | **Yes** — credentials for the visa site, encrypted before storage |
| Website content | **Yes** — appointment availability read from the visa site |
| Location / health / financial / personal communications / web history / user activity | **No** |

All three certifications can be affirmed truthfully:

- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the item's single purpose
- Not being used or transferred to determine creditworthiness or for lending

**Single purpose statement**

```
Monitors appointment availability on the US visa scheduling website and books an appointment matching the criteria the operator set for a given client.
```

---

## Assets needed

| Asset | Requirement | Status |
|---|---|---|
| Icon | 128×128 PNG | Have it — `extension/img/128.png` |
| Screenshot | 1280×800 or 640×400, at least one | **To capture** — dashboard with client data redacted |
| Small promo tile | 440×280 | Optional |

Redact real client names and usernames in the screenshot before uploading.

---

## Sequence

1. Register at the Developer Dashboard — $5 one-time
2. Publish the privacy policy (see `store/README.md`) and paste its URL above
3. Upload `slothunter-<version>.zip`
4. Fill in the copy above, set visibility to **Unlisted**, submit
5. **After approval**, copy the assigned extension ID and add it to the Google Cloud OAuth client, or Sheets sign-in will fail

Step 5 is the one that silently breaks things if skipped.
