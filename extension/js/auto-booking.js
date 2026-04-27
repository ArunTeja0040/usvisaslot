(function () {
  "use strict";

  const LOG_PREFIX = "[AutoBook]";
  const CAPTCHA_MAX_RETRIES = 5;
  const DASHBOARD_CLICK_DELAY = 2000;
  const MAX_EVENT_LOG = 500;
  const RELOGIN_FLAG = "__autoBookingRelogin";
  let __abortAll = false;

  const EVENT_TYPES = {
    LOGIN: "login", CAPTCHA: "captcha", SECURITY: "security",
    DASHBOARD: "dashboard", CYCLING: "cycling", SLOT_FOUND: "slot_found",
    BOOKING: "booking", ERROR: "error", QUEUE: "queue", SESSION: "session",
  };

  function log(msg) {
    console.log(`${LOG_PREFIX} ${msg}`);
  }

  // Batched event logging — collects events and flushes to storage every 2 seconds
  // instead of reading+writing the full 500-entry array on every single event
  let __pendingEvents = [];
  let __eventFlushTimer = null;

  function flushEventLog() {
    if (__pendingEvents.length === 0) return;
    const batch = __pendingEvents.splice(0);
    chrome.storage.local.get(["eventLog"], (data) => {
      const events = data.eventLog || [];
      events.unshift(...batch);
      if (events.length > MAX_EVENT_LOG) events.length = MAX_EVENT_LOG;
      chrome.storage.local.set({ eventLog: events });
    });
  }

  // Flush pending events before page unload to avoid losing logs on navigation
  window.addEventListener("beforeunload", () => {
    if (__eventFlushTimer) {
      clearTimeout(__eventFlushTimer);
      __eventFlushTimer = null;
    }
    flushEventLog();
  });

  function trackEvent(type, message, username, extra) {
    const event = {
      id: Date.now() + "_" + Math.random().toString(36).substring(2, 6),
      type, message, username: username || "",
      timestamp: new Date().toISOString(),
      ...extra,
    };
    __pendingEvents.push(event);
    if (!__eventFlushTimer) {
      __eventFlushTimer = setTimeout(() => {
        __eventFlushTimer = null;
        flushEventLog();
      }, 2000);
    }
    log(`[${type}] ${message}`);
  }

  function updateUserStatus(username, status, extra) {
    if (!username) return;
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = {
        ...(statuses[username] || {}),
        ...extra,
        status,
        updatedAt: new Date().toISOString(),
      };
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sendTelegramNotification(type, message) {
    chrome.storage.local.get(["telegramBotToken", "telegramChatId", "telegramNotify"], (data) => {
      if (!data.telegramBotToken || !data.telegramChatId) return;
      const notify = data.telegramNotify || { slot: true, confirmed: true, error: true, rate: true, login: true, cycling: true, stopped: true };
      if (notify[type] === false) return;

      const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" });
      const fullMessage = message + `\n\n🕐 <i>${ts} IST</i>`;

      chrome.runtime.sendMessage({ action: "sendTelegram", text: fullMessage }, (resp) => {
        if (chrome.runtime.lastError) {
          log("Telegram send failed: " + chrome.runtime.lastError.message);
        } else if (resp && !resp.ok) {
          log("Telegram error: " + (resp.error || "unknown"));
        }
      });
    });
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [
          "is_auto-login",
          "is_auto-submit",
          "is_auto-dashboard",
          "is_sel-1st-slot",
          "loginDetails",
          "securityQuestions",
          "captchaMode",
        ],
        (data) => resolve(data)
      );
    });
  }

  // ─── CAPTCHA SOLVING ────────────────────────────────────────────────

  async function solveCaptchaOCR(imgElement) {
    const canvas = document.createElement("canvas");
    canvas.width = imgElement.naturalWidth || imgElement.width;
    canvas.height = imgElement.naturalHeight || imgElement.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgElement, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "solveCaptcha",
        imageBase64: base64,
      });
      if (resp && resp.text) {
        // Clean: uppercase, keep only alphanumeric, must be exactly 5 chars
        const cleaned = resp.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (cleaned.length === 5) return cleaned;
        log("OCR result rejected (not 5 chars): " + resp.text + " → " + cleaned);
        return null;
      }
    } catch (e) {
      log("CAPTCHA solve error: " + e.message);
    }
    return null;
  }

  function clickSafe(el) {
    if (!el) return;
    // Strip javascript: href to avoid CSP violation, then restore after click
    const href = el.getAttribute("href");
    if (href && href.trimStart().startsWith("javascript:")) {
      el.removeAttribute("href");
    }
    el.click();
    if (href) el.setAttribute("href", href);
  }

  async function handleCaptcha(settings) {
    const captchaImg = document.getElementById("captchaImage");
    const captchaInput = document.getElementById(
      "extension_atlasCaptchaResponse"
    );
    const continueBtn = document.getElementById("continue");
    const refreshBtn = document.getElementById("captchaRefreshImage");

    if (!captchaImg || !captchaInput) {
      log("No CAPTCHA on page");
      return;
    }

    const mode = settings.captchaMode || "manual";

    if (mode === "manual") {
      log("CAPTCHA mode: manual — focusing input");
      captchaInput.focus();
      return;
    }

    log("CAPTCHA mode: auto — solving...");
    const activeUser = (await getSettings()).loginDetails?.username || "";
    trackEvent(EVENT_TYPES.CAPTCHA, "Auto-solving CAPTCHA", activeUser);

    for (let attempt = 1; attempt <= CAPTCHA_MAX_RETRIES; attempt++) {
      if (__abortAll) { log("CAPTCHA aborted"); return; }
      await sleep(1000);

      if (!captchaImg.complete || !captchaImg.naturalWidth) {
        await Promise.race([
          new Promise((r) => captchaImg.addEventListener("load", r, { once: true })),
          new Promise((r) => captchaImg.addEventListener("error", r, { once: true })),
          sleep(10000),
        ]);
      }

      const answer = await solveCaptchaOCR(captchaImg);
      if (!answer) {
        log(`Attempt ${attempt}: OCR failed, refreshing...`);
        trackEvent(EVENT_TYPES.CAPTCHA, `Attempt ${attempt}: OCR failed`, activeUser);
        clickSafe(refreshBtn);
        await sleep(2000);
        continue;
      }

      log(`Attempt ${attempt}: OCR answer = "${answer}"`);
      captchaInput.value = answer;
      captchaInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(500);

      if (continueBtn) continueBtn.click();

      await sleep(3000);

      const errorEl = document.getElementById("claimVerificationServerError");
      if (errorEl && errorEl.textContent.toLowerCase().includes("captcha")) {
        log(`Attempt ${attempt}: CAPTCHA failed, retrying...`);
        trackEvent(EVENT_TYPES.CAPTCHA, `Attempt ${attempt}: Wrong answer "${answer}"`, activeUser);
        clickSafe(refreshBtn);
        await sleep(2000);
        continue;
      }

      trackEvent(EVENT_TYPES.CAPTCHA, `Solved on attempt ${attempt}`, activeUser);
      log("CAPTCHA appears solved or page navigated");
      return;
    }

    log("CAPTCHA max retries reached — falling back to manual");
    trackEvent(EVENT_TYPES.CAPTCHA, `Failed after ${CAPTCHA_MAX_RETRIES} attempts — manual input needed`, activeUser);
    captchaInput.focus();
  }

  // ─── SECURITY QUESTIONS ─────────────────────────────────────────────

  function normalizeQ(text) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findAnswer(securityQAs, questionText) {
    const exact = securityQAs[questionText];
    if (exact) return exact;

    const normQ = normalizeQ(questionText);
    for (const [savedQ, answer] of Object.entries(securityQAs)) {
      if (normalizeQ(savedQ) === normQ) return answer;
      if (normQ.includes(normalizeQ(savedQ)) || normalizeQ(savedQ).includes(normQ)) return answer;
    }
    return null;
  }

  async function handleSecurityQuestions(securityQAs, retries = 0) {
    if (__abortAll) { log("Security questions aborted"); return; }
    const questionItems = document.querySelectorAll(
      "#attributeList li.Paragraph"
    );
    if (questionItems.length < 2) {
      if (retries >= 15) {
        log("Security questions not found after 15 retries");
        return;
      }
      await sleep(1000);
      return handleSecurityQuestions(securityQAs, retries + 1);
    }

    const activeUser = (await getSettings()).loginDetails?.username || "";
    log("Security questions detected");
    log("Saved Q&A keys: " + Object.keys(securityQAs).join(" | "));
    trackEvent(EVENT_TYPES.SECURITY, "Security questions page detected", activeUser);
    updateUserStatus(activeUser, "security_questions");
    let answered = 0;

    for (const item of questionItems) {
      const questionEl = item.querySelector("p.textInParagraph");
      if (!questionEl) continue;

      const questionText = questionEl.textContent.trim();
      const answer = findAnswer(securityQAs, questionText);

      if (answer) {
        const answerInput = item.nextElementSibling?.querySelector(
          'input[type="password"]'
        );
        if (answerInput) {
          answerInput.value = answer.trim();
          answerInput.dispatchEvent(new Event("input", { bubbles: true }));
          answered++;
          log(`Answered: "${questionText.substring(0, 50)}..."`);
        }
      } else {
        log(`No answer found for: "${questionText}"`);
      }
    }

    if (answered >= 2) {
      trackEvent(EVENT_TYPES.SECURITY, `Answered ${answered} questions`, activeUser);
      sendTelegramNotification("login", `🔑 <b>LOGIN SUCCESSFUL</b>\n\n👤 <b>User:</b> ${activeUser}\n✅ Security questions answered\n🔄 Navigating to dashboard...`);
      await sleep(2000);
      const continueBtn = document.getElementById("continue");
      if (continueBtn) {
        log("Clicking Continue after security questions");
        continueBtn.click();
      }
    } else {
      trackEvent(EVENT_TYPES.ERROR, `Only answered ${answered}/2 security questions`, activeUser);
    }
  }

  // ─── SETTINGS PANEL (injected on login page) ─────────────────────

  const CONSULATE_LOCATIONS = [
    "Mumbai",
    "New Delhi",
    "Chennai",
    "Kolkata",
    "Hyderabad",
  ];

  const VISA_TYPES = [
    "H1B", "H4", "L1", "L2", "B1/B2", "F1", "F2", "J1", "J2", "O1", "Other"
  ];

  const SECURITY_QUESTIONS = [
    "Where did you meet your spouse?",
    "What is your sibling's middle name?",
    "Who was your childhood hero?",
    "In what city or town was your first job?",
    "What is the name of a college you applied to but didn't attend?",
    "What is the name of the road/street you grew up on?",
    "What is your least favorite food?",
    "What was the first company that you worked for?",
    "What is your favorite food?",
    "What high school did you attend?",
    "What is your mother's maiden name?",
    "What was the name of your first/current/favorite pet?",
    "What was your first car?",
    "What elementary school did you attend?",
    "What is the name of the town/city where you were born?",
  ];

  function buildQuestionOptions() {
    return '<option value="">-- Select --</option>' +
      SECURITY_QUESTIONS.map((q) => `<option value="${q}">${q}</option>`).join("");
  }

  // ─── MULTI-USER PROFILE HELPERS ─────────────────────────────────

  function loadUserProfiles() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["userProfilesList"], (data) => {
        resolve(data.userProfilesList || []);
      });
    });
  }

  function saveUserProfiles(profiles) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ userProfilesList: profiles }, resolve);
    });
  }

  function getFormData() {
    const securityQuestions = {};
    for (let i = 1; i <= 3; i++) {
      const q = document.getElementById(`sp-q${i}`).value;
      const a = document.getElementById(`sp-a${i}`).value;
      if (q && a) securityQuestions[q] = a;
    }
    const selectedLocations = Array.from(document.querySelectorAll(".sp-loc-cb:checked")).map((cb) => cb.value);
    return {
      username: document.getElementById("sp-username").value.trim(),
      password: document.getElementById("sp-password").value,
      securityQuestions,
      autoLogin: document.getElementById("sp-auto-login").checked,
      autoDashboard: document.getElementById("sp-auto-dashboard").checked,
      autoSelect: document.getElementById("sp-auto-select").checked,
      autoSubmit: document.getElementById("sp-auto-submit").checked,
      captchaMode: document.querySelector('input[name="sp-captcha"]:checked')?.value || "manual",
      startDate: document.getElementById("sp-start-date")?.value || "",
      endDate: document.getElementById("sp-end-date")?.value || "",
      locations: selectedLocations,
      visaType: document.getElementById("sp-visa-type")?.value || "",
      agreedPrice: document.getElementById("sp-price")?.value || "",
    };
  }

  function populateForm(profile) {
    document.getElementById("sp-username").value = profile.username || "";
    document.getElementById("sp-password").value = profile.password || "";

    for (let i = 1; i <= 3; i++) {
      document.getElementById(`sp-q${i}`).value = "";
      document.getElementById(`sp-a${i}`).value = "";
    }
    if (profile.securityQuestions) {
      const entries = Object.entries(profile.securityQuestions);
      entries.forEach(([q, a], idx) => {
        const qEl = document.getElementById(`sp-q${idx + 1}`);
        const aEl = document.getElementById(`sp-a${idx + 1}`);
        if (qEl) qEl.value = q;
        if (aEl) aEl.value = a;
      });
    }

    document.getElementById("sp-auto-login").checked = profile.autoLogin !== false;
    document.getElementById("sp-auto-dashboard").checked = profile.autoDashboard !== false;
    document.getElementById("sp-auto-select").checked = profile.autoSelect !== false;
    document.getElementById("sp-auto-submit").checked = profile.autoSubmit === true;

    const radio = document.querySelector(`input[name="sp-captcha"][value="${profile.captchaMode || "manual"}"]`);
    if (radio) radio.checked = true;

    const sd = document.getElementById("sp-start-date");
    const ed = document.getElementById("sp-end-date");
    if (sd) sd.value = profile.startDate || "";
    if (ed) ed.value = profile.endDate || "";

    const savedLocs = profile.locations || [];
    document.querySelectorAll(".sp-loc-cb").forEach((cb) => {
      cb.checked = savedLocs.length === 0 || savedLocs.includes(cb.value);
    });

    const visaEl = document.getElementById("sp-visa-type");
    if (visaEl) visaEl.value = profile.visaType || "";

    const priceEl = document.getElementById("sp-price");
    if (priceEl) priceEl.value = profile.agreedPrice || "";
  }

  function deriveProfileName(username) {
    if (!username) return "User";
    const atIdx = username.indexOf("@");
    return atIdx > 0 ? username.substring(0, atIdx) : username;
  }

  async function refreshUserDropdown(selectedUsername) {
    const profiles = await loadUserProfiles();
    const sel = document.getElementById("sp-user-select");
    if (!sel) return;

    sel.innerHTML = '<option value="__new__">+ New User</option>';
    profiles.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.username;
      opt.textContent = p.name || deriveProfileName(p.username);
      sel.appendChild(opt);
    });

    if (selectedUsername) {
      sel.value = selectedUsername;
    }

    // Show/hide delete button
    const delBtn = document.getElementById("sp-delete-btn");
    if (delBtn) delBtn.style.display = sel.value === "__new__" ? "none" : "inline-block";
  }

  // ─── GOOGLE SHEETS SYNC ──────────────────────────────────────────

  function toCSVExportUrl(url) {
    // Convert any Google Sheet URL to published CSV export URL
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return url; // already a direct URL or invalid
    const sheetId = match[1];
    return `https://docs.google.com/spreadsheets/d/${sheetId}/pub?output=csv`;
  }

  function parseCSVLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  }

  function parseSheetCSV(csvText) {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
    const profiles = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 2) continue;

      const row = {};
      headers.forEach((h, idx) => (row[h] = fields[idx] || ""));

      if (!row.username) continue;

      const securityQuestions = {};
      if (row.q1 && row.a1) securityQuestions[row.q1] = row.a1;
      if (row.q2 && row.a2) securityQuestions[row.q2] = row.a2;
      if (row.q3 && row.a3) securityQuestions[row.q3] = row.a3;

      const locations = row.locations
        ? row.locations.split(/[,;|]/).map((l) => l.trim()).filter(Boolean)
        : [];

      profiles.push({
        username: row.username.trim(),
        password: row.password || "",
        name: deriveProfileName(row.username.trim()),
        securityQuestions,
        startDate: row.startdate || row["start date"] || "",
        endDate: row.enddate || row["end date"] || "",
        locations,
        visaType: row.visatype || row["visa type"] || "",
        agreedPrice: row.price || row.agreedprice || "",
        autoLogin: true,
        autoDashboard: true,
        autoSelect: true,
        autoSubmit: false,
        captchaMode: "auto",
      });
    }
    return profiles;
  }

  async function syncFromGoogleSheet(url) {
    const csvUrl = toCSVExportUrl(url);
    log("Syncing from Google Sheet: " + csvUrl);

    const resp = await fetch(csvUrl);
    if (!resp.ok) throw new Error(`Failed to fetch sheet: ${resp.status}`);

    const csvText = await resp.text();
    const sheetProfiles = parseSheetCSV(csvText);

    if (sheetProfiles.length === 0) throw new Error("No valid profiles found in sheet");

    // Merge: update existing by username, add new, keep local-only
    let existing = await loadUserProfiles();
    let added = 0, updated = 0;

    for (const sp of sheetProfiles) {
      const idx = existing.findIndex((p) => p.username === sp.username);
      if (idx >= 0) {
        // Merge: sheet data overwrites, but keep local automation toggles
        existing[idx] = {
          ...existing[idx],
          password: sp.password || existing[idx].password,
          securityQuestions: Object.keys(sp.securityQuestions).length > 0
            ? sp.securityQuestions : existing[idx].securityQuestions,
          startDate: sp.startDate || existing[idx].startDate,
          endDate: sp.endDate || existing[idx].endDate,
          locations: sp.locations.length > 0 ? sp.locations : existing[idx].locations,
          visaType: sp.visaType || existing[idx].visaType,
          agreedPrice: sp.agreedPrice || existing[idx].agreedPrice,
          name: sp.name,
        };
        updated++;
      } else {
        existing.push(sp);
        added++;
      }
    }

    await saveUserProfiles(existing);
    return { added, updated, total: existing.length };
  }

  // ─── PASTE CLIENT MESSAGE PARSER ─────────────────────────────────

  const SECURITY_QUESTION_MAP = {
    "birth ?place|town.+born|city.+born|where.+born": "What is the name of the town/city where you were born?",
    "favorite food|fav.?food": "What is your favorite food?",
    "childhood hero": "Who was your childhood hero?",
    "spouse|meet.+spouse|where.+meet": "Where did you meet your spouse?",
    "sibling.+middle|middle.+name.+sibling": "What is your sibling's middle name?",
    "first.+job.+city|city.+first.+job": "In what city or town was your first job?",
    "college.+not.+attend|college.+didn": "What is the name of a college you applied to but didn't attend?",
    "street.+grew|road.+grew|grew.+up.+street|grew.+up.+road": "What is the name of the road/street you grew up on?",
    "least.+fav.+food|least.+favorite.+food": "What is your least favorite food?",
    "first.+company|company.+work": "What was the first company that you worked for?",
    "high.?school": "What high school did you attend?",
    "mother.+maiden|maiden.+name": "What is your mother's maiden name?",
    "first.+pet|favorite.+pet|current.+pet|pet.+name": "What was the name of your first/current/favorite pet?",
    "first.+car": "What was your first car?",
    "elementary.+school": "What elementary school did you attend?",
  };

  const MONTH_MAP = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };

  const LOCATION_ALIASES = {
    "hyd": "Hyderabad", "hyderabad": "Hyderabad",
    "mum": "Mumbai", "mumbai": "Mumbai", "bombay": "Mumbai",
    "del": "New Delhi", "delhi": "New Delhi", "new delhi": "New Delhi",
    "chen": "Chennai", "chennai": "Chennai", "madras": "Chennai",
    "kol": "Kolkata", "kolkata": "Kolkata", "calcutta": "Kolkata",
  };

  function parseMonthRange(text) {
    const lower = text.toLowerCase().replace(/[^a-z0-9\s,&-]/g, " ");
    const year = new Date().getFullYear();

    const monthEntries = [];
    for (const [name, num] of Object.entries(MONTH_MAP)) {
      const idx = lower.indexOf(name);
      if (idx !== -1) {
        const alreadyAdded = monthEntries.find((e) => e.num === num);
        if (!alreadyAdded) monthEntries.push({ num, idx });
      }
    }
    if (monthEntries.length === 0) return { startDate: "", endDate: "" };
    monthEntries.sort((a, b) => a.idx - b.idx);

    function weekToDay(monthNum, textAfterMonth) {
      const wk = textAfterMonth.match(/(\d)\s*(?:st|nd|rd|th)?\s*week/);
      if (wk) {
        const weekNum = parseInt(wk[1]);
        const day = Math.min((weekNum - 1) * 7 + 1, new Date(year, monthNum + 1, 0).getDate());
        return day;
      }
      return null;
    }

    const firstEntry = monthEntries[0];
    const lastEntry = monthEntries[monthEntries.length - 1];

    const textAfterFirst = lower.substring(firstEntry.idx);
    const startWeekDay = weekToDay(firstEntry.num, textAfterFirst);
    const startDay = startWeekDay || 1;
    const startDate = `${year}-${String(firstEntry.num + 1).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;

    const textAfterLast = lower.substring(lastEntry.idx);
    const endWeekDay = weekToDay(lastEntry.num, textAfterLast);
    let endDay;
    if (endWeekDay) {
      endDay = Math.min(endWeekDay + 6, new Date(year, lastEntry.num + 1, 0).getDate());
    } else {
      endDay = new Date(year, lastEntry.num + 1, 0).getDate();
    }
    const endDate = `${year}-${String(lastEntry.num + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    return { startDate, endDate };
  }

  function parsePrice(text) {
    const lower = text.toLowerCase().replace(/,/g, "");
    const match = lower.match(/(\d+\.?\d*)\s*k/);
    if (match) return String(Math.round(parseFloat(match[1]) * 1000));
    const numMatch = lower.match(/(\d+)/);
    return numMatch ? numMatch[1] : "";
  }

  function parseLocations(text) {
    const lower = text.toLowerCase();
    const found = [];
    for (const [alias, city] of Object.entries(LOCATION_ALIASES)) {
      if (lower.includes(alias) && !found.includes(city)) found.push(city);
    }
    return found;
  }

  function matchSecurityQuestion(key) {
    const lower = key.toLowerCase().replace(/[^a-z\s]/g, "");
    for (const [pattern, question] of Object.entries(SECURITY_QUESTION_MAP)) {
      if (new RegExp(pattern, "i").test(lower)) return question;
    }
    return null;
  }

  function parseClientMessage(text) {
    const profile = {
      username: "", password: "", securityQuestions: {},
      startDate: "", endDate: "", locations: [],
      visaType: "", agreedPrice: "", applicants: "",
      autoLogin: true, autoDashboard: true, autoSelect: true,
      autoSubmit: false, captchaMode: "auto",
    };

    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let pendingQuestion = null; // for multi-line Q/A detection

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      // Check if this line IS a known security question (exact or close match)
      const exactQ = SECURITY_QUESTIONS.find((q) =>
        line.replace(/[*\d]/g, "").trim().toLowerCase() === q.toLowerCase() ||
        line.toLowerCase().includes(q.toLowerCase().substring(0, 30))
      );
      if (exactQ) {
        pendingQuestion = exactQ;
        continue;
      }

      // Check if this is an answer to a pending question
      if (pendingQuestion && /^ans(wer)?\s*[:.]?\s*/i.test(line)) {
        const answer = line.replace(/^ans(wer)?\s*[:.]?\s*/i, "").trim();
        if (answer) profile.securityQuestions[pendingQuestion] = answer;
        pendingQuestion = null;
        continue;
      }

      // Skip lines like "Security Question 1*"
      if (/^security\s+question\s*\d/i.test(line)) continue;

      pendingQuestion = null;

      // Try key:value split
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) {
        // Check for standalone price like "42k agreed"
        if (/(\d+\.?\d*)\s*k/i.test(line)) {
          profile.agreedPrice = parsePrice(line);
        }
        continue;
      }

      let key = line.substring(0, colonIdx).replace(/[.\s]+$/g, "").trim();
      let value = line.substring(colonIdx + 1).trim();

      const keyLower = key.toLowerCase().replace(/[^a-z\s]/g, "");

      // Username (handles typos like "sername", "usrname", etc.)
      if (/u?ser\s*name|user\s*id|email/i.test(keyLower)) {
        profile.username = value;
        continue;
      }

      // Password
      if (/pass\s*word|pwd/i.test(keyLower)) {
        profile.password = value;
        continue;
      }

      // Dates
      if (/date|month|when|prefer.*date|slot.*date/i.test(keyLower)) {
        const { startDate, endDate } = parseMonthRange(value);
        if (startDate) profile.startDate = startDate;
        if (endDate) profile.endDate = endDate;
        continue;
      }

      // Location
      if (/location|city|consulate|place.*prefer|prefer.*place/i.test(keyLower)) {
        profile.locations = parseLocations(value);
        continue;
      }

      // Visa type
      if (/visa|typ.*visa|visa.*typ/i.test(keyLower)) {
        profile.visaType = value.replace(/\s+/g, "").toUpperCase();
        continue;
      }

      // Price — check before applicants so "18k each person : agreed" isn't consumed by /person/
      if (/price|cost|amount|fee|\d+\s*k/i.test(key) || (/agreed|confirm|ok|done/i.test(value) && /\d/.test(key))) {
        profile.agreedPrice = parsePrice(key + " " + value);
        continue;
      }

      // Applicants
      if (/applicant|member|people|person/i.test(keyLower)) {
        profile.applicants = value.replace(/[^0-9]/g, "");
        continue;
      }

      // Security questions — fuzzy match on key
      const question = matchSecurityQuestion(key);
      if (question) {
        profile.securityQuestions[question] = value;
        continue;
      }
    }

    if (profile.username) {
      profile.name = deriveProfileName(profile.username);
    }

    return profile;
  }

  function injectSettingsPanel() {
    if (document.getElementById("sp-panel")) return;

    const qOpts = buildQuestionOptions();

    const panel = document.createElement("div");
    panel.id = "sp-panel";
    panel.style.cssText =
      "position:fixed;top:10px;left:10px;width:480px;max-height:90vh;overflow-y:auto;z-index:99999;" +
      "box-shadow:0 4px 20px rgba(0,0,0,0.3);border-radius:8px;font-family:Arial,sans-serif;font-size:13px;";
    panel.innerHTML = `
      <div id="sp-header" style="background:#1a5276;color:white;padding:10px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
        <strong>Auto-Booking Settings</strong>
        <span id="sp-toggle" style="font-size:18px;line-height:1;">&#9660;</span>
      </div>
      <div id="sp-body" style="background:white;padding:14px;border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;">

        <!-- Google Sheet Sync -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Google Sheet Sync</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="sp-sheet-url" placeholder="Paste Google Sheet URL here" style="flex:1;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            <button id="sp-sync-btn" style="background:#2980b9;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;">SYNC</button>
          </div>
          <div id="sp-sync-status" style="font-size:11px;color:#888;margin-top:4px;"></div>
        </div>

        <!-- Paste Client Message -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Quick Add (Paste Client Message)</div>
          <textarea id="sp-paste-box" placeholder="Paste WhatsApp message here...&#10;&#10;username: john123&#10;password: Pass@123&#10;birth place: Mumbai&#10;favorite food: biryani&#10;dates: june and july&#10;location: Hyderabad&#10;visa: H1B&#10;42k: agreed"
                    style="width:100%;height:0;min-height:0;padding:0;border:1px solid #ccc;border-radius:4px;font-size:11px;font-family:monospace;resize:vertical;box-sizing:border-box;overflow:hidden;transition:all 0.2s;display:none;"></textarea>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
            <button id="sp-paste-toggle" style="background:#8e44ad;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">PASTE MESSAGE</button>
            <button id="sp-paste-parse" style="background:#27ae60;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;display:none;">ADD PROFILE</button>
            <span id="sp-paste-status" style="font-size:11px;color:#888;"></span>
          </div>
        </div>

        <!-- User Profile Selector -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">User Profile</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <select id="sp-user-select" style="flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
              <option value="__new__">+ New User</option>
            </select>
            <button id="sp-delete-btn" style="background:#e74c3c;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;display:none;">DELETE</button>
          </div>
        </div>

        <!-- Login Credentials -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Login Credentials</div>
          <div style="display:flex;gap:8px;">
            <input type="text" id="sp-username" placeholder="Email / Username" style="flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
            <input type="password" id="sp-password" placeholder="Password" style="flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
          </div>
        </div>

        <!-- Security Questions -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Security Questions</div>
          ${[1, 2, 3]
            .map(
              (n) => `
            <div style="margin-bottom:6px;">
              <select id="sp-q${n}" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:11px;margin-bottom:3px;">${qOpts}</select>
              <input type="text" id="sp-a${n}" placeholder="Answer ${n}" style="width:100%;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;box-sizing:border-box;">
            </div>`
            )
            .join("")}
        </div>

        <!-- Booking Preferences -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Booking Preferences</div>
          <div style="display:flex;gap:8px;margin-bottom:6px;">
            <label style="font-size:12px;font-weight:600;">Start Date:
              <input type="date" id="sp-start-date" style="margin-left:2px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            </label>
            <label style="font-size:12px;font-weight:600;">End Date:
              <input type="date" id="sp-end-date" style="margin-left:2px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            </label>
          </div>
          <div style="margin-bottom:6px;">
            <strong style="font-size:12px;">Locations: </strong>
            ${CONSULATE_LOCATIONS.map((loc) => `
              <label style="display:inline-flex;align-items:center;gap:3px;margin-right:10px;cursor:pointer;font-size:12px;">
                <input type="checkbox" class="sp-loc-cb" value="${loc}" checked style="width:13px;height:13px;cursor:pointer;">
                ${loc}
              </label>`).join("")}
          </div>
          <div style="display:flex;gap:8px;">
            <label style="font-size:12px;font-weight:600;">Visa Type:
              <select id="sp-visa-type" style="margin-left:2px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
                <option value="">-- Select --</option>
                ${VISA_TYPES.map((v) => `<option value="${v}">${v}</option>`).join("")}
              </select>
            </label>
            <label style="font-size:12px;font-weight:600;">Agreed Price ($):
              <input type="number" id="sp-price" placeholder="0" min="0" style="width:80px;margin-left:2px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            </label>
          </div>
        </div>

        <!-- Automation toggles -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Automation</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;">
              <input type="checkbox" id="sp-auto-login" checked> Auto-Login
            </label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;">
              <input type="checkbox" id="sp-auto-dashboard" checked> Auto-Dashboard
            </label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;">
              <input type="checkbox" id="sp-auto-select"> Auto-Select Slot
            </label>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;">
              <input type="checkbox" id="sp-auto-submit"> Auto-Submit
            </label>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <strong style="font-size:12px;">CAPTCHA:</strong>
            <label style="cursor:pointer;font-size:12px;"><input type="radio" name="sp-captcha" value="manual" checked> Manual</label>
            <label style="cursor:pointer;font-size:12px;"><input type="radio" name="sp-captcha" value="auto"> Auto (OCR)</label>
          </div>
        </div>

        <!-- Buttons -->
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="sp-save-btn"
                  style="background:#2c3e50;color:white;border:none;padding:8px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;">
            SAVE
          </button>
          <button id="sp-start-btn"
                  style="flex:1;background:#27ae60;color:white;border:none;padding:8px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;">
            SAVE & START
          </button>
          <span id="sp-save-status" style="font-size:12px;color:#27ae60;"></span>
        </div>
      </div>`;

    document.body.appendChild(panel);

    // Toggle collapse
    document.getElementById("sp-header").addEventListener("click", () => {
      const body = document.getElementById("sp-body");
      const arrow = document.getElementById("sp-toggle");
      if (body.style.display === "none") {
        body.style.display = "block";
        arrow.innerHTML = "&#9660;";
      } else {
        body.style.display = "none";
        arrow.innerHTML = "&#9654;";
      }
    });

    // Load saved Google Sheet URL
    chrome.storage.local.get(["googleSheetUrl"], (data) => {
      if (data.googleSheetUrl) {
        document.getElementById("sp-sheet-url").value = data.googleSheetUrl;
      }
    });

    // Sync button handler
    document.getElementById("sp-sync-btn").addEventListener("click", async () => {
      const urlInput = document.getElementById("sp-sheet-url");
      const statusEl = document.getElementById("sp-sync-status");
      const syncBtn = document.getElementById("sp-sync-btn");
      const url = urlInput.value.trim();

      if (!url) {
        statusEl.textContent = "Paste a Google Sheet URL first";
        statusEl.style.color = "#e74c3c";
        return;
      }

      // Save the URL
      chrome.storage.local.set({ googleSheetUrl: url });

      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing...";
      statusEl.textContent = "Fetching sheet...";
      statusEl.style.color = "#888";

      try {
        const result = await syncFromGoogleSheet(url);
        statusEl.textContent = `Synced! ${result.added} added, ${result.updated} updated (${result.total} total)`;
        statusEl.style.color = "#27ae60";

        // Refresh dropdown with updated profiles
        const profiles = await loadUserProfiles();
        await refreshUserDropdown(profiles.length > 0 ? profiles[0].username : "__new__");
        if (profiles.length > 0) populateForm(profiles[0]);
      } catch (e) {
        statusEl.textContent = "Sync failed: " + e.message;
        statusEl.style.color = "#e74c3c";
        log("Google Sheet sync error: " + e.message);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "SYNC";
      }
    });

    // Paste Message toggle
    document.getElementById("sp-paste-toggle").addEventListener("click", () => {
      const box = document.getElementById("sp-paste-box");
      const parseBtn = document.getElementById("sp-paste-parse");
      const toggleBtn = document.getElementById("sp-paste-toggle");
      if (box.style.display === "none") {
        box.style.display = "block";
        box.style.height = "120px";
        box.style.minHeight = "80px";
        box.style.padding = "6px 8px";
        parseBtn.style.display = "inline-block";
        toggleBtn.textContent = "CANCEL";
        toggleBtn.style.background = "#7f8c8d";
        box.focus();
      } else {
        box.style.display = "none";
        box.value = "";
        parseBtn.style.display = "none";
        toggleBtn.textContent = "PASTE MESSAGE";
        toggleBtn.style.background = "#8e44ad";
        document.getElementById("sp-paste-status").textContent = "";
      }
    });

    // Parse pasted message and add profile
    document.getElementById("sp-paste-parse").addEventListener("click", async () => {
      const box = document.getElementById("sp-paste-box");
      const statusEl = document.getElementById("sp-paste-status");
      const text = box.value.trim();

      if (!text) {
        statusEl.textContent = "Paste a message first";
        statusEl.style.color = "#e74c3c";
        return;
      }

      const parsed = parseClientMessage(text);

      if (!parsed.username) {
        statusEl.textContent = "Could not find username in message";
        statusEl.style.color = "#e74c3c";
        return;
      }

      // Add/update profile
      let profiles = await loadUserProfiles();
      const idx = profiles.findIndex((p) => p.username === parsed.username);
      if (idx >= 0) {
        profiles[idx] = { ...profiles[idx], ...parsed, name: parsed.name };
        statusEl.textContent = `Updated: ${parsed.name}`;
      } else {
        profiles.push(parsed);
        statusEl.textContent = `Added: ${parsed.name}`;
      }
      statusEl.style.color = "#27ae60";

      await saveUserProfiles(profiles);
      await refreshUserDropdown(parsed.username);
      populateForm(parsed);

      // Collapse paste box
      box.style.display = "none";
      box.value = "";
      document.getElementById("sp-paste-parse").style.display = "none";
      const toggleBtn = document.getElementById("sp-paste-toggle");
      toggleBtn.textContent = "PASTE MESSAGE";
      toggleBtn.style.background = "#8e44ad";

      log("Profile added from pasted message: " + parsed.username);
    });

    // User dropdown change — populate form with selected profile
    document.getElementById("sp-user-select").addEventListener("change", async () => {
      const sel = document.getElementById("sp-user-select");
      const delBtn = document.getElementById("sp-delete-btn");

      if (sel.value === "__new__") {
        document.getElementById("sp-username").value = "";
        document.getElementById("sp-password").value = "";
        for (let i = 1; i <= 3; i++) {
          document.getElementById(`sp-q${i}`).value = "";
          document.getElementById(`sp-a${i}`).value = "";
        }
        document.getElementById("sp-start-date").value = "";
        document.getElementById("sp-end-date").value = "";
        document.querySelectorAll(".sp-loc-cb").forEach((cb) => (cb.checked = true));
        document.getElementById("sp-visa-type").value = "";
        document.getElementById("sp-price").value = "";
        document.getElementById("sp-applicants") && (document.getElementById("sp-applicants").value = "");
        if (delBtn) delBtn.style.display = "none";
        return;
      }

      if (delBtn) delBtn.style.display = "inline-block";

      const profiles = await loadUserProfiles();
      const profile = profiles.find((p) => p.username === sel.value);
      if (profile) {
        log("Loading profile: " + profile.username);
        populateForm(profile);
      } else {
        log("Profile not found for: " + sel.value);
      }
    });

    // Delete button
    document.getElementById("sp-delete-btn").addEventListener("click", async () => {
      const sel = document.getElementById("sp-user-select");
      if (sel.value === "__new__") return;

      const username = sel.value;
      if (!confirm(`Delete profile for "${deriveProfileName(username)}"?`)) return;

      let profiles = await loadUserProfiles();
      profiles = profiles.filter((p) => p.username !== username);
      await saveUserProfiles(profiles);

      // Also clear active loginDetails if it matches
      chrome.storage.local.get(["loginDetails"], (data) => {
        if (data.loginDetails?.username === username) {
          chrome.storage.local.remove(["loginDetails", "securityQuestions"]);
        }
      });

      // Clear form and refresh dropdown
      document.getElementById("sp-username").value = "";
      document.getElementById("sp-password").value = "";
      for (let i = 1; i <= 3; i++) {
        document.getElementById(`sp-q${i}`).value = "";
        document.getElementById(`sp-a${i}`).value = "";
      }
      await refreshUserDropdown("__new__");

      const status = document.getElementById("sp-save-status");
      status.textContent = "Deleted!";
      status.style.color = "#e74c3c";
      setTimeout(() => { status.textContent = ""; status.style.color = "#27ae60"; }, 3000);
      log("Profile deleted: " + username);
    });

    // Load profiles and populate dropdown, then select first or migrate legacy
    (async () => {
      let profiles = await loadUserProfiles();

      // Migrate legacy single-user data if no profiles exist
      if (profiles.length === 0) {
        const legacy = await new Promise((resolve) => {
          chrome.storage.local.get(["loginDetails", "securityQuestions", "is_auto-login", "is_auto-submit", "is_auto-dashboard", "is_sel-1st-slot", "captchaMode"], resolve);
        });
        if (legacy.loginDetails?.username) {
          profiles.push({
            username: legacy.loginDetails.username,
            password: legacy.loginDetails.password,
            name: deriveProfileName(legacy.loginDetails.username),
            securityQuestions: legacy.securityQuestions || {},
            autoLogin: legacy["is_auto-login"] !== false,
            autoDashboard: legacy["is_auto-dashboard"] !== false,
            autoSelect: legacy["is_sel-1st-slot"] !== false,
            autoSubmit: legacy["is_auto-submit"] === true,
            captchaMode: legacy.captchaMode || "manual",
          });
          await saveUserProfiles(profiles);
          log("Migrated legacy settings to multi-user profile");
        }
      }

      await refreshUserDropdown(profiles.length > 0 ? profiles[0].username : "__new__");
      if (profiles.length > 0) {
        populateForm(profiles[0]);
      }
    })();

    // Save handler — saves to profile list AND sets as active loginDetails
    document.getElementById("sp-save-btn").addEventListener("click", async () => {
      const formData = getFormData();

      if (!formData.username) {
        const status = document.getElementById("sp-save-status");
        status.textContent = "Enter username!";
        status.style.color = "#e74c3c";
        setTimeout(() => { status.textContent = ""; status.style.color = "#27ae60"; }, 3000);
        return;
      }

      // Update or add profile
      let profiles = await loadUserProfiles();
      const idx = profiles.findIndex((p) => p.username === formData.username);
      const profile = {
        ...formData,
        name: deriveProfileName(formData.username),
      };

      if (idx >= 0) {
        profiles[idx] = profile;
      } else {
        profiles.push(profile);
      }

      await saveUserProfiles(profiles);

      // Set as active user for login/security/dashboard handlers
      chrome.storage.local.set({
        loginDetails: { username: formData.username, password: formData.password },
        securityQuestions: formData.securityQuestions,
        "is_auto-login": formData.autoLogin,
        "is_auto-dashboard": formData.autoDashboard,
        "is_sel-1st-slot": formData.autoSelect,
        "is_auto-submit": formData.autoSubmit,
        captchaMode: formData.captchaMode,
      });

      await refreshUserDropdown(formData.username);

      const status = document.getElementById("sp-save-status");
      status.textContent = "Saved!";
      setTimeout(() => (status.textContent = ""), 3000);
      log("Profile saved: " + formData.username);
    });

    // START button: save + trigger login
    document.getElementById("sp-start-btn").addEventListener("click", () => {
      document.getElementById("sp-save-btn").click();
      setTimeout(() => {
        const body = document.getElementById("sp-body");
        if (body) body.style.display = "none";
        document.getElementById("sp-toggle").innerHTML = "&#9654;";

        window.__autoBookingLoginActive = false;
        getSettings().then((s) => runLogin(s));
      }, 500);
    });

    log("Settings panel injected on login page");
  }

  // ─── LOGIN EXECUTION (only runs after START is clicked) ──────────

  async function runLogin(settings) {
    if (window.__autoBookingLoginActive) return;
    window.__autoBookingLoginActive = true;

    const loginDetails = settings.loginDetails;
    if (!loginDetails || !loginDetails.username || !loginDetails.password) {
      log("No login credentials configured");
      return;
    }

    const waitForForm = setInterval(async () => {
      if (__abortAll) { clearInterval(waitForForm); log("Login aborted"); return; }
      const userField = document.getElementById("signInName");
      const passField = document.getElementById("password");
      const captchaImg = document.getElementById("captchaImage");

      if (userField && passField && captchaImg) {
        clearInterval(waitForForm);

        await sleep(600);

        log("Login form detected — auto-filling...");
        trackEvent(EVENT_TYPES.LOGIN, "Auto-filling login form", loginDetails.username);
        updateUserStatus(loginDetails.username, "logging_in");
        userField.value = loginDetails.username;
        userField.dispatchEvent(new Event("input", { bubbles: true }));
        userField.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(300);

        passField.value = loginDetails.password;
        passField.dispatchEvent(new Event("input", { bubbles: true }));
        passField.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(300);

        await handleCaptcha(settings);
      }

      const responseFields = document.querySelectorAll('[id$="_response"]');
      if (responseFields.length === 2 && settings.securityQuestions) {
        clearInterval(waitForForm);
        await handleSecurityQuestions(settings.securityQuestions);
      }
    }, 500);
  }

  // ─── LOGIN PAGE (panel only — waits for START, unless re-login) ────

  function isSecurityQuestionsPage() {
    return document.querySelectorAll('[id$="_response"]').length >= 2;
  }

  function waitForB2CPageReady() {
    return new Promise((resolve) => {
      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        if (document.getElementById("signInName") || document.getElementById("captchaImage") ||
            document.getElementById("extension_atlasCaptchaResponse") || document.getElementById("continue")) {
          clearInterval(interval);
          resolve("login");
        } else if (isSecurityQuestionsPage()) {
          clearInterval(interval);
          resolve("security");
        } else if (checks > 30) {
          clearInterval(interval);
          resolve("unknown");
        }
      }, 500);
    });
  }

  async function handleLoginPage() {
    const pageType = await waitForB2CPageReady();

    if (pageType === "security") {
      log("On security questions page — skipping settings panel");
      const settings = await getSettings();
      if (settings.securityQuestions) {
        await handleSecurityQuestions(settings.securityQuestions);
      }
      return;
    }

    // If page didn't load properly and automation is active, reload to retry
    if (pageType === "unknown") {
      const autoUser = await new Promise((r) => {
        chrome.storage.local.get(["activeAutomationUser"], (d) => r(d.activeAutomationUser || null));
      });
      if (autoUser) {
        const retryCount = parseInt(sessionStorage.getItem("__abLoginRetryCount") || "0");
        if (retryCount < 5) {
          sessionStorage.setItem("__abLoginRetryCount", String(retryCount + 1));
          log(`Login page not ready (attempt ${retryCount + 1}/5) — reloading in 5s...`);
          trackEvent(EVENT_TYPES.LOGIN, `Login page not ready, retrying (${retryCount + 1}/5)`, autoUser);
          await sleep(5000);
          window.location.reload();
          return;
        } else {
          sessionStorage.removeItem("__abLoginRetryCount");
          log("Login page failed to load after 5 retries");
          trackEvent(EVENT_TYPES.ERROR, "Login page failed to load after 5 retries", autoUser);
        }
      }
    }

    // Page loaded successfully — clear retry counter
    sessionStorage.removeItem("__abLoginRetryCount");

    // Check if there's a persistent active automation user (survives page reloads)
    const activeAutoUser = await new Promise((resolve) => {
      chrome.storage.local.get(["activeAutomationUser"], (d) => resolve(d.activeAutomationUser || null));
    });
    const isRelogin = sessionStorage.getItem(RELOGIN_FLAG) === "true";

    if (activeAutoUser || isRelogin) {
      sessionStorage.removeItem(RELOGIN_FLAG);
      const targetUser = activeAutoUser;
      log(`Auto-starting login (activeUser: ${targetUser || "relogin"})...`);
      trackEvent(EVENT_TYPES.LOGIN, `Auto-login triggered${isRelogin ? " (re-login after session refresh)" : ""} for ${targetUser || "unknown"}`, targetUser || "");

      // Load the active user's credentials directly — skip settings panel to avoid race conditions
      if (targetUser) {
        await new Promise((resolve) => {
          chrome.storage.local.get(["userProfilesList"], (data) => {
            const profiles = data.userProfilesList || [];
            const profile = profiles.find((p) => p.username === targetUser);
            if (profile) {
              chrome.storage.local.set({
                loginDetails: { username: profile.username, password: profile.password },
                securityQuestions: profile.securityQuestions || {},
                "is_auto-login": profile.autoLogin !== false,
                "is_auto-dashboard": profile.autoDashboard !== false,
                "is_sel-1st-slot": profile.autoSelect !== false,
                "is_auto-submit": profile.autoSubmit === true,
                captchaMode: profile.captchaMode || "manual",
              }, resolve);
            } else {
              resolve();
            }
          });
        });
      }

      await sleep(1500);
      const settings = await getSettings();
      if (settings.loginDetails?.username && settings.loginDetails?.password) {
        log(`Credentials loaded for: ${settings.loginDetails.username}`);
        trackEvent(EVENT_TYPES.LOGIN, "Auto-filling login form", settings.loginDetails.username);
        updateUserStatus(settings.loginDetails.username, "logging_in");
        runLogin(settings);
      } else {
        log("No credentials found for active user — falling back to settings panel");
        trackEvent(EVENT_TYPES.ERROR, "No credentials found for active user — showing settings panel", targetUser || "");
        injectSettingsPanel();
      }
    } else {
      injectSettingsPanel();
    }
  }

  // ─── DASHBOARD ──────────────────────────────────────────────────────

  async function handleDashboard(settings) {
    const activeUser = settings.loginDetails?.username || "";
    trackEvent(EVENT_TYPES.DASHBOARD, "Reached dashboard", activeUser);
    updateUserStatus(activeUser, "on_dashboard");

    // Check if automation is still active (persistent flag survives page reloads)
    const autoUser = await new Promise((r) => {
      chrome.storage.local.get(["activeAutomationUser"], (d) => r(d.activeAutomationUser || null));
    });
    const savedState = getReloginState();

    if (savedState && savedState.active) {
      log("Re-login complete — auto-navigating from dashboard...");
      trackEvent(EVENT_TYPES.SESSION, "Re-login complete — navigating from dashboard to booking page", activeUser);
    } else if (!autoUser && !settings["is_auto-dashboard"]) {
      log("No active automation and auto-dashboard disabled — stopping");
      trackEvent(EVENT_TYPES.DASHBOARD, "No active automation — auto-dashboard disabled, stopping", activeUser);
      return;
    }

    const warning = document.querySelector(".alert-warning.warning");
    if (warning) {
      const text = warning.textContent.trim().toLowerCase();
      if (text.includes("exceeded") || text.includes("maximum")) {
        log("Rate limited: " + text);
        trackEvent(EVENT_TYPES.ERROR, "Rate limit warning on dashboard", activeUser);
        updateUserStatus(activeUser, "rate_limited");
        sendTelegramNotification("rate", `🔴 <b>RATE LIMITED</b>\n\n👤 <b>User:</b> ${activeUser}\n⚠️ Dashboard shows: "${text}"\n\nAutomation paused.`);
        return;
      }
    }

    let attempts = 0;
    const waitForBtn = setInterval(() => {
      if (__abortAll) { clearInterval(waitForBtn); log("Dashboard aborted"); return; }
      attempts++;
      const rescheduleBtn = document.getElementById("reschedule_appointment");
      const continueBtn = document.getElementById("continue_application");

      if (rescheduleBtn) {
        clearInterval(waitForBtn);
        log("Found Reschedule Appointment — clicking...");
        trackEvent(EVENT_TYPES.DASHBOARD, "Clicking Reschedule Appointment", activeUser);
        setTimeout(() => rescheduleBtn.click(), DASHBOARD_CLICK_DELAY);
        return;
      }
      if (continueBtn) {
        clearInterval(waitForBtn);
        log("Found Continue Application — clicking...");
        trackEvent(EVENT_TYPES.DASHBOARD, "Clicking Continue Application", activeUser);
        setTimeout(() => continueBtn.click(), DASHBOARD_CLICK_DELAY);
        return;
      }

      // Look for any link/button that navigates to ofc-schedule or schedule page
      const allLinks = document.querySelectorAll('a[href*="ofc-schedule"], a[href*="/schedule"], a[href*="appointment"]');
      if (allLinks.length > 0) {
        clearInterval(waitForBtn);
        log("Found schedule link — clicking: " + allLinks[0].href);
        trackEvent(EVENT_TYPES.DASHBOARD, "Clicking schedule link: " + allLinks[0].textContent.trim(), activeUser);
        setTimeout(() => allLinks[0].click(), DASHBOARD_CLICK_DELAY);
        return;
      }

      // Look for any submit/continue button by text content
      const allBtns = document.querySelectorAll('button, input[type="submit"], a.btn, .btn');
      for (const btn of allBtns) {
        const txt = (btn.textContent || btn.value || "").trim().toLowerCase();
        if (txt.includes("continue") || txt.includes("schedule") || txt.includes("reschedule") || txt.includes("proceed")) {
          clearInterval(waitForBtn);
          log("Found button by text — clicking: " + txt);
          trackEvent(EVENT_TYPES.DASHBOARD, "Clicking button: " + txt, activeUser);
          setTimeout(() => { clickSafe(btn); }, DASHBOARD_CLICK_DELAY);
          return;
        }
      }

      // Log every 10 seconds while waiting
      if (attempts % 10 === 0) {
        log(`Still waiting for schedule/reschedule button (${attempts}s)...`);
      }
    }, 1000);

    // Keep scanning indefinitely while automation is active — no timeout
  }

  // ─── BOOKING PANEL UI ──────────────────────────────────────────────

  let cycling = { active: false, timer: null, round: 0, keepAliveTimer: null, lastRefresh: 0, backoffMs: 0 };
  const SESSION_REFRESH_MS = 8 * 60 * 1000; // 8 minutes

  function injectBookingPanel() {
    if (document.getElementById("ab-panel")) return;

    const mainContainer = document.getElementById("main_container");
    if (!mainContainer) return;

    const select = document.getElementById("post_select");
    if (!select) return;

    const locations = Array.from(select.options)
      .filter((opt) => opt.value && opt.value !== "")
      .map((opt) => ({
        value: opt.value,
        text: (opt.text || opt.innerText || "").trim(),
      }));

    if (locations.length === 0) return;

    const checkboxesHTML = locations
      .map(
        (loc) => `
      <label style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;cursor:pointer;font-size:13px;">
        <input type="checkbox" class="ab-loc-cb" value="${loc.value}" data-name="${loc.text}" checked
               style="width:15px;height:15px;cursor:pointer;">
        ${loc.text}
      </label>`
      )
      .join("");

    const isOFC = window.location.pathname.toLowerCase().includes("/ofc-schedule");
    const pageLabel = isOFC ? "OFC" : "Interview";

    const panel = document.createElement("div");
    panel.id = "ab-panel";
    panel.style.cssText =
      "margin:10px auto 15px;max-width:1000px;box-shadow:0 2px 8px rgba(0,0,0,0.15);border-radius:8px;font-family:inherit;";
    panel.innerHTML = `
      <div style="background:#1a5276;color:white;padding:10px 15px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;">
        <strong>Auto-Booking Controls (${pageLabel})</strong>
        <span id="ab-status" style="font-size:13px;color:#aed6f1;"></span>
      </div>
      <div style="background:white;padding:15px;border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;">
        <div style="display:flex;flex-wrap:wrap;gap:15px;align-items:center;margin-bottom:12px;">
          <label style="font-weight:600;font-size:13px;">Start Date:
            <input type="date" id="ab-start-date" style="margin-left:4px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;">
          </label>
          <label style="font-weight:600;font-size:13px;">End Date:
            <input type="date" id="ab-end-date" style="margin-left:4px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;">
          </label>
          <label style="font-weight:600;font-size:13px;">Cycle Interval (sec):
            <input type="number" id="ab-interval" value="30" min="10" max="300"
                   style="width:65px;margin-left:4px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;">
          </label>
        </div>
        <div style="margin-bottom:12px;">
          <strong style="font-size:13px;">Locations: </strong>
          ${checkboxesHTML}
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <button id="ab-start-btn"
                  style="background:#27ae60;color:white;border:none;padding:8px 28px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:14px;">
            START
          </button>
          <button id="ab-stop-btn" disabled
                  style="background:#c0392b;color:white;border:none;padding:8px 28px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:14px;opacity:0.5;">
            STOP
          </button>
          <button id="ab-logout-btn"
                  style="background:#e65100;color:white;border:none;padding:8px 28px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:14px;">
            LOGOUT
          </button>
          <span id="ab-cycle-info" style="font-size:12px;color:#888;margin-left:10px;"></span>
        </div>
      </div>`;

    mainContainer.parentNode.insertBefore(panel, mainContainer);

    // Auto-populate from active user's profile
    chrome.storage.local.get(
      ["loginDetails", "userProfilesList"],
      (data) => {
        const activeUser = data.loginDetails?.username;
        const profiles = data.userProfilesList || [];
        const profile = activeUser ? profiles.find((p) => p.username === activeUser) : null;

        if (profile) {
          const sd = document.getElementById("ab-start-date");
          const ed = document.getElementById("ab-end-date");
          if (sd && profile.startDate) sd.value = profile.startDate;
          if (ed && profile.endDate) ed.value = profile.endDate;

          if (profile.locations && profile.locations.length > 0) {
            document.querySelectorAll(".ab-loc-cb").forEach((cb) => {
              cb.checked = profile.locations.some(
                (loc) => cb.dataset.name.toLowerCase().includes(loc.toLowerCase())
              );
            });
          }
          log("Booking panel auto-populated from profile: " + (profile.name || activeUser));
        }
      }
    );

    document
      .getElementById("ab-start-btn")
      .addEventListener("click", () => {
        log("START button clicked");
        startCycling();
      });
    document
      .getElementById("ab-stop-btn")
      .addEventListener("click", () => {
        log("STOP button clicked");
        stopCycling("Stopped by user");
        chrome.storage.local.remove("activeAutomationUser");
      });

    document
      .getElementById("ab-logout-btn")
      .addEventListener("click", () => {
        log("LOGOUT button clicked on OFC page");
        if (cycling.active) stopCycling("Logged out from OFC page");
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.SESSION, `Logout from OFC page — clearing session for ${u}`, u);
          sendTelegramNotification("logout", `🚪 <b>LOGGED OUT</b>\n\n👤 <b>User:</b> ${u}\n🔒 Session cleared from OFC page\n✅ Ready for next user`);
          __abortAll = true;
          window.__autoBookingLoginActive = false;
          if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
          sessionStorage.clear();
          chrome.storage.local.remove(["activeAutomationUser", "loginDetails", "securityQuestions"]);
          updateUserStatus(u, "idle");
          const signOutLink = document.querySelector('a[href*="LogOff"], a[href*="sign-out"], a[href*="signout"], a[href*="logout"], a[aria-label="Sign out"]');
          if (signOutLink) {
            signOutLink.click();
          } else {
            window.location.href = window.location.origin + "/en-US/";
          }
        });
      });

    log("Booking panel injected");
  }

  function setStatus(msg) {
    const el = document.getElementById("ab-status");
    if (el) el.textContent = msg;
    log(msg);
  }

  function setCycleInfo(msg) {
    const el = document.getElementById("ab-cycle-info");
    if (el) el.textContent = msg;
  }

  // ─── SESSION KEEP-ALIVE & 401 RECOVERY ─────────────────────────────

  // Listen for 401 events dispatched by XHR/fetch on the page
  // page.js (MAIN world) fires vSCP events — we also listen for a custom 401 signal
  let __session401Detected = false;
  let __rateLimited429 = false;

  function randomDelay(minSec, maxSec) {
    const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
    return sleep(ms);
  }

  // Detect 401/429 responses from the page's XHR/fetch calls.
  // Uses a minimal MAIN-world script that signals via DOM attribute (no XHR/fetch re-wrapping).
  // page.js already wraps XHR — this hooks into the existing wrappers' load events
  // by using a PerformanceObserver for failed network requests instead.
  function inject401Detector() {
    if (document.getElementById("__ab401marker")) return;
    const marker = document.createElement("div");
    marker.id = "__ab401marker";
    marker.style.display = "none";
    document.documentElement.appendChild(marker);

    const script = document.createElement("script");
    script.textContent = `
      (function() {
        var marker = document.getElementById("__ab401marker");
        if (!marker) return;

        // Patch XHR.send to add a load listener for 401/429 status detection.
        // page.js already wraps open/send for schedule data — we chain onto send only.
        var currentSend = XMLHttpRequest.prototype.send;
        if (!XMLHttpRequest.prototype._ab401Patched) {
          XMLHttpRequest.prototype._ab401Patched = true;
          XMLHttpRequest.prototype.send = function() {
            this.addEventListener("load", function() {
              if (this.status === 401) marker.setAttribute("data-401", Date.now());
              else if (this.status === 429) marker.setAttribute("data-429", Date.now());
            });
            return currentSend.apply(this, arguments);
          };
        }

        // Also detect 401/429 from fetch calls (site may use fetch for some APIs)
        if (!window._abFetch401Patched) {
          window._abFetch401Patched = true;
          var origFetch = window.fetch;
          window.fetch = function() {
            return origFetch.apply(this, arguments).then(function(resp) {
              if (resp.status === 401) marker.setAttribute("data-401", Date.now());
              else if (resp.status === 429) marker.setAttribute("data-429", Date.now());
              return resp;
            });
          };
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === "data-401") {
          log("401 detected via DOM bridge");
          __session401Detected = true;
          chrome.storage.local.get(["loginDetails"], (d) => {
            trackEvent(EVENT_TYPES.ERROR, "401 session expired", d.loginDetails?.username || "");
            updateUserStatus(d.loginDetails?.username || "", "session_expired");
          });
        }
        if (m.attributeName === "data-429") {
          log("429 rate limit detected via DOM bridge");
          __rateLimited429 = true;
          chrome.storage.local.get(["loginDetails"], (d) => {
            trackEvent(EVENT_TYPES.ERROR, "429 rate limited", d.loginDetails?.username || "");
            updateUserStatus(d.loginDetails?.username || "", "rate_limited");
          });
        }
      }
    });
    observer.observe(marker, { attributes: true });
  }

  function isCloudflareBlocked() {
    // Use textContent (no layout reflow) instead of innerText (forces reflow)
    const body = document.body?.textContent || "";
    if (body.includes("Error 1015") || body.includes("rate limited")) return true;
    if (body.includes("cloudflare") && body.includes("429")) return true;
    return false;
  }

  function isSessionExpired() {
    if (__session401Detected) return true;
    if (document.querySelector(".error-page, .session-expired")) return true;
    const title = document.title || "";
    if (title.includes("401") || title.includes("Unauthorized") || title.includes("Error")) return true;
    // Check visible error containers — targeted selectors, no full-page text scan
    const errorEl = document.querySelector("h1, h2, .alert-danger, .error-message, .error-content, #error-page");
    if (errorEl) {
      const text = errorEl.textContent || "";
      if (text.includes("401") || text.includes("Unauthorized") || text.includes("session expired")) return true;
    }
    return false;
  }

  function startKeepAlive() {
    stopKeepAlive();
    cycling.lastRefresh = Date.now();
    cycling.keepAliveTimer = setInterval(() => {
      if (!cycling.active) return;
      const elapsed = Date.now() - cycling.lastRefresh;
      if (elapsed >= SESSION_REFRESH_MS) {
        log("Session keep-alive: refreshing page to prevent 401...");
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.SESSION, "Keep-alive refresh — preventing session expiry", u);
        });
        saveReloginState();
        window.location.reload();
      }
    }, 30000); // check every 30s
  }

  function stopKeepAlive() {
    if (cycling.keepAliveTimer) {
      clearInterval(cycling.keepAliveTimer);
      cycling.keepAliveTimer = null;
    }
  }

  function saveReloginState() {
    const state = {
      active: cycling.active,
      round: cycling.round,
      startDate: document.getElementById("ab-start-date")?.value || "",
      endDate: document.getElementById("ab-end-date")?.value || "",
      interval: document.getElementById("ab-interval")?.value || "30",
      locations: Array.from(document.querySelectorAll(".ab-loc-cb:checked")).map(
        (cb) => cb.value
      ),
      timestamp: Date.now(),
    };
    sessionStorage.setItem("ab-cycling-state", JSON.stringify(state));
  }

  function getReloginState() {
    try {
      const raw = sessionStorage.getItem("ab-cycling-state");
      if (!raw) return null;
      const state = JSON.parse(raw);
      // Only valid if saved within last 5 minutes
      if (Date.now() - state.timestamp > 5 * 60 * 1000) {
        sessionStorage.removeItem("ab-cycling-state");
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }

  function clearReloginState() {
    sessionStorage.removeItem("ab-cycling-state");
  }

  async function handle401Recovery() {
    if (!cycling.active) return;
    log("401/session expired detected — initiating re-login...");
    __session401Detected = false;
    chrome.storage.local.get(["loginDetails"], (d) => {
      const u = d.loginDetails?.username || "";
      trackEvent(EVENT_TYPES.SESSION, `Session expired (401) — auto re-login starting. Round was: ${cycling.round}`, u);
      sendTelegramNotification("error", `⚠️ <b>SESSION EXPIRED</b>\n\n👤 <b>User:</b> ${u}\n🔄 Auto re-login in progress...\n🔁 <b>Round was:</b> ${cycling.round}`);
    });
    stopCycling("Session expired — re-logging in...");
    saveReloginState();
    sessionStorage.setItem(RELOGIN_FLAG, "true");
    window.location.href = window.location.origin;
  }

  // ─── CYCLING LOGIC ─────────────────────────────────────────────────

  function startCycling() {
    log("startCycling() called");
    const checked = document.querySelectorAll(".ab-loc-cb:checked");
    if (checked.length === 0) {
      setStatus("Select at least one location");
      return;
    }

    __abortAll = false;
    chrome.storage.local.remove("__stopSignal");
    // Ensure activeAutomationUser is set when starting from OFC panel
    chrome.storage.local.get(["loginDetails", "activeAutomationUser"], (d) => {
      if (d.loginDetails?.username && !d.activeAutomationUser) {
        chrome.storage.local.set({ activeAutomationUser: d.loginDetails.username });
      }
    });
    cycling.active = true;
    cycling.round = 0;
    const locs = Array.from(checked).map((cb) => cb.dataset.name || cb.value).join(", ");
    const startDate = document.getElementById("ab-start-date")?.value || "—";
    const endDate = document.getElementById("ab-end-date")?.value || "—";
    chrome.storage.local.get(["loginDetails"], (d) => {
      const u = d.loginDetails?.username || "";
      trackEvent(EVENT_TYPES.CYCLING, `Cycling started — locations: ${locs}`, u);
      updateUserStatus(u, "cycling", { locations: locs, startedAt: new Date().toISOString() });
      sendTelegramNotification("cycling", `🔄 <b>CYCLING STARTED</b>\n\n👤 <b>User:</b> ${u}\n📍 <b>Locations:</b> ${locs}\n📅 <b>Date Range:</b> ${startDate} → ${endDate}`);
    });

    const startBtn = document.getElementById("ab-start-btn");
    const stopBtn = document.getElementById("ab-stop-btn");
    startBtn.disabled = true;
    startBtn.style.opacity = "0.5";
    stopBtn.disabled = false;
    stopBtn.style.opacity = "1";

    // Save dates back to active user's profile
    chrome.storage.local.get(["loginDetails", "userProfilesList"], (data) => {
      const activeUser = data.loginDetails?.username;
      const profiles = data.userProfilesList || [];
      const idx = profiles.findIndex((p) => p.username === activeUser);
      if (idx >= 0) {
        profiles[idx].startDate = document.getElementById("ab-start-date")?.value || "";
        profiles[idx].endDate = document.getElementById("ab-end-date")?.value || "";
        chrome.storage.local.set({ userProfilesList: profiles });
      }
    });

    startKeepAlive();
    setStatus("Starting...");
    runCycleLoop();
  }

  function stopCycling(reason) {
    const roundsCompleted = cycling.round;
    cycling.active = false;
    if (cycling.timer) {
      clearTimeout(cycling.timer);
      cycling.timer = null;
    }
    stopKeepAlive();

    const startBtn = document.getElementById("ab-start-btn");
    const stopBtn = document.getElementById("ab-stop-btn");
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.style.opacity = "1";
    }
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.style.opacity = "0.5";
    }

    setStatus(reason || "Stopped");
    log("stopCycling: " + (reason || "Stopped"));
    chrome.storage.local.get(["loginDetails", "activeAutomationUser"], (d) => {
      const u = d.loginDetails?.username || d.activeAutomationUser || "";
      trackEvent(EVENT_TYPES.CYCLING, `Cycling stopped: ${reason || "Stopped"}`, u);

      const lowerReason = (reason || "").toLowerCase();
      if (lowerReason.includes("slot found") && !lowerReason.includes("submitted")) {
        updateUserStatus(u, "slot_found", { foundAt: new Date().toISOString() });
      } else if (lowerReason.includes("submitted")) {
        updateUserStatus(u, "confirmed", { confirmedAt: new Date().toISOString() });
      } else {
        updateUserStatus(u, "idle");
        if (!lowerReason.includes("re-logging") && !lowerReason.includes("session expired")) {
          sendTelegramNotification("stopped", `⏹ <b>CYCLING STOPPED</b>\n\n👤 <b>User:</b> ${u}\n📝 <b>Reason:</b> ${reason || "Manual stop"}\n🔁 <b>Rounds completed:</b> ${roundsCompleted}`);
        }
      }
    });
  }

  function waitForScheduleData(timeout = 15000) {
    return new Promise((resolve) => {
      let done = false;

      function handler(e) {
        if (e.detail && e.detail.resource === "vSD") {
          done = true;
          removeEventListener("vSCP", handler);
          resolve(e.detail.data);
        }
      }

      addEventListener("vSCP", handler);

      setTimeout(() => {
        if (!done) {
          removeEventListener("vSCP", handler);
          resolve(null);
        }
      }, timeout);
    });
  }

  function isDateInRange(dateStr, startStr, endStr) {
    if (!startStr && !endStr) return true;
    const d = new Date(dateStr + "T00:00:00");
    if (startStr && d < new Date(startStr + "T00:00:00")) return false;
    if (endStr && d > new Date(endStr + "T00:00:00")) return false;
    return true;
  }

  async function selectDateInCalendar(dateObj) {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const day = dateObj.getDate();

    const yearSel = document.querySelector(".ui-datepicker-year");
    const monthSel = document.querySelector(".ui-datepicker-month");

    if (yearSel) {
      yearSel.value = year.toString();
      yearSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(300);
    if (monthSel) {
      monthSel.value = month.toString();
      monthSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(500);

    const dateLink = document.querySelector(
      `.ui-datepicker-calendar a[data-date="${day}"]`
    );
    if (dateLink) {
      dateLink.click();
      log(`Selected date: ${year}-${month + 1}-${day}`);
      return true;
    }
    return false;
  }

  async function waitForTimeSlotAndSelect(timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const radio = document.querySelector(
        '#time_select input[type="radio"]'
      );
      if (radio) {
        if (!radio.checked) radio.click();
        await sleep(800);

        const submitBtn = document.getElementById("submitbtn");
        if (submitBtn && !submitBtn.disabled) {
          return true;
        }
      }
      await sleep(500);
    }
    return false;
  }

  async function checkStopSignal() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["__stopSignal", "loginDetails"], (d) => {
        if (d.__stopSignal) {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.QUEUE, "Stop signal detected from storage — halting automation", u);
          __abortAll = true;
          chrome.storage.local.remove("__stopSignal");
          if (cycling.active) stopCycling("Stopped from dashboard");
          if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  async function runCycleLoop() {
    if (!cycling.active || __abortAll) return;
    if (await checkStopSignal()) return;

    cycling.round++;
    cycling.lastRefresh = Date.now(); // reset keep-alive timer on each round
    const startDate = document.getElementById("ab-start-date")?.value || "";
    const endDate = document.getElementById("ab-end-date")?.value || "";
    const interval =
      parseInt(document.getElementById("ab-interval")?.value || "30") * 1000;

    const checked = document.querySelectorAll(".ab-loc-cb:checked");
    const locations = Array.from(checked).map((cb) => ({
      value: cb.value,
      name: cb.dataset.name,
    }));

    setCycleInfo(`Round ${cycling.round}`);

    for (let i = 0; i < locations.length; i++) {
      if (!cycling.active) return;

      // Check stop signal from dashboard between each location
      if (await checkStopSignal()) return;

      // Random delay between locations (3-6 sec) to avoid rate limiting
      if (i > 0) {
        const delaySec = 3 + Math.random() * 3;
        setStatus(`Waiting ${delaySec.toFixed(0)}s before next location...`);
        await sleep(delaySec * 1000);
        if (!cycling.active || await checkStopSignal()) return;
      }

      // Check for 429 rate limit — exponential backoff
      if (__rateLimited429) {
        __rateLimited429 = false;
        cycling.backoffMs = cycling.backoffMs ? Math.min(cycling.backoffMs * 2, 300000) : 60000;
        const waitSec = Math.round(cycling.backoffMs / 1000);
        setStatus(`Rate limited (429)! Pausing ${waitSec}s...`);
        log(`Backoff: waiting ${waitSec}s before resuming`);
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.ERROR, `429 rate limited — backoff ${waitSec}s (round ${cycling.round})`, u);
        });
        await sleep(cycling.backoffMs);
        if (!cycling.active) return;
        // After backoff, re-check
        if (__rateLimited429) { continue; }
      }

      const loc = locations[i];
      setStatus(`Checking ${loc.name} (${i + 1}/${locations.length})...`);

      const select = document.getElementById("post_select");
      if (!select) {
        stopCycling("Location dropdown not found");
        return;
      }

      // Set up listener BEFORE changing dropdown
      const dataPromise = waitForScheduleData(15000);

      if (select.value !== loc.value) {
        select.value = loc.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const data = await dataPromise;

      // Check for 429 after data fetch
      if (__rateLimited429) {
        __rateLimited429 = false;
        cycling.backoffMs = cycling.backoffMs ? Math.min(cycling.backoffMs * 2, 300000) : 60000;
        const waitSec = Math.round(cycling.backoffMs / 1000);
        setStatus(`Rate limited (429)! Pausing ${waitSec}s...`);
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.ERROR, `429 rate limited after fetch — backoff ${waitSec}s at ${loc.name}`, u);
        });
        await sleep(cycling.backoffMs);
        if (!cycling.active) return;
        continue; // retry this round
      }

      // Reset backoff on successful request
      cycling.backoffMs = 0;

      // Check for 401 / session expiry
      if (isSessionExpired()) {
        await handle401Recovery();
        return;
      }

      if (!data || !data.ScheduleDays || data.ScheduleDays.length === 0) {
        setStatus(`No slots at ${loc.name}`);
        await sleep(2000);
        if (isSessionExpired()) { await handle401Recovery(); return; }
        continue;
      }

      // Filter dates within user's preferred range
      const inRange = data.ScheduleDays.filter((d) =>
        isDateInRange(d.Date, startDate, endDate)
      ).sort((a, b) => new Date(a.Date) - new Date(b.Date));

      if (inRange.length === 0) {
        setStatus(
          `${loc.name}: ${data.ScheduleDays.length} dates found but none in range`
        );
        await sleep(2000);
        continue;
      }

      // Dates in range found!
      setStatus(
        `${loc.name}: ${inRange.length} dates in range! Selecting ${inRange[0].Date}...`
      );

      // Let content.js finish processing (it auto-selects first date)
      await sleep(2000);

      // Select the first in-range date explicitly
      const targetDate = new Date(inRange[0].Date + "T00:00:00");
      const selected = await selectDateInCalendar(targetDate);

      if (!selected) {
        setStatus(`Could not click date at ${loc.name}`);
        await sleep(2000);
        continue;
      }

      // Wait for time slots to load
      await sleep(1500);
      const slotReady = await waitForTimeSlotAndSelect(12000);

      if (slotReady) {
        const settings = await getSettings();
        const u = settings.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.SLOT_FOUND, `Slot found at ${loc.name} — date: ${inRange[0].Date}`, u, { location: loc.name, date: inRange[0].Date });
        sendTelegramNotification("slot", `🟢 <b>SLOT FOUND!</b>\n\n👤 <b>User:</b> ${u}\n📍 <b>Location:</b> ${loc.name}\n📅 <b>Date:</b> ${inRange[0].Date}\n\n${settings["is_auto-submit"] ? "⏳ Auto-submitting..." : "⚠️ Manual submit needed — go to the tab NOW!"}`);
        if (settings["is_auto-submit"]) {
          setStatus(`${loc.name}: Slot found — auto-submitting!`);
          await sleep(1000);
          const submitBtn = document.getElementById("submitbtn");
          if (submitBtn && !submitBtn.disabled) submitBtn.click();
          trackEvent(EVENT_TYPES.BOOKING, `Auto-submitted booking at ${loc.name}`, u);
          sendTelegramNotification("confirmed", `✅ <b>BOOKING SUBMITTED!</b>\n\n👤 <b>User:</b> ${u}\n📍 <b>Location:</b> ${loc.name}\n📅 <b>Date:</b> ${inRange[0].Date}\n\n🎉 Check the confirmation page!`);
          stopCycling("Booking submitted!");
          return;
        }
        stopCycling(`${loc.name}: Slot found! Review and click Submit.`);
        return;
      }

      setStatus(`${loc.name}: Date selected but no time slots appeared`);
      await sleep(2000);
    }

    // All locations checked — wait and repeat
    if (!cycling.active) return;
    const sec = Math.round(interval / 1000);
    setStatus(`All locations checked. Next round in ${sec}s...`);
    cycling.timer = setTimeout(() => runCycleLoop(), interval);
  }

  // ─── AUTO-SUBMIT OBSERVER (standalone, without cycling) ────────────

  function setupAutoSubmit() {
    log("Auto-submit observer active");

    // Narrow observation to #time_select or #page_form instead of entire body
    const targetNode = document.getElementById("time_select")
      || document.getElementById("page_form")
      || document.getElementById("main_container");
    if (!targetNode) {
      log("Auto-submit: no target container found, falling back to polling");
      const pollId = setInterval(() => {
        if (cycling.active) return;
        const submitBtn = document.getElementById("submitbtn");
        if (submitBtn && !submitBtn.disabled) {
          const selectedRadio = document.querySelector('#time_select input[type="radio"]:checked');
          if (selectedRadio) {
            log("Time slot selected + submit ready — clicking submit!");
            clearInterval(pollId);
            setTimeout(() => submitBtn.click(), 1500);
          }
        }
      }, 2000);
      setTimeout(() => clearInterval(pollId), 300000);
      return;
    }

    const observer = new MutationObserver(() => {
      if (cycling.active) return;

      const submitBtn = document.getElementById("submitbtn");
      if (submitBtn && !submitBtn.disabled) {
        const selectedRadio = document.querySelector(
          '#time_select input[type="radio"]:checked'
        );
        if (selectedRadio) {
          log("Time slot selected + submit ready — clicking submit!");
          observer.disconnect();
          setTimeout(() => submitBtn.click(), 1500);
        }
      }
    });

    observer.observe(targetNode, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 300000);
  }

  // ─── BOOKING PAGE HANDLER ──────────────────────────────────────────

  async function handleBookingPage(settings) {
    // Check for error state: "No Class Selected" or empty post_select means page errored
    await sleep(1000);
    const postSelect = document.getElementById("post_select");
    const groupMembers = document.querySelector(".applicant-table, .group-members, #applicant_table");
    const noClassEl = document.body?.textContent?.includes("No Class Selected");

    if (noClassEl || (postSelect && postSelect.options.length <= 1 && !postSelect.value)) {
      const autoUser = await new Promise((r) => {
        chrome.storage.local.get(["activeAutomationUser"], (d) => r(d.activeAutomationUser || null));
      });
      if (autoUser) {
        const activeUser = settings.loginDetails?.username || "";
        const errorCount = parseInt(sessionStorage.getItem("__abOFCErrorCount") || "0") + 1;
        sessionStorage.setItem("__abOFCErrorCount", String(errorCount));

        if (errorCount >= 3) {
          log("Booking page error 3 times — stopping automation");
          trackEvent(EVENT_TYPES.ERROR, "Booking page failed 3 times — stopped. May need manual intervention.", activeUser);
          updateUserStatus(activeUser, "error");
          sendTelegramNotification("error", `🔴 <b>AUTOMATION STOPPED</b>\n\n👤 <b>User:</b> ${activeUser}\n❌ Booking page error 3 times\n\nNeeds manual intervention.`);
          sessionStorage.removeItem("__abOFCErrorCount");
          chrome.storage.local.remove("activeAutomationUser");
          return;
        }

        log(`Booking page error (${errorCount}/3) — going back to dashboard...`);
        trackEvent(EVENT_TYPES.ERROR, `Booking page error — No Class Selected (attempt ${errorCount}/3)`, activeUser);
        await sleep(3000);
        window.location.href = window.location.origin + "/en-US/";
        return;
      }
    }

    // Page loaded successfully — clear error counter
    sessionStorage.removeItem("__abOFCErrorCount");

    let attempts = 0;
    while (!document.getElementById("post_select") && attempts < 20) {
      await sleep(500);
      attempts++;
    }

    injectBookingPanel();

    // Restore cycling state after keep-alive refresh
    const savedState = getReloginState();
    if (savedState && savedState.active) {
      log("Restoring cycling after page refresh...");
      trackEvent(EVENT_TYPES.SESSION, `Restoring cycling after page refresh — resuming from round ${savedState.round}`, activeUser);
      clearReloginState();
      await sleep(1000);

      // Restore form values
      const sd = document.getElementById("ab-start-date");
      const ed = document.getElementById("ab-end-date");
      const iv = document.getElementById("ab-interval");
      if (sd) sd.value = savedState.startDate;
      if (ed) ed.value = savedState.endDate;
      if (iv) iv.value = savedState.interval;

      // Restore location checkboxes
      if (savedState.locations?.length > 0) {
        document.querySelectorAll(".ab-loc-cb").forEach((cb) => {
          cb.checked = savedState.locations.includes(cb.value);
        });
      }

      cycling.round = savedState.round;
      startCycling();
      return;
    }

    // Auto-start cycling if launched from dashboard
    const autoUser = await new Promise((r) => {
      chrome.storage.local.get(["activeAutomationUser"], (d) => r(d.activeAutomationUser || null));
    });
    if (autoUser && !cycling.active) {
      log("Active automation user detected — auto-starting cycling...");
      const activeUser = settings.loginDetails?.username || "";
      trackEvent(EVENT_TYPES.CYCLING, "Auto-starting cycling from dashboard", activeUser);
      await sleep(1000);
      startCycling();
      return;
    }

    if (settings["is_auto-submit"] && !cycling.active) {
      setupAutoSubmit();
    }
  }

  // ─── MAIN ROUTER ───────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    const path = window.location.pathname.toLowerCase();
    const host = window.location.hostname.toLowerCase();

    // Check persistent automation state — if stopped from dashboard, don't do anything
    const activeAutoUser = await new Promise((resolve) => {
      chrome.storage.local.get(["activeAutomationUser"], (d) => resolve(d.activeAutomationUser || null));
    });
    const hasReloginFlag = sessionStorage.getItem(RELOGIN_FLAG) === "true";
    const automationActive = !!activeAutoUser || hasReloginFlag;

    // Inject 401 detector on scheduling pages (MAIN world XHR intercept)
    if (host.includes("usvisascheduling.com")) {
      inject401Detector();

      // Listen for auto-dismissed alerts (from alert-override.js MAIN world script)
      document.addEventListener("__abAlertDismissed", (e) => {
        log("Alert auto-dismissed: " + e.detail);
        const activeUser = settings.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.ERROR, "Alert dismissed: " + e.detail, activeUser);
      });
    }

    if (host.includes("b2clogin.com")) {
      sessionStorage.removeItem("__ab401RetryCount");
      log("On b2clogin.com — detecting page type...");
      await handleLoginPage();
      return;
    }

    // Cloudflare block detection on page load
    if (host.includes("usvisascheduling.com") && isCloudflareBlocked()) {
      const cfUser = settings.loginDetails?.username || activeAutoUser || "";
      log("Cloudflare block detected on page load");
      trackEvent(EVENT_TYPES.ERROR, "Cloudflare block detected (Error 1015 / 429) on page load", cfUser);
      sendTelegramNotification("error", `🛡️ <b>CLOUDFLARE BLOCKED</b>\n\n👤 <b>User:</b> ${cfUser}\n⚠️ Rate limited by Cloudflare on page load\n💡 Wait a few minutes before retrying`);
      return;
    }

    // Waiting room detection — only auto-refresh if automation is active
    if (host.includes("usvisascheduling.com")) {
      for (let wc = 0; wc < 6; wc++) {
        const bodyText = (document.body?.textContent || "").toLowerCase();
        const hasWaitingRoomClass = !!document.querySelector('[class*="waitingroom"], [class*="waiting-room"], [id*="waitingroom"], [id*="waiting-room"]');
        if (bodyText.includes("waiting room") || bodyText.includes("will be redirected") ||
            bodyText.includes("website maintenance") || hasWaitingRoomClass) {
          if (!automationActive) {
            log("Waiting room detected but automation is stopped — not refreshing");
            return;
          }
          const attempt = parseInt(sessionStorage.getItem("__abWaitingRoomCount") || "0") + 1;
          sessionStorage.setItem("__abWaitingRoomCount", String(attempt));
          const activeUser = settings.loginDetails?.username || "";
          if (attempt > 30) {
            log("Waiting room — max retries (30) reached, stopping");
            trackEvent(EVENT_TYPES.ERROR, "Waiting room max retries reached", activeUser);
            sessionStorage.removeItem("__abWaitingRoomCount");
            sendTelegramNotification("error", `🔴 <b>WAITING ROOM TIMEOUT</b>\n\n👤 <b>User:</b> ${activeUser}\n⚠️ Site maintenance detected — 30 retries exhausted`);
            return;
          }
          trackEvent(EVENT_TYPES.SESSION, `Waiting room detected (attempt ${attempt})`, activeUser);
          log(`Waiting room detected (attempt ${attempt}) — refreshing in 10s...`);
          await sleep(10000);
          window.location.reload();
          return;
        }
        await sleep(500);
      }
      sessionStorage.removeItem("__abWaitingRoomCount");
    }

    const routerUser = settings.loginDetails?.username || activeAutoUser || "";

    if (path.includes("signin-aad-b2c") || path.includes("externallogin") || document.querySelector("h1")?.textContent?.trim() === "Page Not Found") {
      if (!automationActive) {
        log("Page Not Found but automation is stopped — not retrying");
        trackEvent(EVENT_TYPES.SESSION, "Page Not Found detected — automation not active, ignoring", routerUser);
        return;
      }
      const retryCount = parseInt(sessionStorage.getItem("__ab401RetryCount") || "0");
      if (retryCount < 10) {
        sessionStorage.setItem("__ab401RetryCount", String(retryCount + 1));
        log(`Page Not Found — retry ${retryCount + 1}/10, refreshing in 3s...`);
        trackEvent(EVENT_TYPES.SESSION, `Page Not Found — retry ${retryCount + 1}/10`, routerUser);
        await sleep(3000);
        window.location.href = window.location.origin + "/";
      } else {
        sessionStorage.removeItem("__ab401RetryCount");
        log("Page Not Found — max retries reached, stopping.");
        trackEvent(EVENT_TYPES.ERROR, "Page Not Found — max retries (10) reached, stopping", routerUser);
        sendTelegramNotification("error", `🔴 <b>PAGE NOT FOUND</b>\n\n👤 <b>User:</b> ${routerUser}\n⚠️ Max retries (10) exhausted — automation stopped`);
      }
      return;
    }

    if (/^\/[a-z]{2}-[a-z]{2}\/?$/i.test(path)) {
      log("On dashboard");
      await handleDashboard(settings);
      return;
    }

    if (path.includes("/ofc-schedule") || path.includes("/schedule")) {
      log("On booking page: " + path);
      await handleBookingPage(settings);
      return;
    }

    if (path.includes("appointment-confirmation")) {
      log("On confirmation page");
      trackEvent(EVENT_TYPES.BOOKING, "Reached appointment confirmation page", routerUser);
      sendTelegramNotification("confirmed", `✅ <b>BOOKING CONFIRMED</b>\n\n👤 <b>User:</b> ${routerUser}\n🎉 Appointment confirmation page reached!`);
      return;
    }
  }

  // Listen for messages from dashboard
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "stopAll") {
      log("STOP ALL command received from dashboard");
      chrome.storage.local.get(["loginDetails", "activeAutomationUser"], (d) => {
        const u = d.loginDetails?.username || d.activeAutomationUser || "";
        trackEvent(EVENT_TYPES.QUEUE, "Stop command received from dashboard", u);
      });
      __abortAll = true;
      window.__autoBookingLoginActive = false;
      if (cycling.active) stopCycling("Stopped from dashboard");
      if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
      chrome.storage.local.remove("activeAutomationUser");
      sendResponse({ ok: true });
    }
    if (msg.action === "startCycling") {
      log("START CYCLING command received from dashboard");
      chrome.storage.local.get(["loginDetails"], (d) => {
        const u = d.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.CYCLING, "Start cycling command received from dashboard", u);
      });
      __abortAll = false;
      chrome.storage.local.remove("__stopSignal");
      if (!cycling.active) {
        startCycling();
      }
      sendResponse({ ok: true });
    }
    if (msg.action === "logout") {
      log("LOGOUT command received — clearing session and redirecting to login...");
      chrome.storage.local.get(["loginDetails"], (d) => {
        const u = d.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.SESSION, `Logout command received — clearing session for ${u}`, u);
        sendTelegramNotification("logout", `🚪 <b>LOGGED OUT</b>\n\n👤 <b>User:</b> ${u}\n🔒 Session cleared from dashboard\n✅ Ready for next user`);
      });
      __abortAll = true;
      window.__autoBookingLoginActive = false;
      if (cycling.active) stopCycling("Logged out from dashboard");
      if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
      sessionStorage.clear();
      chrome.storage.local.remove(["activeAutomationUser", "loginDetails", "securityQuestions"]);
      if (window.location.hostname.includes("usvisascheduling.com")) {
        const signOutLink = document.querySelector('a[href*="LogOff"], a[href*="sign-out"], a[href*="signout"], a[href*="logout"], a[aria-label="Sign out"]');
        if (signOutLink) {
          signOutLink.click();
        } else {
          window.location.href = window.location.origin + "/en-US/";
        }
      }
      sendResponse({ ok: true });
    }
    return true;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
