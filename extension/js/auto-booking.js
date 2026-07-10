(function () {
  "use strict";

  const LOG_PREFIX = "[AutoBook]";
  // ─── TEST MODE ──────────────────────────────────────────────────
  // This is the TEST build (feature/parallel-booking worktree).
  // - Telegram messages prefixed [TEST]
  // - Auto-submit FORCED OFF during detection-stage testing (protect real client)
  // - Device name auto-prefixed TEST- so dashboard can filter test noise
  const TEST_MODE = false;
  const TEST_FORCE_NO_SUBMIT = false; // #40 LIVE: real submit enabled (was true = dry-run)
  // ─── PARALLEL SCAN config (A3) ──
  const USE_PARALLEL_SCAN = true;     // after template captured, replace sequential per-city loop
  const PARALLEL_STAGGER_MS = 300;    // ms between launching each city's request (gentle burst)
  const PARALLEL_ROUND_MS = 20000;    // wait between parallel rounds (tunable in A4)
  const PARALLEL_BATCH_SIZE = 2;      // cities scanned per round (rotating) — keeps 2 concurrent max (fast, no tarpit/429)
  const PARALLEL_FETCH_TIMEOUT_MS = 12000; // #46 abort a tarpitted request at 12s (don't wait ~60s)
  const SEQ_PROBE_BASE = 2;                // #46 after a tarpit, probe with this many sequential checks
  const SEQ_PROBE_MAX = 10;                // #46 cap the escalating probe size
  let __seqProbeChecks = 0;                // #46 sequential checks to do before re-trying parallel
  let __seqBackoff = 2;                    // #46 current probe size — escalates on repeat tarpits, resets on success
  const MAX_PARALLEL_STRIKES = 3;          // #46b after this many timeout rounds in a row, bench parallel
  const PARALLEL_BENCH_MS = 5 * 60 * 1000;  // #46b run pure-sequential this long before re-testing parallel
  let __parallelTimeoutStreak = 0;         // #46b consecutive parallel rounds that fully timed out
  let __parallelBenchUntil = 0;            // #46b skip parallel until this time (sustained-tarpit guard)
  let __parallelBenchNotified = false;     // #46b send paused/resumed Telegram only once per episode
  let __parallelStartedNotified = false;   // #46c send "parallel started" once per cycling run
  let __scanCursor = 0;               // rolling pointer into selected locations
  const DISABLE_HUMAN_PAUSES = true;  // remove idle-gap + long-break (caused cold-session 403); keep steady round wait
  const SUPABASE_ENABLED = typeof SupabaseSync !== "undefined";
  // Parallel-scan: captured real schedule-days request template (A1)
  let scheduleTemplate = null;
  const CAPTCHA_MAX_RETRIES = 5;
  const DASHBOARD_CLICK_DELAY = 2000;
  const MAX_EVENT_LOG = 500;
  const RELOGIN_FLAG = "__autoBookingRelogin";
  // Observation delay before auto-recovery (so operator can see real error on page)
  const ERROR_OBSERVE_SEC = 15;
  let __abortAll = false;

  // Helper: pause with countdown status before recovery action
  async function observeBeforeRecovery(reason, totalSec = ERROR_OBSERVE_SEC) {
    log(`Pausing ${totalSec}s for error observation: ${reason}`);
    for (let s = totalSec; s > 0; s--) {
      if (__abortAll) return;
      // Update status bar (if booking panel exists)
      const statusEl = document.getElementById("ab-status");
      if (statusEl) statusEl.textContent = `⚠️ ${reason} — recovery in ${s}s...`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

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

  let __flushCount = 0;
  function flushEventLog() {
    if (__pendingEvents.length === 0) return;
    const batch = __pendingEvents.splice(0);
    chrome.storage.local.get(["eventLog"], (data) => {
      const events = data.eventLog || [];
      events.unshift(...batch);
      if (events.length > MAX_EVENT_LOG) events.length = MAX_EVENT_LOG;
      chrome.storage.local.set({ eventLog: events }, () => {
        // Trigger quota check every 20 flushes (not every flush — avoid spam)
        __flushCount++;
        if (__flushCount % 20 === 0) {
          chrome.runtime.sendMessage({ action: "checkQuota" }, () => {
            if (chrome.runtime.lastError) {} // ignore — sw may be inactive
          });
        }
      });
    });
  }

  // Flush pending events before page unload to avoid losing logs on navigation
  window.addEventListener("beforeunload", () => {
    if (__eventFlushTimer) {
      clearTimeout(__eventFlushTimer);
      __eventFlushTimer = null;
    }
    flushEventLog();
    // Flush Supabase event buffer
    if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
      SupabaseSync.flushEvents();
    }
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

    // Push to Supabase
    if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
      SupabaseSync.bufferEvent({ type, message, username: username || "", metadata: extra || null, timestamp: event.timestamp });
    }

    // Auto-increment per-user counters based on event type
    if (username) {
      if (type === EVENT_TYPES.ERROR) {
        incrementUserCounter(username, "errorCount", 1);
        if (/429|rate.?limit/i.test(message)) setUserCounter(username, "last429At", new Date().toISOString());
        if (/401|session.+expired|unauthorized/i.test(message)) setUserCounter(username, "last401At", new Date().toISOString());
        bumpDailyStat({ key: "errors", delta: 1 });
      }
    }
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
    // Sync status to Supabase
    if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
      const isActive = ["cycling", "slot_found", "logging_in", "security_questions", "on_dashboard"].includes(status);
      SupabaseSync.updateProfileStatus(username, status, isActive);
    }
  }

  // Atomic counter increment for per-user metrics
  function incrementUserCounter(username, key, delta = 1) {
    if (!username || !key) return;
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = statuses[username] || {};
      statuses[username][key] = (statuses[username][key] || 0) + delta;
      statuses[username].updatedAt = new Date().toISOString();
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  // Set timestamp counter (e.g. last429At)
  function setUserCounter(username, key, value) {
    if (!username || !key) return;
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = statuses[username] || {};
      statuses[username][key] = value;
      statuses[username].updatedAt = new Date().toISOString();
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  // ─── DAILY STATS AGGREGATOR ─────────────────────────────────────
  // Aggregates per-day metrics for daily/weekly summary reports.
  // Day key = IST date (Asia/Kolkata) "YYYY-MM-DD".

  function istDayKey(d) {
    const date = d || new Date();
    // IST = UTC+5:30 → adjust UTC to IST then take date portion
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(date.getTime() + istOffsetMs);
    return ist.toISOString().substring(0, 10);
  }

  function istHour(d) {
    const date = d || new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(date.getTime() + istOffsetMs);
    return ist.getUTCHours(); // 0-23 in IST
  }

  function bumpDailyStat({ key, delta = 1, location, hour, username }) {
    const dayKey = istDayKey();
    chrome.storage.local.get(["dailyStats"], (data) => {
      const stats = data.dailyStats || {};
      const today = stats[dayKey] || {
        slotsFound: 0,
        slotsInRange: 0,
        slotsOutOfRange: 0,
        booked: 0,
        missed: 0,
        errors: 0,
        byLocation: {},
        byHour: {},
        activeUsers: {},
      };

      if (key) today[key] = (today[key] || 0) + delta;
      if (location) today.byLocation[location] = (today.byLocation[location] || 0) + delta;
      if (hour !== undefined) {
        const hKey = String(hour).padStart(2, "0");
        today.byHour[hKey] = (today.byHour[hKey] || 0) + delta;
      }
      if (username) today.activeUsers[username] = (today.activeUsers[username] || 0) + delta;

      stats[dayKey] = today;
      chrome.storage.local.set({ dailyStats: stats });

      // Push to Supabase
      if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
        SupabaseSync.pushDailyStat({
          username: username || null,
          date: dayKey,
          hour: hour != null ? hour : istHour(),
          location: location || null,
          [key]: delta,
        });
      }
    });
  }

  // Reset cycling counters (called on startCycling)
  function resetUserCycleCounters(username) {
    if (!username) return;
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = {
        ...(statuses[username] || {}),
        roundCount: 0,
        errorCount: 0,
        slotsInRangeFound: 0,
        slotsOutOfRangeFound: 0,
        cycleStartedAt: new Date().toISOString(),
        last429At: null,
        last401At: null,
        updatedAt: new Date().toISOString(),
      };
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─── SLOT HISTORY TRACKER ─────────────────────────────────────────
  // Records every detected slot for analytics/pattern detection.
  // Dedup: same (username, location, date) only logged once per 30 min window.

  const SLOT_HISTORY_DEDUP_MS = 30 * 60 * 1000; // 30 min

  function recordSlotHistory(entry) {
    // entry: { username, location, date, inRange, action }
    if (!entry.username || !entry.location || !entry.date) return;

    chrome.storage.local.get(["slotHistory"], (data) => {
      const history = data.slotHistory || [];
      const now = Date.now();

      // Dedup: skip if same key logged in last 30 min with same action
      const dupIdx = history.findIndex((e) =>
        e.username === entry.username &&
        e.location === entry.location &&
        e.date === entry.date &&
        e.action === (entry.action || "detected") &&
        now - new Date(e.foundAt).getTime() < SLOT_HISTORY_DEDUP_MS
      );
      if (dupIdx !== -1) return;

      const record = {
        id: now + "_" + Math.random().toString(36).substring(2, 6),
        username: entry.username,
        location: entry.location,
        date: entry.date,
        foundAt: new Date(now).toISOString(),
        inRange: !!entry.inRange,
        action: entry.action || "detected",
      };

      history.unshift(record);
      // Soft cap (quota prune in sw-enhanced enforces hard cap)
      if (history.length > 1500) history.length = 1500;
      chrome.storage.local.set({ slotHistory: history });

      // Push to Supabase
      if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
        SupabaseSync.pushSlot({
          username: entry.username, location: entry.location, date: entry.date,
          action: entry.action || "detected", inRange: !!entry.inRange,
          round: entry.round || null, detectedAt: record.foundAt,
        });
      }
    });
  }

  // Update existing slot history record's action (e.g. detected → selected → submitted)
  function updateSlotHistoryAction(username, location, date, newAction) {
    if (!username || !location || !date) return;
    chrome.storage.local.get(["slotHistory"], (data) => {
      const history = data.slotHistory || [];
      // Find most recent matching entry
      const idx = history.findIndex((e) =>
        e.username === username && e.location === location && e.date === date
      );
      if (idx !== -1) {
        history[idx].action = newAction;
        history[idx].actionAt = new Date().toISOString();
        chrome.storage.local.set({ slotHistory: history });
        if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
          SupabaseSync.updateSlotAction(username, location, date, newAction);
        }
      } else {
        // No prior detected entry — create fresh one with new action
        recordSlotHistory({ username, location, date, action: newAction });
      }
    });
  }

  // Capture booking page screenshot using html2canvas (already loaded by manifest)
  async function captureBookingScreenshot() {
    if (typeof html2canvas !== "function") {
      log("html2canvas not available — skipping screenshot");
      return null;
    }
    try {
      // Capture main container (booking panel + calendar + group members)
      const target = document.getElementById("main_container") || document.body;
      const canvas = await html2canvas(target, {
        logging: false,
        useCORS: true,
        backgroundColor: "#ffffff",
        scale: 0.7, // Reduce file size for Telegram (max ~10MB photo)
        windowWidth: target.scrollWidth,
        windowHeight: target.scrollHeight,
      });
      // JPEG at 0.7 quality balances size vs readability
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      return dataUrl.split(",")[1]; // base64 only
    } catch (e) {
      log("Screenshot capture failed: " + e.message);
      return null;
    }
  }

  // Send screenshot via service worker → Telegram sendPhoto
  async function sendSlotScreenshot(caption) {
    try {
      const photoBase64 = await captureBookingScreenshot();
      if (!photoBase64) {
        log("No screenshot to send");
        return;
      }
      chrome.runtime.sendMessage({
        action: "sendTelegramPhoto",
        photoBase64,
        caption,
      }, (resp) => {
        if (chrome.runtime.lastError) {
          log("Screenshot send failed: " + chrome.runtime.lastError.message);
        } else if (resp && !resp.ok) {
          log("Screenshot Telegram error: " + (resp.error || "unknown"));
        } else {
          log("Slot screenshot sent to Telegram");
        }
      });
    } catch (e) {
      log("sendSlotScreenshot error: " + e.message);
    }
  }

  function sendTelegramNotification(type, message, replyMarkup) {
    chrome.storage.local.get(["telegramBotToken", "telegramChatId", "telegramNotify"], (data) => {
      if (!data.telegramBotToken || !data.telegramChatId) return;
      const notify = data.telegramNotify || { slot: true, confirmed: true, error: true, rate: true, login: true, cycling: true, stopped: true };
      if (notify[type] === false) return;

      const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" });
      const prefix = TEST_MODE ? "🧪 <b>[TEST]</b>\n" : "";
      const fullMessage = prefix + message + `\n\n🕐 <i>${ts} IST</i>`;

      const payload = { action: "sendTelegram", text: fullMessage };
      if (replyMarkup) payload.replyMarkup = replyMarkup;

      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          log("Telegram send failed: " + chrome.runtime.lastError.message);
        } else if (resp && !resp.ok) {
          log("Telegram error: " + (resp.error || "unknown"));
        }
      });
    });
  }

  // Build + send the per-city in-range / out-of-range availability overview
  // (same format the sequential path uses). dates = array of "YYYY-MM-DD" strings.
  function sendSlotsOverview(cityName, dates, startDate, endDate) {
    if (!dates || !dates.length) return;
    const inRange = dates.filter((d) => isDateInRange(d, startDate, endDate)).sort();
    const outOfRange = dates.filter((d) => !isDateInRange(d, startDate, endDate)).sort();
    const byMonth = (arr) => {
      const m = {};
      arr.forEach((ds) => {
        const date = new Date(ds + "T00:00:00");
        const key = date.toLocaleString("en-US", { month: "long", year: "numeric" });
        (m[key] = m[key] || []).push(date.getDate());
      });
      return Object.entries(m)
        .map(([mo, days]) => `${mo}: ${days.sort((a, b) => a - b).join(", ")}`)
        .join("\n");
    };
    const inText = byMonth(inRange);
    const outText = byMonth(outOfRange);
    chrome.storage.local.get(["loginDetails", "userProfilesList", "__supabase_device_name"], (d) => {
      const u = d.loginDetails?.username || "";
      const profile = (d.userProfilesList || []).find((p) => p.username === u) || {};
      const deviceName = d.__supabase_device_name || "Unknown";
      const applicants = profile.applicantCount || 1;
      const visaType = profile.visaType || "";
      const msg =
        `📍 <b>SLOTS OVERVIEW: ${cityName}</b>\n\n` +
        `👤 <b>User:</b> ${u}\n` +
        `💻 <b>Device:</b> ${deviceName}\n` +
        `📆 <b>Date Range:</b> ${startDate || "—"} to ${endDate || "—"}\n` +
        `👥 <b>Applicants:</b> ${applicants}\n` +
        (visaType ? `🎫 <b>Visa:</b> ${visaType}\n` : "") +
        `🔄 <b>Round:</b> ${cycling.round} (parallel)\n\n` +
        `📅 <b>Available:</b> ${dates.length} dates\n\n` +
        `✅ <b>IN RANGE (${inRange.length}):</b>\n` + (inText || "None") + `\n` +
        `\n❌ <b>OUT OF RANGE (${outOfRange.length}):</b>\n` + (outText || "None") + `\n`;
      trackEvent(EVENT_TYPES.CYCLING, `Slots overview (parallel) for ${cityName}: ${inRange.length} in range, ${outOfRange.length} out of range`, u);
      sendTelegramNotification("availability", msg);
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

    let attempt = 0;
    while (true) {
      attempt++;
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
      sendTelegramNotification("error", `⚠️ <b>SECURITY QUESTIONS FAILED</b>\n\n👤 <b>User:</b> ${activeUser}\n❌ Only answered ${answered}/2 questions\n💡 Check saved answers in settings`);
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
      chrome.storage.local.set({ userProfilesList: profiles }, () => {
        // Push each profile to Supabase
        if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
          profiles.forEach((p) => SupabaseSync.pushProfile(p));
        }
        resolve();
      });
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

        <!-- Supabase Cloud Sync -->
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;margin-bottom:6px;color:#1a5276;border-bottom:1px solid #eee;padding-bottom:4px;">Cloud Sync (Supabase)</div>
          <!-- Import section — shown when no config exists -->
          <div id="sp-import-section" style="display:none;margin-bottom:6px;">
            <textarea id="sp-import-input" placeholder="Paste config string from another profile..." style="width:100%;height:50px;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:11px;font-family:monospace;resize:vertical;box-sizing:border-box;"></textarea>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
              <button id="sp-import-btn" style="background:#e67e22;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">📥 IMPORT CONFIG</button>
              <span id="sp-import-status" style="font-size:11px;color:#888;"></span>
            </div>
          </div>
          <!-- Manual config — shown when no config exists -->
          <div id="sp-manual-config">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
              <input type="text" id="sp-supa-key" placeholder="Operator API Key" style="flex:1;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
              <input type="password" id="sp-supa-master" placeholder="Master Password (for encryption)" style="flex:1;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:11px;">
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <button id="sp-supa-connect" style="background:#3ecf8e;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">CONNECT</button>
            <button id="sp-supa-pull" style="background:#6c5ce7;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;display:none;">PULL ALL</button>
            <button id="sp-supa-export" style="background:#16a085;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;display:none;">📤 EXPORT CONFIG</button>
            <button id="sp-supa-delete" style="background:#e74c3c;color:white;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;display:none;">DELETE DEVICE</button>
            <span id="sp-supa-status" style="font-size:11px;color:#888;"></span>
          </div>
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

    // Supabase Cloud Sync handlers
    chrome.storage.local.get(["__supabase_operator_key", "__supabase_master_pw"], (data) => {
      const importSection = document.getElementById("sp-import-section");
      const manualConfig = document.getElementById("sp-manual-config");
      const exportBtn = document.getElementById("sp-supa-export");
      if (data.__supabase_operator_key) {
        const keyInput = document.getElementById("sp-supa-key");
        if (keyInput) keyInput.value = data.__supabase_operator_key;
        const statusEl = document.getElementById("sp-supa-status");
        const pullBtn = document.getElementById("sp-supa-pull");
        const deleteBtn = document.getElementById("sp-supa-delete");
        if (statusEl) statusEl.textContent = "Connected";
        if (statusEl) statusEl.style.color = "#27ae60";
        if (pullBtn) pullBtn.style.display = "inline-block";
        if (deleteBtn) deleteBtn.style.display = "inline-block";
        if (exportBtn) exportBtn.style.display = "inline-block";
        if (importSection) importSection.style.display = "none";
      } else {
        // No config — show import option
        if (importSection) importSection.style.display = "block";
      }
    });

    document.getElementById("sp-supa-connect").addEventListener("click", async () => {
      const keyInput = document.getElementById("sp-supa-key");
      const masterInput = document.getElementById("sp-supa-master");
      const statusEl = document.getElementById("sp-supa-status");
      const pullBtn = document.getElementById("sp-supa-pull");
      const opKey = keyInput.value.trim();
      const masterPw = masterInput.value;

      if (!opKey) { statusEl.textContent = "Enter API key!"; statusEl.style.color = "#e74c3c"; return; }
      if (!masterPw) { statusEl.textContent = "Enter master password!"; statusEl.style.color = "#e74c3c"; return; }

      // Prompt for device name on first connect
      const existingDevice = await new Promise(r => chrome.storage.local.get(["__supabase_device_id"], r));
      let deviceName = null;
      if (!existingDevice.__supabase_device_id) {
        deviceName = prompt("Name this Chrome profile (e.g. Arun-Main, Kavita-Laptop):");
        if (!deviceName || !deviceName.trim()) { statusEl.textContent = "Device name required!"; statusEl.style.color = "#e74c3c"; return; }
        deviceName = deviceName.trim();
        if (TEST_MODE && !/^TEST-/i.test(deviceName)) deviceName = "TEST-" + deviceName;
      }

      statusEl.textContent = "Connecting...";
      statusEl.style.color = "#f39c12";

      try {
        if (SUPABASE_ENABLED) {
          await SupabaseSync.init(opKey, masterPw, deviceName);
          statusEl.textContent = "Connected! Device registered.";
          statusEl.style.color = "#27ae60";
          pullBtn.style.display = "inline-block";
          document.getElementById("sp-supa-delete").style.display = "inline-block";

          // Push all existing local profiles to Supabase
          const profiles = await loadUserProfiles();
          for (const p of profiles) { await SupabaseSync.pushProfile(p); }
          statusEl.textContent = `Connected! ${profiles.length} profiles synced.`;
        } else {
          statusEl.textContent = "SupabaseSync not loaded";
          statusEl.style.color = "#e74c3c";
        }
      } catch (e) {
        statusEl.textContent = "Error: " + e.message;
        statusEl.style.color = "#e74c3c";
      }
    });

    document.getElementById("sp-supa-pull").addEventListener("click", async () => {
      const statusEl = document.getElementById("sp-supa-status");
      if (!SUPABASE_ENABLED || !SupabaseSync.isReady()) {
        statusEl.textContent = "Not connected";
        statusEl.style.color = "#e74c3c";
        return;
      }
      statusEl.textContent = "Pulling profiles...";
      statusEl.style.color = "#f39c12";

      try {
        const cloudProfiles = await SupabaseSync.pullProfiles();
        if (cloudProfiles.length === 0) {
          statusEl.textContent = "No profiles in cloud";
          statusEl.style.color = "#f39c12";
          return;
        }

        // Merge with local: cloud wins on conflict (by username)
        let localProfiles = await loadUserProfiles();
        for (const cp of cloudProfiles) {
          const localProfile = {
            username: cp.username,
            password: cp.password,
            securityQuestions: {},
            autoLogin: cp.autoLogin,
            autoDashboard: cp.autoDashboard,
            autoSelect: cp.autoSelect,
            autoSubmit: cp.autoSubmit,
            captchaMode: cp.captchaMode,
            startDate: cp.startDate || "",
            endDate: cp.endDate || "",
            locations: cp.locations || [],
            visaType: cp.visaType || "",
            agreedPrice: cp.agreedPrice || "",
          };
          // Convert security questions array to object
          if (cp.securityQuestions) {
            cp.securityQuestions.forEach((sq) => {
              if (sq.question && sq.answer) localProfile.securityQuestions[sq.question] = sq.answer;
            });
          }
          const idx = localProfiles.findIndex((p) => p.username === cp.username);
          if (idx >= 0) localProfiles[idx] = { ...localProfiles[idx], ...localProfile };
          else localProfiles.push(localProfile);
        }

        await new Promise((r) => chrome.storage.local.set({ userProfilesList: localProfiles }, r));
        statusEl.textContent = `Pulled ${cloudProfiles.length} profiles!`;
        statusEl.style.color = "#27ae60";

        // Refresh dropdown if exists
        const dropdown = document.getElementById("sp-user-select");
        if (dropdown) {
          const currentVal = dropdown.value;
          await refreshUserDropdown(currentVal);
        }
      } catch (e) {
        statusEl.textContent = "Pull failed: " + e.message;
        statusEl.style.color = "#e74c3c";
      }
    });

    document.getElementById("sp-supa-delete").addEventListener("click", async () => {
      const statusEl = document.getElementById("sp-supa-status");
      const pullBtn = document.getElementById("sp-supa-pull");
      const deleteBtn = document.getElementById("sp-supa-delete");

      if (!SUPABASE_ENABLED) {
        statusEl.textContent = "SupabaseSync not loaded";
        statusEl.style.color = "#e74c3c";
        return;
      }

      const confirmed = confirm("Are you sure? This will remove this device from Supabase cloud and clear all local sync data. You can re-register after.");
      if (!confirmed) return;

      statusEl.textContent = "Deleting device...";
      statusEl.style.color = "#f39c12";

      try {
        await SupabaseSync.deleteDevice();
        statusEl.textContent = "Device deleted. Click CONNECT to re-register.";
        statusEl.style.color = "#e74c3c";
        pullBtn.style.display = "none";
        deleteBtn.style.display = "none";
        // Clear key/password inputs
        document.getElementById("sp-supa-key").value = "";
        document.getElementById("sp-supa-master").value = "";
      } catch (e) {
        statusEl.textContent = "Delete failed: " + e.message;
        statusEl.style.color = "#e74c3c";
      }
    });

    // Export config — copies base64 config string to clipboard
    document.getElementById("sp-supa-export").addEventListener("click", async () => {
      const statusEl = document.getElementById("sp-supa-status");
      try {
        const data = await new Promise(r => chrome.storage.local.get(
          ["telegramBotToken", "telegramChatId", "__supabase_operator_key", "__supabase_master_pw"], r
        ));
        const config = {
          telegramBotToken: data.telegramBotToken || "",
          telegramChatId: data.telegramChatId || "",
          supabaseOperatorKey: data.__supabase_operator_key || "",
          supabaseMasterPassword: data.__supabase_master_pw || "",
        };
        if (!config.supabaseOperatorKey || !config.supabaseMasterPassword) {
          statusEl.textContent = "Missing Supabase config!";
          statusEl.style.color = "#e74c3c";
          return;
        }
        const encoded = btoa(JSON.stringify(config));
        await navigator.clipboard.writeText(encoded);
        statusEl.textContent = "📋 Config copied to clipboard!";
        statusEl.style.color = "#16a085";
        setTimeout(() => { statusEl.textContent = "Connected"; statusEl.style.color = "#27ae60"; }, 3000);
      } catch (e) {
        statusEl.textContent = "Export failed: " + e.message;
        statusEl.style.color = "#e74c3c";
      }
    });

    // Import config — decode base64, save, connect, pull profiles
    document.getElementById("sp-import-btn").addEventListener("click", async () => {
      const input = document.getElementById("sp-import-input");
      const statusEl = document.getElementById("sp-import-status");
      const raw = (input.value || "").trim();
      if (!raw) { statusEl.textContent = "Paste config string first!"; statusEl.style.color = "#e74c3c"; return; }

      let config;
      try {
        config = JSON.parse(atob(raw));
      } catch {
        statusEl.textContent = "Invalid config string!";
        statusEl.style.color = "#e74c3c";
        return;
      }

      if (!config.supabaseOperatorKey || !config.supabaseMasterPassword) {
        statusEl.textContent = "Config missing Supabase keys!";
        statusEl.style.color = "#e74c3c";
        return;
      }

      // Prompt for device name
      const deviceName = prompt("Name this Chrome profile (e.g. Ravi-Laptop, Arun-Main):");
      if (!deviceName || !deviceName.trim()) {
        statusEl.textContent = "Device name required!";
        statusEl.style.color = "#e74c3c";
        return;
      }

      statusEl.textContent = "Importing...";
      statusEl.style.color = "#f39c12";

      try {
        // Save Telegram config
        await new Promise(r => chrome.storage.local.set({
          telegramBotToken: config.telegramBotToken || "",
          telegramChatId: config.telegramChatId || "",
          telegramNotify: true,
          __supabase_operator_key: config.supabaseOperatorKey,
          __supabase_master_pw: config.supabaseMasterPassword,
        }, r));

        // Connect to Supabase + register device
        if (SUPABASE_ENABLED) {
          let regName = deviceName.trim();
          if (TEST_MODE && !/^TEST-/i.test(regName)) regName = "TEST-" + regName;
          await SupabaseSync.init(config.supabaseOperatorKey, config.supabaseMasterPassword, regName);

          // Pull all user profiles
          const cloudProfiles = await SupabaseSync.pullProfiles();
          let localProfiles = [];
          for (const cp of cloudProfiles) {
            const profile = {
              username: cp.username,
              password: cp.password,
              securityQuestions: {},
              autoLogin: cp.autoLogin,
              autoDashboard: cp.autoDashboard,
              autoSelect: cp.autoSelect,
              autoSubmit: cp.autoSubmit,
              captchaMode: cp.captchaMode,
              startDate: cp.startDate || "",
              endDate: cp.endDate || "",
              locations: cp.locations || [],
              visaType: cp.visaType || "",
              agreedPrice: cp.agreedPrice || "",
            };
            if (cp.securityQuestions) {
              cp.securityQuestions.forEach((sq) => {
                if (sq.question && sq.answer) profile.securityQuestions[sq.question] = sq.answer;
              });
            }
            localProfiles.push(profile);
          }
          await new Promise(r => chrome.storage.local.set({ userProfilesList: localProfiles }, r));

          statusEl.textContent = `✅ Connected! ${cloudProfiles.length} profiles loaded.`;
          statusEl.style.color = "#27ae60";

          // Update UI — hide import, show connected state
          document.getElementById("sp-import-section").style.display = "none";
          document.getElementById("sp-supa-key").value = config.supabaseOperatorKey;
          document.getElementById("sp-supa-status").textContent = "Connected";
          document.getElementById("sp-supa-status").style.color = "#27ae60";
          document.getElementById("sp-supa-pull").style.display = "inline-block";
          document.getElementById("sp-supa-export").style.display = "inline-block";
          document.getElementById("sp-supa-delete").style.display = "inline-block";

          // Refresh user dropdown
          const profiles = await loadUserProfiles();
          await refreshUserDropdown(profiles.length > 0 ? profiles[0].username : "__new__");
          if (profiles.length > 0) populateForm(profiles[0]);
        } else {
          statusEl.textContent = "SupabaseSync not loaded!";
          statusEl.style.color = "#e74c3c";
        }
      } catch (e) {
        statusEl.textContent = "Import failed: " + e.message;
        statusEl.style.color = "#e74c3c";
        log("Config import error: " + e.message);
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

      if (userField && passField) {
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

        // CAPTCHA is optional — site may have removed it
        if (captchaImg) {
          await handleCaptcha(settings);
        } else {
          log("No CAPTCHA detected — clicking Sign In directly");
          const signInBtn = document.getElementById("next") || document.querySelector('button[type="submit"], #continue');
          if (signInBtn) {
            clickSafe(signInBtn);
            trackEvent(EVENT_TYPES.LOGIN, "Clicked Sign In (no CAPTCHA)", loginDetails.username);
          } else {
            log("Sign In button not found");
          }
        }
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
          sendTelegramNotification("error", `🔴 <b>LOGIN FAILED</b>\n\n👤 <b>User:</b> ${autoUser}\n❌ Login page failed to load after 5 retries`);
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
    log(`[DEBUG] Login page check — activeAutoUser: ${activeAutoUser || "null"}, isRelogin: ${isRelogin}, abortAll: ${__abortAll}`);

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
        sendTelegramNotification("error", `⚠️ <b>NO CREDENTIALS</b>\n\n👤 <b>User:</b> ${targetUser || "unknown"}\n❌ No saved credentials found\n💡 Enter credentials in settings panel`);
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

    // Check if we came here to logout after severe error (1015/429/CF blocked)
    const severeLogoutReason = sessionStorage.getItem("__abSevereLogout");
    if (severeLogoutReason) {
      sessionStorage.removeItem("__abSevereLogout");
      log(`Severe logout: ${severeLogoutReason} — finding sign-out link on dashboard`);
      trackEvent(EVENT_TYPES.SESSION, `Dashboard logout for: ${severeLogoutReason}`, activeUser);

      // Wait for page to fully load
      await sleep(2000);

      // Dashboard reachable → reset severe attempt counter (logout will succeed)
      sessionStorage.removeItem("__abSevereCount");

      const signOutLink = document.querySelector('a[href*="LogOff"], a[href*="sign-out"], a[href*="signout"], a[href*="logout"], a[aria-label="Sign out"]');
      if (signOutLink) {
        log("Sign-out link found — clicking to logout");
        trackEvent(EVENT_TYPES.SESSION, "Sign-out link clicked — logging out", activeUser);
        sendTelegramNotification("error",
          `✅ <b>LOGGED OUT SUCCESSFULLY</b>\n\n` +
          `👤 <b>User:</b> ${activeUser}\n` +
          `📋 <b>Reason:</b> ${severeLogoutReason}\n` +
          `✅ Chrome profile free for next user`
        );
        // Clear credentials AFTER we have the username for Telegram, then click logout
        chrome.storage.local.remove(["loginDetails", "securityQuestions"]);
        signOutLink.click();
      } else {
        log("Sign-out link NOT found on dashboard — clearing all state as fallback");
        trackEvent(EVENT_TYPES.ERROR, "Sign-out link not found on dashboard — manual logout needed", activeUser);
        sendTelegramNotification("error",
          `⚠️ <b>LOGOUT FAILED</b>\n\n` +
          `👤 <b>User:</b> ${activeUser}\n` +
          `📋 <b>Reason:</b> ${severeLogoutReason}\n` +
          `❌ Sign-out link not found on dashboard\n` +
          `🔧 Manual logout required`
        );
        // Clear everything to prevent auto-click loop
        chrome.storage.local.remove(["loginDetails", "securityQuestions", "is_auto-dashboard"]);
      }
      return; // Stop — don't auto-click Continue/Reschedule
    }

    updateUserStatus(activeUser, "on_dashboard");

    // Check if automation is still active (persistent flag survives page reloads)
    const autoUser = await new Promise((r) => {
      chrome.storage.local.get(["activeAutomationUser"], (d) => r(d.activeAutomationUser || null));
    });

    // #49 rate-limit pause: stay at dashboard (no Continue, no logout) until the operator
    // changes IP and restarts. Restart sets activeAutomationUser → clears pause + proceeds.
    const pausedRL = sessionStorage.getItem("__abPausedRateLimit");
    if (pausedRL && !autoUser) {
      updateUserStatus(activeUser, "rate_limited");
      log(`Paused (${pausedRL}) — staying at dashboard; change IP then restart`);
      trackEvent(EVENT_TYPES.DASHBOARD, `Paused at dashboard (${pausedRL}) — awaiting IP change + restart`, activeUser);
      return; // do NOT auto-continue
    }
    if (pausedRL && autoUser) sessionStorage.removeItem("__abPausedRateLimit"); // operator restarted → clear

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

  let cycling = {
    active: false, timer: null, round: 0,
    keepAliveTimer: null, lastRefresh: 0, backoffMs: 0, keepAliveFailCount: 0,
    // Grace period: after failed submit, retry same location quickly
    gracePeriod: {
      active: false,
      location: null,
      roundsRemaining: 0,
      fastIntervalMs: 10000,
      missedDate: null,
    },
  };

  // ─── RATE TRACKER ───────────────────────────────────────────────
  const RATE_SOFT_LIMIT = 4;   // req/min → add extra delay
  const RATE_HARD_LIMIT = 6;   // req/min → pause 60s
  const RATE_WINDOW_MS = 60000; // 60 second sliding window
  const RATE_FLUSH_INTERVAL_MS = 60000; // flush stats every 60s

  let rateTracker = {
    window: [],              // timestamps of each request
    totalRequests: 0,
    successfulRequests: 0,
    blockedRequests: 0,
    delays: [],              // delay values for avg calculation
    locationsChecked: new Set(),
    errorTypes: {},
    periodStart: null,
    flushTimer: null,
  };

  function rateTrackerReset() {
    rateTracker.window = [];
    rateTracker.totalRequests = 0;
    rateTracker.successfulRequests = 0;
    rateTracker.blockedRequests = 0;
    rateTracker.delays = [];
    rateTracker.locationsChecked = new Set();
    rateTracker.errorTypes = {};
    rateTracker.periodStart = new Date().toISOString();
    if (rateTracker.flushTimer) clearInterval(rateTracker.flushTimer);
    rateTracker.flushTimer = null;
  }

  function rateTrackerRecord(locName, success, delaySec) {
    const now = Date.now();
    rateTracker.window.push(now);
    rateTracker.totalRequests++;
    if (success) rateTracker.successfulRequests++;
    else rateTracker.blockedRequests++;
    if (delaySec != null) rateTracker.delays.push(delaySec);
    if (locName) rateTracker.locationsChecked.add(locName);
    // Trim window to last 60s
    rateTracker.window = rateTracker.window.filter(t => now - t < RATE_WINDOW_MS);
  }

  function rateTrackerRecordError(errorType) {
    rateTracker.errorTypes[errorType] = (rateTracker.errorTypes[errorType] || 0) + 1;
  }

  function rateTrackerGetRate() {
    const now = Date.now();
    rateTracker.window = rateTracker.window.filter(t => now - t < RATE_WINDOW_MS);
    return rateTracker.window.length;
  }

  async function rateTrackerFlush() {
    if (rateTracker.totalRequests === 0) return;
    const avgDelay = rateTracker.delays.length > 0
      ? Math.round((rateTracker.delays.reduce((a, b) => a + b, 0) / rateTracker.delays.length) * 10) / 10
      : 0;
    const stats = {
      username: "",
      periodStart: rateTracker.periodStart,
      periodEnd: new Date().toISOString(),
      totalRequests: rateTracker.totalRequests,
      successfulRequests: rateTracker.successfulRequests,
      blockedRequests: rateTracker.blockedRequests,
      avgDelaySec: avgDelay,
      locationsChecked: Array.from(rateTracker.locationsChecked),
      errorTypes: rateTracker.errorTypes,
    };
    // Get username
    const d = await new Promise(r => chrome.storage.local.get(["loginDetails"], r));
    stats.username = d.loginDetails?.username || "";
    // Push to Supabase
    if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
      await SupabaseSync.pushRequestStats(stats);
      log(`Rate stats flushed: ${stats.totalRequests} req, ${stats.successfulRequests} ok, ${stats.blockedRequests} blocked, avg ${avgDelay}s`);
    }
    // Reset counters for next period (keep window for rate calc)
    rateTracker.totalRequests = 0;
    rateTracker.successfulRequests = 0;
    rateTracker.blockedRequests = 0;
    rateTracker.delays = [];
    rateTracker.locationsChecked = new Set();
    rateTracker.errorTypes = {};
    rateTracker.periodStart = new Date().toISOString();
  }
  const GRACE_PERIOD_ROUNDS = 5;
  const GRACE_PERIOD_INTERVAL_MS = 10000;

  // Smart range expansion config
  const EXPAND_OFFER_ENABLED = false;       // ← disabled per user request
  const EXPAND_OFFER_MIN_ROUNDS = 30;        // wait this many rounds before offering
  const EXPAND_OFFER_COOLDOWN_MS = 30 * 60 * 1000; // re-offer at most every 30 min
  function randomRefreshMs() { return (6 + Math.random() * 6) * 60 * 1000; } // 6-12 minutes random
  let SESSION_REFRESH_MS = randomRefreshMs();

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
          <button id="ab-parallel-test-btn"
                  style="background:#6c5ce7;color:white;border:none;padding:8px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;">
            ⚡ TEST PARALLEL SCAN
          </button>
          <span id="ab-cycle-info" style="font-size:12px;color:#888;margin-left:10px;"></span>
        </div>
        <div id="ab-parallel-result" style="font-size:12px;color:#6c5ce7;margin-top:8px;white-space:pre-wrap;"></div>
        <div id="ab-vpn-section" style="margin-top:12px;padding:10px 12px;background:#f0f4f8;border:1px solid #d5dfe8;border-radius:6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <strong style="font-size:13px;color:#1a5276;">VPN Rotation:</strong>
          <label style="position:relative;display:inline-block;width:50px;height:26px;cursor:pointer;">
            <input type="checkbox" id="ab-vpn-toggle" style="opacity:0;width:0;height:0;">
            <span id="ab-vpn-slider" style="position:absolute;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:26px;transition:.3s;"></span>
          </label>
          <span id="ab-vpn-label" style="font-size:13px;font-weight:600;color:#7f8c8d;">OFF</span>
          <span id="ab-vpn-info" style="font-size:12px;color:#888;margin-left:auto;"></span>
        </div>
      </div>`;

    mainContainer.parentNode.insertBefore(panel, mainContainer);

    // Inject activity log panel below booking panel
    injectActivityLogPanel(panel);

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

    // TEST PARALLEL SCAN button (A2) — run all-cities-at-once fetch, show results
    const parTestBtn = document.getElementById("ab-parallel-test-btn");
    if (parTestBtn) parTestBtn.addEventListener("click", async () => {
      const out = document.getElementById("ab-parallel-result");
      if (!scheduleTemplate) {
        out.textContent = "⚠️ No template yet — change the city dropdown once first, then click again.";
        return;
      }
      out.textContent = "⚡ Scanning all cities in parallel...";
      const t0 = Date.now();
      const res = await parallelScan();
      if (!res) { out.textContent = "⚠️ Scan failed — no template."; return; }
      const lines = Object.values(res).map((r) =>
        r.ok ? `✅ ${r.name}: ${r.dates.length} date(s)${r.dates.length ? " → " + r.dates.slice(0, 5).join(", ") : ""} (${r.ms}ms)`
             : `❌ ${r.name}: ${r.error || ("HTTP " + r.status)}`
      );
      out.textContent = `Done in ${Date.now() - t0}ms (all cities together):\n` + lines.join("\n");
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

    // ─── VPN ROTATION TOGGLE ───────────────────────────────────────────
    const vpnToggle = document.getElementById("ab-vpn-toggle");
    const vpnSlider = document.getElementById("ab-vpn-slider");
    const vpnLabel = document.getElementById("ab-vpn-label");
    const vpnInfo = document.getElementById("ab-vpn-info");

    function vpnSend(command) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "vpnControl", command }, (resp) => {
          resolve(resp || { ok: false, error: "no response" });
        });
      });
    }

    function vpnUpdateUI(data) {
      if (!vpnToggle) return;
      const on = data.connected && data.auto_rotating;
      vpnToggle.checked = on;
      vpnSlider.style.background = on ? "#27ae60" : "#ccc";
      vpnSlider.innerHTML = `<span style="position:absolute;height:20px;width:20px;left:${on ? "26px" : "3px"};bottom:3px;background:white;border-radius:50%;transition:.3s;"></span>`;
      vpnLabel.textContent = on ? "ON" : "OFF";
      vpnLabel.style.color = on ? "#27ae60" : "#7f8c8d";
      if (data.connected && data.city) {
        vpnInfo.textContent = `IP: ${data.public_ip} | ${data.city}`;
        vpnInfo.style.color = "#27ae60";
      } else if (data.connected) {
        vpnInfo.textContent = `IP: ${data.public_ip}`;
        vpnInfo.style.color = "#27ae60";
      } else {
        vpnInfo.textContent = "";
      }
    }

    function vpnSetOffline() {
      if (!vpnToggle) return;
      vpnToggle.checked = false;
      vpnToggle.disabled = true;
      vpnSlider.style.background = "#eee";
      vpnSlider.innerHTML = `<span style="position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#ddd;border-radius:50%;"></span>`;
      vpnLabel.textContent = "OFFLINE";
      vpnLabel.style.color = "#bbb";
      vpnInfo.textContent = "Run: python vpn_server.py";
      vpnInfo.style.color = "#e74c3c";
    }

    async function vpnFetchStatus() {
      const data = await vpnSend("status");
      if (data.error) { vpnSetOffline(); return null; }
      vpnToggle.disabled = false;
      vpnUpdateUI(data);
      return data;
    }

    vpnFetchStatus();
    const vpnPollTimer = setInterval(vpnFetchStatus, 30000);

    if (vpnToggle) vpnToggle.addEventListener("change", async () => {
      const command = vpnToggle.checked ? "start" : "stop";
      vpnLabel.textContent = "...";
      vpnInfo.textContent = command === "start" ? "Connecting..." : "Disconnecting...";
      const data = await vpnSend(command);
      if (data.error) { vpnSetOffline(); log("VPN server unreachable"); return; }
      vpnUpdateUI(data);
      log(`VPN rotation ${command === "start" ? "enabled" : "disabled"} — IP: ${data.public_ip}`);
    });

    log("Booking panel injected");
  }

  function setStatus(msg) {
    const el = document.getElementById("ab-status");
    if (el) el.textContent = msg;
    log(msg);
  }

  // ─── ACTIVITY LOG PANEL (on booking page) ──────────────────────────
  // Shows last 15 events directly on /ofc-schedule and /schedule pages
  // so operator sees activity without opening dashboard

  let __activityLogTimer = null;

  function injectActivityLogPanel(anchorEl) {
    if (document.getElementById("ab-log-panel")) return;
    if (!anchorEl) return;

    const logPanel = document.createElement("div");
    logPanel.id = "ab-log-panel";
    logPanel.style.cssText =
      "margin:10px auto 15px;max-width:1000px;box-shadow:0 2px 8px rgba(0,0,0,0.15);border-radius:8px;font-family:inherit;";
    logPanel.innerHTML = `
      <div id="ab-log-header" style="background:#2c3e50;color:white;padding:8px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
        <strong style="font-size:13px;">📋 Activity Log <span id="ab-log-count" style="background:#34495e;padding:2px 8px;border-radius:10px;font-size:10px;margin-left:6px;">0</span></strong>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="ab-log-filter" style="background:#34495e;color:white;border:none;font-size:11px;padding:3px 6px;border-radius:3px;">
            <option value="all">All</option>
            <option value="cycling">Cycling</option>
            <option value="slot_found">Slot</option>
            <option value="booking">Booking</option>
            <option value="error">Errors</option>
            <option value="session">Session</option>
            <option value="captcha">CAPTCHA</option>
          </select>
          <span id="ab-log-toggle" style="font-size:14px;line-height:1;">▼</span>
        </div>
      </div>
      <div id="ab-log-body" style="background:#0f1923;padding:8px;border:1px solid #2d3e50;border-top:none;border-radius:0 0 8px 8px;max-height:280px;overflow-y:auto;font-family:monospace;font-size:11px;color:#cfd8dc;">
        <div style="text-align:center;color:#78909c;padding:10px;">Loading...</div>
      </div>`;

    anchorEl.parentNode.insertBefore(logPanel, anchorEl.nextSibling);

    // Toggle collapse
    document.getElementById("ab-log-header").addEventListener("click", (e) => {
      // Don't toggle when clicking the filter dropdown
      if (e.target.id === "ab-log-filter") return;
      const body = document.getElementById("ab-log-body");
      const arrow = document.getElementById("ab-log-toggle");
      if (body.style.display === "none") {
        body.style.display = "block";
        arrow.textContent = "▼";
      } else {
        body.style.display = "none";
        arrow.textContent = "▶";
      }
    });

    // Filter change
    document.getElementById("ab-log-filter").addEventListener("change", () => {
      renderActivityLogPanel();
    });

    // Initial render + periodic refresh
    renderActivityLogPanel();
    if (__activityLogTimer) clearInterval(__activityLogTimer);
    __activityLogTimer = setInterval(renderActivityLogPanel, 3000);
  }

  function renderActivityLogPanel() {
    const body = document.getElementById("ab-log-body");
    const countEl = document.getElementById("ab-log-count");
    const filterEl = document.getElementById("ab-log-filter");
    if (!body) return;

    const filter = filterEl?.value || "all";

    chrome.storage.local.get(["eventLog", "loginDetails"], (data) => {
      let events = data.eventLog || [];
      const activeUser = data.loginDetails?.username || "";

      // Filter by current user if known (avoid noise from other users)
      if (activeUser) {
        events = events.filter((e) => !e.username || e.username === activeUser);
      }

      // Filter by type
      if (filter !== "all") {
        events = events.filter((e) => e.type === filter);
      }

      const display = events.slice(0, 15);

      if (countEl) countEl.textContent = events.length;

      if (display.length === 0) {
        body.innerHTML = '<div style="text-align:center;color:#78909c;padding:10px;">No events yet</div>';
        return;
      }

      const typeColors = {
        login: "#3498db",
        captcha: "#9b59b6",
        security: "#9b59b6",
        dashboard: "#1abc9c",
        cycling: "#16a085",
        slot_found: "#27ae60",
        booking: "#f39c12",
        error: "#e74c3c",
        queue: "#7f8c8d",
        session: "#e67e22",
      };

      const esc = (s) => (s || "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      body.innerHTML = display.map((e) => {
        const color = typeColors[e.type] || "#78909c";
        const time = new Date(e.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return `
          <div style="display:flex;gap:8px;padding:3px 4px;border-bottom:1px solid #1a2733;align-items:flex-start;">
            <span style="color:#78909c;flex-shrink:0;width:75px;">${time}</span>
            <span style="background:${color};color:white;padding:1px 6px;border-radius:3px;font-size:9px;text-transform:uppercase;flex-shrink:0;min-width:60px;text-align:center;">${esc(e.type)}</span>
            <span style="color:#cfd8dc;flex:1;word-break:break-word;">${esc(e.message)}</span>
          </div>`;
      }).join("");
    });
  }

  // Cleanup timer on page unload
  window.addEventListener("beforeunload", () => {
    if (__activityLogTimer) {
      clearInterval(__activityLogTimer);
      __activityLogTimer = null;
    }
  });

  function setCycleInfo(msg) {
    const el = document.getElementById("ab-cycle-info");
    if (el) el.textContent = msg;
  }

  // ─── SESSION KEEP-ALIVE & 401 RECOVERY ─────────────────────────────

  // Listen for 401 events dispatched by XHR/fetch on the page
  // page.js (MAIN world) fires vSCP events — we also listen for a custom 401 signal
  let __session401Detected = false;
  let __rateLimited429 = false;

  // ─── CLOUDFLARE CHALLENGE / "UNABLE TO LOAD" DETECTION ─────────────
  let __cfChallengeActive = false;    // Turnstile widget detected on page

  // Detect Cloudflare Turnstile widget on current page
  // Turnstile renders as: <div class="cf-turnstile"> or iframe src containing challenges.cloudflare.com
  function isWaitingRoom() {
    const bodyText = (document.body?.textContent || "").toLowerCase();
    return bodyText.includes("you are now in line") ||
           bodyText.includes("estimated wait time") ||
           bodyText.includes("thank you for your patience") ||
           bodyText.includes("waiting room powered by cloudflare");
  }

  function detectTurnstileChallenge() {
    // Waiting room pages have CF elements but are NOT challenges — exclude them
    if (isWaitingRoom()) return false;
    // Check for Turnstile container div
    if (document.querySelector(".cf-turnstile, #cf-turnstile, [data-sitekey]")) return true;
    // Cloudflare interstitial widget (often inside closed shadow-root, but these markers live on the OUTER page)
    if (document.querySelector('input[name="cf-turnstile-response"], input#cf-chl-widget-response, #challenge-running, #challenge-form, #challenge-stage, .main-wrapper .ch-title')) return true;
    // Check for challenge iframe
    const iframes = document.querySelectorAll("iframe");
    for (const f of iframes) {
      const src = (f.src || "").toLowerCase();
      if (src.includes("challenges.cloudflare.com") || src.includes("turnstile")) return true;
    }
    // Title / body text signals of the full-page CF interstitial (outer page — reachable)
    const title = (document.title || "").toLowerCase();
    if (title.includes("just a moment")) return true;
    const bodyTxt = (document.body?.textContent || "").toLowerCase();
    if (bodyTxt.includes("performing security verification") ||
        bodyTxt.includes("verify you are human") ||
        bodyTxt.includes("security service to protect")) return true;
    return false;
  }

  // Wait for Turnstile challenge to be solved (poll every 2s, max 5 min)
  async function waitForChallengeSolved(maxWaitMs = 300000) {
    const start = Date.now();
    const statusEl = document.getElementById("ab-status");
    log("Waiting for Cloudflare challenge to be solved...");
    while (Date.now() - start < maxWaitMs) {
      if (!cycling.active || __abortAll) return false;
      const remaining = Math.ceil((maxWaitMs - (Date.now() - start)) / 1000);
      if (statusEl) statusEl.textContent = `🛡️ Cloudflare challenge — solve manually (${remaining}s timeout)`;
      await sleep(2000);
      if (!detectTurnstileChallenge()) {
        log("Cloudflare challenge cleared!");
        __cfChallengeActive = false;
        return true;
      }
    }
    log("Cloudflare challenge wait timed out after " + (maxWaitMs / 1000) + "s");
    return false;
  }

  // Handle "unable to load" alert — stop cycling, cooldown, navigate to dashboard
  let __reentryCount = 0;  // #49 consecutive "unable to load" dashboard re-entries (resets on a successful fetch)
  const UNABLE_MAX_REENTRIES = 3; // #49 after this many failed re-entries → alert + log out

  function onUnableToLoadAlert(alertText) {
    // Prevent multiple triggers from same round (multiple locations fail)
    if (window.__unableToLoadHandling) return;
    window.__unableToLoadHandling = true;

    // #49 persist the counter in sessionStorage — survives the dashboard/login/booking
    // page navigations (in-memory var resets on every page load → was stuck at 1/3).
    const reentry = (parseInt(sessionStorage.getItem("__abUnableCount") || "0", 10) || 0) + 1;
    sessionStorage.setItem("__abUnableCount", String(reentry));
    __reentryCount = reentry; // keep module var in sync (resume logging)
    const roundsCompleted = cycling.round;
    rateTrackerRecordError("unable_to_load");
    if (cycling.active) stopCycling("Unable to load — navigating to dashboard");

    chrome.storage.local.get(["loginDetails"], async (d) => {
      const u = d.loginDetails?.username || "";

      // #49: after 3 dashboard re-entries still failing → alert + LOG OUT.
      if (reentry > UNABLE_MAX_REENTRIES) {
        log(`"Unable to load" — still failing after ${UNABLE_MAX_REENTRIES} re-entries → alert + logout`);
        trackEvent(EVENT_TYPES.ERROR, `Unable to load — ${UNABLE_MAX_REENTRIES} re-entries failed → logging out`, u);
        sendTelegramNotification("error",
          `🚫 <b>UNABLE TO LOAD</b>\n\n` +
          `👤 <b>User:</b> ${u}\n` +
          `❌ Still failing after <b>${UNABLE_MAX_REENTRIES}</b> dashboard re-entries\n` +
          `🔒 Logging out — check the session / network, then restart this client.`
        );
        updateUserStatus(u, "idle");
        __abortAll = true;
        window.__autoBookingLoginActive = false;
        if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
        chrome.storage.local.remove(["activeAutomationUser"]);
        sessionStorage.removeItem("ab-cycling-state");                          // don't auto-resume after logout
        sessionStorage.removeItem("__abUnableCount"); // #49 reset persisted counter on logout
        sessionStorage.setItem("__abSevereLogout", "Unable to load — 3 re-entries failed"); // dashboard signs out
        window.__unableToLoadHandling = false;
        window.location.href = window.location.origin + "/en-US/";
        return;
      }

      // Attempts 1..3: immediate dashboard re-entry (auto-resume cycling).
      trackEvent(EVENT_TYPES.ERROR, `Unable to load — dashboard re-entry ${reentry}/${UNABLE_MAX_REENTRIES}, ${roundsCompleted} rounds`, u);
      sendTelegramNotification("rate",
        `⚠️ <b>UNABLE TO LOAD</b>\n\n` +
        `👤 <b>User:</b> ${u}\n` +
        `🔁 Ran <b>${roundsCompleted}</b> rounds before error\n` +
        `🔄 Dashboard re-entry <b>${reentry}/${UNABLE_MAX_REENTRIES}</b> → retrying`
      );

      // Save cycling state for auto-resume (fresh round count)
      const state = {
        active: true,
        round: 0,  // fresh start
        startDate: document.getElementById("ab-start-date")?.value || "",
        endDate: document.getElementById("ab-end-date")?.value || "",
        interval: document.getElementById("ab-interval")?.value || "30",
        locations: Array.from(document.querySelectorAll(".ab-loc-cb:checked")).map(cb => cb.value),
        timestamp: Date.now(),
        reentryCount: reentry,
      };
      sessionStorage.setItem("ab-cycling-state", JSON.stringify(state));

      // Navigate to dashboard — auto-click Reschedule → Continue → back to OFC/schedule
      window.__unableToLoadHandling = false;
      window.location.href = window.location.origin + "/en-US/";
    });
  }

  // Handle severe rate errors (429, Error 1015) — these are PER-IP. Logging out doesn't help
  // (re-login is on the same rate-limited IP). #49: pause at dashboard + alert to change IP.
  function handleSevereError(reason) {
    // Re-entry guard — prevent flood within the same page
    if (window.__severeErrorHandling) return;
    window.__severeErrorHandling = true;

    if (cycling.active) stopCycling(`${reason} — paused, change IP`);

    chrome.storage.local.get(["loginDetails"], (d) => {
      const u = d.loginDetails?.username || "";
      log(`Severe rate error: ${reason} — pausing at dashboard, alerting to change IP (NO logout)`);
      trackEvent(EVENT_TYPES.ERROR, `Severe: ${reason} — paused at dashboard, change IP (no logout)`, u);
      sendTelegramNotification("error",
        `🚫 <b>RATE LIMITED — CHANGE IP</b>\n\n` +
        `👤 <b>User:</b> ${u}\n` +
        `⚠️ ${reason}\n` +
        `🔁 Ran <b>${cycling.round}</b> rounds\n` +
        `🌐 This IP is being rate-limited (per-IP block). <b>Change the IP address</b> (different network / proxy), then restart this client.\n` +
        `⏸️ Paused at dashboard — staying logged in (no logout).`
      );
      updateUserStatus(u, "rate_limited");

      __abortAll = true;
      window.__autoBookingLoginActive = false;
      if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
      chrome.storage.local.remove(["activeAutomationUser"]); // stop auto-cycling on the next page
      sessionStorage.removeItem("ab-cycling-state");          // don't auto-resume
      sessionStorage.removeItem("__abSevereLogout");          // ensure we do NOT sign out
      sessionStorage.removeItem("__abSevereCount");
      sessionStorage.setItem("__abPausedRateLimit", reason);  // #49 pause at dashboard (no continue, no logout)

      // Get off the rate-limited page to the dashboard; stay logged in, paused.
      window.location.href = window.location.origin + "/en-US/";
    });
  }

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
            const u = d.loginDetails?.username || "";
            trackEvent(EVENT_TYPES.ERROR, "401 session expired", u);
            updateUserStatus(u, "session_expired");
            sendTelegramNotification("error", `⚠️ <b>401 SESSION EXPIRED</b>\n\n👤 <b>User:</b> ${u}\n🔄 Will attempt auto re-login`);
          });
        }
        if (m.attributeName === "data-429") {
          log("429 rate limit detected via DOM bridge");
          __rateLimited429 = true;
          chrome.storage.local.get(["loginDetails"], (d) => {
            const u = d.loginDetails?.username || "";
            trackEvent(EVENT_TYPES.ERROR, "429 rate limited", u);
            updateUserStatus(u, "rate_limited");
            sendTelegramNotification("rate", `🟠 <b>429 RATE LIMITED</b>\n\n👤 <b>User:</b> ${u}\n⏳ Exponential backoff activated`);
          });
        }
      }
    });
    observer.observe(marker, { attributes: true });
  }

  function isCloudflareBlocked() {
    // Only detect actual Cloudflare block pages — not normal pages with stray keyword matches
    // Real CF block pages have specific elements and title patterns
    const title = (document.title || "").toLowerCase();
    if (title.includes("attention required") || title.includes("access denied") || title.includes("error 1015")) {
      log("Cloudflare block detected via page title: " + document.title);
      return true;
    }
    // Cloudflare block pages have specific class/id markers
    const cfMarker = document.querySelector("#cf-error-details, .cf-error-overview, .cf-wrapper, #challenge-running, #challenge-form");
    if (cfMarker) {
      log("Cloudflare block detected via CF DOM element: " + cfMarker.id || cfMarker.className);
      return true;
    }
    // Check h1/h2 only (not full body text — avoids false positives from extension UI or page content)
    const heading = document.querySelector("h1, h2");
    if (heading) {
      const hText = heading.textContent.toLowerCase();
      if (hText.includes("sorry, you have been blocked") || hText.includes("error 1015") || hText.includes("you are being rate limited")) {
        log("Cloudflare block detected via heading: " + heading.textContent);
        return true;
      }
    }
    // Detect raw JSON error response from Cloudflare (no HTML, just JSON text on page)
    // e.g. {"error_code":1015,"error_name":"rate_limited","cloudflare_error":true,...}
    const bodyText = (document.body?.textContent || "").trim();
    if (bodyText.startsWith("{") && bodyText.length < 2000) {
      try {
        const json = JSON.parse(bodyText);
        if (json.cloudflare_error || json.error_code === 1015 || json.error_name === "rate_limited") {
          log("Cloudflare block detected via JSON response: error_code=" + json.error_code);
          return true;
        }
      } catch {}
    }
    return false;
  }

  function isSessionExpired() {
    if (__session401Detected) {
      log("isSessionExpired: true — __session401Detected flag set");
      return true;
    }
    if (document.querySelector(".session-expired")) {
      log("isSessionExpired: true — .session-expired element found");
      return true;
    }
    const title = (document.title || "").toLowerCase();
    if (title.includes("401") || title.includes("unauthorized")) {
      log("isSessionExpired: true — page title contains 401/unauthorized: " + document.title);
      return true;
    }
    // Only check error-specific containers — not generic h1/h2 which match normal page headings
    const errorEl = document.querySelector(".alert-danger, .error-message, .error-content, #error-page");
    if (errorEl) {
      const text = (errorEl.textContent || "").toLowerCase();
      if (text.includes("401") || text.includes("unauthorized") || text.includes("session expired") || text.includes("session has expired")) {
        log("isSessionExpired: true — error element contains: " + text.substring(0, 100));
        return true;
      }
    }
    return false;
  }

  function startKeepAlive() {
    stopKeepAlive();
    cycling.lastRefresh = Date.now();
    cycling.keepAliveFailCount = 0;
    SESSION_REFRESH_MS = randomRefreshMs();
    log(`Keep-alive started — next ping in ${Math.round(SESSION_REFRESH_MS / 1000)}s (${(SESSION_REFRESH_MS / 60000).toFixed(1)}min)`);
    cycling.keepAliveTimer = setInterval(async () => {
      if (!cycling.active) return;
      const elapsed = Date.now() - cycling.lastRefresh;
      const thresholdSec = Math.round(SESSION_REFRESH_MS / 1000);
      if (elapsed < SESSION_REFRESH_MS) {
        log(`Keep-alive check: ${Math.round(elapsed / 1000)}s elapsed, threshold ${thresholdSec}s — not yet`);
        return;
      }

      log(`Keep-alive triggered at ${Math.round(elapsed / 1000)}s — sending background fetch...`);
      chrome.storage.local.get(["loginDetails"], (d) => {
        const u = d.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.SESSION, `Keep-alive fetch at ${Math.round(elapsed / 1000)}s (threshold was ${thresholdSec}s)`, u);
      });

      try {
        const resp = await fetch(window.location.origin + "/en-US/", {
          credentials: "include",
          cache: "no-store",
          headers: { "Accept": "text/html" },
        });

        if (resp.ok) {
          log(`Keep-alive fetch OK (${resp.status}) — session alive`);
          cycling.keepAliveFailCount = 0;
          cycling.lastRefresh = Date.now();
          SESSION_REFRESH_MS = randomRefreshMs();
          log(`Next keep-alive in ${Math.round(SESSION_REFRESH_MS / 1000)}s (${(SESSION_REFRESH_MS / 60000).toFixed(1)}min)`);
        } else if (resp.status === 401 || resp.status === 403) {
          cycling.keepAliveFailCount++;
          log(`Keep-alive fetch got ${resp.status} — fail count: ${cycling.keepAliveFailCount}/2`);
          chrome.storage.local.get(["loginDetails"], (d) => {
            const u = d.loginDetails?.username || "";
            trackEvent(EVENT_TYPES.SESSION, `Keep-alive got ${resp.status} (attempt ${cycling.keepAliveFailCount}/2)`, u);
          });
          if (cycling.keepAliveFailCount >= 2) {
            log("Keep-alive: 2 consecutive failures — falling back to full page reload");
            chrome.storage.local.get(["loginDetails"], (d) => {
              const u = d.loginDetails?.username || "";
              trackEvent(EVENT_TYPES.SESSION, "Keep-alive fallback: full page reload after 2 failed fetches", u);
            });
            saveReloginState();
            window.location.reload();
          }
        } else if (resp.status === 429) {
          log(`Keep-alive fetch got 429 (rate limited) — skipping reload, will retry next cycle`);
          cycling.lastRefresh = Date.now();
          SESSION_REFRESH_MS = randomRefreshMs();
        } else {
          log(`Keep-alive fetch got unexpected ${resp.status} — treating as OK`);
          cycling.lastRefresh = Date.now();
          SESSION_REFRESH_MS = randomRefreshMs();
        }
      } catch (err) {
        cycling.keepAliveFailCount++;
        log(`Keep-alive fetch failed: ${err.message} — fail count: ${cycling.keepAliveFailCount}/2`);
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.ERROR, `Keep-alive fetch error: ${err.message} (attempt ${cycling.keepAliveFailCount}/2)`, u);
          sendTelegramNotification("error", `⚠️ <b>KEEP-ALIVE FAILED</b>\n\n👤 <b>User:</b> ${u}\n❌ ${err.message}\n🔁 Attempt ${cycling.keepAliveFailCount}/2`);
        });
        if (cycling.keepAliveFailCount >= 2) {
          log("Keep-alive: 2 consecutive fetch errors — falling back to full page reload");
          saveReloginState();
          window.location.reload();
        }
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
      // Only valid if saved within last 10 minutes (cooldown can be up to 300s + navigation time)
      if (Date.now() - state.timestamp > 10 * 60 * 1000) {
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

  // ─── PARALLEL SCAN (A2) — fetch all cities at once via captured template ──

  // Extract the JSON object from a response that may have leading whitespace/markup.
  function extractScheduleJson(text) {
    if (!text) return null;
    let i = text.indexOf('{"ScheduleDays');
    if (i < 0) i = text.indexOf("{");
    if (i < 0) return null;
    try { return JSON.parse(text.slice(i)); } catch (e) { return null; }
  }

  // Detect Cloudflare challenge page ("Just a moment" / Turnstile) in a response body.
  function isCfChallengeBody(text) {
    if (!text) return false;
    const t = text.slice(0, 1500).toLowerCase();
    return t.includes("just a moment") ||
           t.includes("challenges.cloudflare.com") ||
           t.includes("cf-challenge") ||
           t.includes("/cdn-cgi/challenge-platform") ||
           (t.includes("<!doctype html") && t.includes("turnstile"));
  }

  // Cloudflare visible challenge hit during cycling → alert operator (remote-desktop solve), reload OFC to show checkbox, auto-resume after solve.
  async function handleCloudflareChallenge(activeUser) {
    if (window.__cfChallengeHandling) return;
    window.__cfChallengeHandling = true;
    log("Cloudflare challenge detected during scan — alerting operator for remote solve");
    if (cycling.active) stopCycling("Cloudflare challenge — awaiting manual solve");

    const stored = await new Promise((r) => chrome.storage.local.get(["__supabase_device_name", "loginDetails"], r));
    const device = stored.__supabase_device_name || "this device";
    const u = activeUser || stored.loginDetails?.username || "";
    trackEvent(EVENT_TYPES.ERROR, "Cloudflare challenge — remote solve needed", u);
    sendTelegramNotification("rate",
      `🛡️ <b>CLOUDFLARE CHALLENGE</b>\n\n` +
      `👤 <b>User:</b> ${u}\n` +
      `🖥️ <b>Device:</b> ${device}\n` +
      `⚠️ "Verify you are human" checkbox blocking the bot.\n` +
      `🔧 <b>Remote into ${device}</b> (Chrome Remote Desktop) and click the checkbox.\n` +
      `▶️ Bot auto-resumes once solved.`
    );

    // Save cycling state so it auto-resumes after the page passes the challenge
    const state = {
      active: true, round: 0,
      startDate: document.getElementById("ab-start-date")?.value || "",
      endDate: document.getElementById("ab-end-date")?.value || "",
      interval: document.getElementById("ab-interval")?.value || "30",
      locations: Array.from(document.querySelectorAll(".ab-loc-cb:checked")).map((cb) => cb.value),
      timestamp: Date.now(),
    };
    sessionStorage.setItem("ab-cycling-state", JSON.stringify(state));

    setStatus("🛡️ Cloudflare challenge — solve the checkbox (remote). Reloading to show it...");
    await sleep(1500);
    // Reload the OFC page so the visible Turnstile checkbox renders for the operator to click.
    window.__cfChallengeHandling = false;
    window.location.reload();
  }

  // Fire all cities in parallel using the captured template. Detection only.
  // Returns { postId: { ok, name, dates:[], status, ms, hasError, error } } or null if no template.
  async function parallelScan(postIds) {
    if (!scheduleTemplate || !scheduleTemplate.url || !scheduleTemplate.body) {
      log("[parallel] no template captured yet — cannot scan");
      return null;
    }
    const sel = document.getElementById("post_select");
    const nameMap = {};
    if (sel) Array.from(sel.options).forEach((o) => { if (o.value) nameMap[o.value] = (o.text || "").trim(); });
    if (!postIds || !postIds.length) postIds = Object.keys(nameMap);

    const baseHeaders = {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    };
    // Reuse the session's trace-id (Application Insights) from the captured request so
    // our requests look like the site's own; fresh span id per request.
    const randHex = (n) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)]; return s; };
    let traceId = randHex(32);
    const tp = scheduleTemplate.headers && (scheduleTemplate.headers.traceparent || scheduleTemplate.headers.Traceparent);
    if (tp) { const m = String(tp).match(/^00-([0-9a-f]{32})-/i); if (m) traceId = m[1].toLowerCase(); }

    const eq = scheduleTemplate.body.indexOf("=");
    const baseJsonStr = scheduleTemplate.body.slice(eq + 1);

    const results = {};
    const scanStart = Date.now();
    const tasks = postIds.map((pid, idx) => (async () => {
      await sleep(idx * PARALLEL_STAGGER_MS); // stagger to avoid burst-block
      const name = nameMap[pid] || pid;
      let body;
      try {
        const obj = JSON.parse(baseJsonStr);
        obj.postId = pid;
        obj.scheduleDayId = "";
        obj.scheduleEntryId = "";
        body = "parameters=" + JSON.stringify(obj);
      } catch (e) { results[pid] = { ok: false, name, error: "body build: " + e.message }; return; }
      const url = scheduleTemplate.url.replace(/cacheString=\d+/, "cacheString=" + Date.now());
      // Fresh span id per request — mimic the site's tracing headers
      const span = randHex(16);
      const headers = { ...baseHeaders, "Request-Id": `|${traceId}.${span}`, "traceparent": `00-${traceId}-${span}-01` };
      const t0 = Date.now();
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), PARALLEL_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(url, { method: "POST", headers, body, credentials: "include", signal: ctrl.signal });
        clearTimeout(killer);
        const text = await resp.text();
        const challenge = isCfChallengeBody(text);
        const json = extractScheduleJson(text);
        const dates = (json && Array.isArray(json.ScheduleDays)) ? json.ScheduleDays.map((d) => d.Date) : [];
        results[pid] = { ok: resp.status === 200 && !!json, name, status: resp.status, dates, ms: Date.now() - t0, hasError: json ? json.HasError : null, challenge };
      } catch (e) {
        clearTimeout(killer);
        const timedOut = e.name === "AbortError";
        results[pid] = { ok: false, name, error: timedOut ? "timeout" : e.message, ms: Date.now() - t0, timedOut };
      }
    })());
    await Promise.all(tasks);
    const summary = Object.values(results).map((r) => `${r.name}:${r.ok ? (r.dates.length + "d") : ("ERR " + (r.error || r.status))}`);
    log(`[parallel] scan done in ${Date.now() - scanStart}ms → ${summary.join(", ")}`);
    return results;
  }
  // Expose for manual testing in the TEST build (call from booking panel button).
  if (TEST_MODE) window.__parallelScan = parallelScan;

  // ─── FAST-GRAB BOOKING (#36) — event-driven, drive site JS, ~2-3s ──
  // On first in-range slot from the parallel scan: switch to that city, then react on the
  // site's own data-arrival events (no waits/polls): days → pick date → times → pick time → submit.
  // Dry-run when TEST_FORCE_NO_SUBMIT (stops before final submit, logs WOULD BOOK).
  let __fastGrabbing = false;
  // Slots tried hard (full retry budget) but un-bookable — skip for a while so we don't
  // re-grab the same un-clickable date every round. key `${cityValue}|${dateStr}` → expiry ms.
  const __deadSlots = {};
  const DEAD_SLOT_TTL_MS = 15 * 60 * 1000; // 15 min
  function isDeadSlot(cityValue, dateStr) {
    const k = `${cityValue}|${dateStr}`;
    const exp = __deadSlots[k];
    if (!exp) return false;
    if (Date.now() > exp) { delete __deadSlots[k]; return false; }
    return true;
  }
  function markDeadSlot(cityValue, dateStr) { __deadSlots[`${cityValue}|${dateStr}`] = Date.now() + DEAD_SLOT_TTL_MS; }

  // Fast-grab with retry loop (#41): re-poke the same city to reload a slow calendar,
  // up to MAX_ATTEMPTS. Exit to normal scanning when no in-range date is left, slot taken,
  // or attempts exhausted (mark dead). Resume cycling on any non-booked exit.
  async function fastGrabBooking(cityValue, cityName, dateStr, alreadyOnCity = false) {
    if (__fastGrabbing) return;
    __fastGrabbing = true;
    const u = await new Promise((r) => chrome.storage.local.get(["loginDetails"], (d) => r(d.loginDetails?.username || "")));
    const t0 = Date.now();
    log(`[fastgrab] SLOT in range → ${cityName} ${dateStr} — grabbing`);
    if (cycling.active) stopCycling("Slot found — grabbing");
    trackEvent(EVENT_TYPES.SLOT_FOUND, `Slot in range: ${cityName} ${dateStr} — fast-grab started`, u);
    sendTelegramNotification("slot",
      `🎯 <b>SLOT FOUND — GRABBING</b>\n\n👤 <b>User:</b> ${u}\n📍 <b>${cityName}</b>\n📅 <b>${dateStr}</b>\n⚡ Booking now...`);

    const MAX_ATTEMPTS = 5;
    const CAL_WAIT_MS = 10000;  // wait for calendar to render
    const TIME_WAIT_MS = 12000; // wait for time slots to load
    const startDate = document.getElementById("ab-start-date")?.value || "";
    const endDate = document.getElementById("ab-end-date")?.value || "";
    let booked = false;
    let resumeScan = false; // exit: no in-range date / slot taken → back to scanning
    let lastTriedDate = dateStr;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (__abortAll) break;
        log(`[fastgrab] attempt ${attempt}/${MAX_ATTEMPTS} — ${cityName}`);

        // (Re)select the city to (re)load its calendar — except attempt 1 of the
        // sequential path, which is already on the city with the calendar up.
        let targetDate = dateStr;
        if (!(attempt === 1 && alreadyOnCity)) {
          const select = document.getElementById("post_select");
          if (!select) { sendTelegramNotification("error", `⚠️ <b>GRAB FAILED</b>\n\n👤 ${u}\n${cityName}\n❌ Dropdown missing`); break; }
          select.value = cityValue;
          const daysPromise = waitForScheduleData(CAL_WAIT_MS + 5000);
          select.dispatchEvent(new Event("change", { bubbles: true }));
          const daysData = await daysPromise;
          // Re-check this city's in-range dates from the fresh data.
          const fresh = (daysData && Array.isArray(daysData.ScheduleDays)) ? daysData.ScheduleDays.map((d) => d.Date) : [];
          const inRange = fresh.filter((d) => isDateInRange(d, startDate, endDate)).sort();
          if (!inRange.length) { resumeScan = true; log(`[fastgrab] no in-range date left at ${cityName} — back to scanning`); break; }
          targetDate = inRange[0];
        } else {
          await sleep(500); // already on city — small settle
        }
        lastTriedDate = targetDate;

        // Wait (up to 10s) for the calendar + click the date.
        const picked = await selectDateInCalendar(new Date(targetDate + "T00:00:00"), CAL_WAIT_MS);
        if (!picked) { log(`[fastgrab] calendar/date not ready (attempt ${attempt}) — retrying`); continue; }

        // Wait (up to 12s) for time slots + select first; submit must be enabled.
        const timeReady = await waitForTimeSlotAndSelect(TIME_WAIT_MS);
        if (!timeReady) { log(`[fastgrab] time slots not ready (attempt ${attempt}) — retrying`); continue; }
        const pickedTime = getSelectedTimeText();

        // Dry-run stop.
        if (TEST_MODE && TEST_FORCE_NO_SUBMIT) {
          const ms = Date.now() - t0;
          log(`[fastgrab] DRY-RUN — would book ${cityName} ${targetDate} ${pickedTime} (reached submit in ${ms}ms, attempt ${attempt})`);
          trackEvent(EVENT_TYPES.BOOKING, `DRY-RUN would book ${cityName} ${targetDate} ${pickedTime} (${ms}ms)`, u);
          sendTelegramNotification("slot",
            `🧪 <b>WOULD BOOK (dry-run)</b>\n\n👤 ${u}\n📍 <b>${cityName}</b>\n📅 <b>${targetDate}</b>\n🕐 <b>${pickedTime || "first slot"}</b>\n⏱️ Reached submit in ${ms}ms\n⏸️ Stopped before submit (TEST_FORCE_NO_SUBMIT)`);
          booked = true; break;
        }

        // Live submit.
        const submitBtn = document.getElementById("submitbtn");
        if (!submitBtn || submitBtn.disabled) { log(`[fastgrab] submit not ready (attempt ${attempt}) — retrying`); continue; }
        submitBtn.click();
        const ms = Date.now() - t0;
        trackEvent(EVENT_TYPES.BOOKING, `Submitted ${cityName} ${targetDate} ${pickedTime} (${ms}ms)`, u);
        const outcome = await waitForBookingOutcome(15000);
        if (outcome === "confirmed" || outcome === "ofc_submitted") {
          updateUserStatus(u, "confirmed", { confirmedAt: new Date().toISOString() });
          updateSlotHistoryAction(u, cityName, targetDate, outcome === "confirmed" ? "confirmed" : "submitted");
          sendTelegramNotification("confirmed",
            `🎉 <b>VAC BOOKED!</b>\n\n👤 ${u}\n📍 <b>${cityName}</b>\n📅 <b>${targetDate}</b>\n🕐 <b>${pickedTime || "first slot"}</b>\n✅ ${outcome === "ofc_submitted" ? "OFC submitted → consular next" : "Confirmed"}\n⏱️ Booked in ${ms}ms`);
          booked = true; break;
        }
        if (outcome === "failed") {
          sendTelegramNotification("error", `⚠️ <b>BOOKING FAILED (slot taken)</b>\n\n👤 ${u}\n${cityName} ${targetDate}\n❌ Someone grabbed it first`);
          resumeScan = true; break;
        }
        // uncertain/timeout — ambiguous; alert + stop (don't blindly re-submit a maybe-booking).
        sendTelegramNotification("error", `⚠️ <b>BOOKING UNCERTAIN</b>\n\n👤 ${u}\n${cityName} ${targetDate}\n❓ No clear confirmation — check manually`);
        break;
      }

      // Exhausted attempts without booking on a still-listed date → mark dead so we don't
      // re-grab the same un-clickable slot every round.
      if (!booked && !resumeScan && !__abortAll) {
        markDeadSlot(cityValue, lastTriedDate);
        sendTelegramNotification("error", `⚠️ <b>GRAB GAVE UP</b>\n\n👤 ${u}\n${cityName} ${lastTriedDate}\n❌ Couldn't load/click after ${MAX_ATTEMPTS} tries — skipping it ${Math.round(DEAD_SLOT_TTL_MS / 60000)}min, back to scanning`);
      }
    } catch (e) {
      log("[fastgrab] error: " + e.message);
      sendTelegramNotification("error", `⚠️ <b>GRAB ERROR</b>\n\n👤 ${u}\n${cityName} ${dateStr}\n❌ ${e.message}`);
    } finally {
      __fastGrabbing = false;
    }

    // Resume hunting unless we actually booked (or were aborted).
    if (!booked && !__abortAll) {
      await sleep(2000);
      if (!cycling.active && !__fastGrabbing) {
        log("[fastgrab] resuming normal scanning");
        startCycling();
      }
    }
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
    sessionStorage.removeItem("__abPausedRateLimit"); // #49 manual start clears any rate-limit pause
    // Ensure activeAutomationUser is set when starting from OFC panel
    chrome.storage.local.get(["loginDetails", "activeAutomationUser"], (d) => {
      if (d.loginDetails?.username && !d.activeAutomationUser) {
        chrome.storage.local.set({ activeAutomationUser: d.loginDetails.username });
      }
    });
    cycling.active = true;
    cycling.round = 0;
    __parallelStartedNotified = false; // #46c re-arm "parallel started" alert for this run
    // Reset rate tracker and start periodic flush
    rateTrackerReset();
    rateTracker.flushTimer = setInterval(() => {
      if (cycling.active) rateTrackerFlush();
    }, RATE_FLUSH_INTERVAL_MS);
    const locs = Array.from(checked).map((cb) => cb.dataset.name || cb.value).join(", ");
    const startDate = document.getElementById("ab-start-date")?.value || "—";
    const endDate = document.getElementById("ab-end-date")?.value || "—";
    chrome.storage.local.get(["loginDetails"], (d) => {
      const u = d.loginDetails?.username || "";
      trackEvent(EVENT_TYPES.CYCLING, `Cycling started — locations: ${locs}`, u);
      resetUserCycleCounters(u);
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

  // Smart range expansion offer — sends Telegram with inline buttons
  // when user has cycled X+ rounds with 0 in-range slots but slots exist out of range
  // FIX: re-evaluates slot history against CURRENT DOM date range (not stale stored flags)
  async function maybeOfferRangeExpansion() {
    if (!EXPAND_OFFER_ENABLED) return; // disabled per user request
    if (!cycling.active || cycling.gracePeriod.active) return;

    const data = await new Promise((r) => {
      chrome.storage.local.get(["loginDetails", "userStatuses", "slotHistory"], r);
    });
    const u = data.loginDetails?.username;
    if (!u) return;

    const status = (data.userStatuses || {})[u] || {};
    const roundCount = status.roundCount || 0;

    // Conditions: gate on rounds first
    if (roundCount < EXPAND_OFFER_MIN_ROUNDS) return;

    // Cooldown
    const lastOffer = status.lastExpansionOfferAt ? new Date(status.lastExpansionOfferAt).getTime() : 0;
    if (Date.now() - lastOffer < EXPAND_OFFER_COOLDOWN_MS) return;

    // Read CURRENT date range from DOM (NOT stale counter)
    const curStart = document.getElementById("ab-start-date")?.value || "";
    const curEnd = document.getElementById("ab-end-date")?.value || "";

    // Re-evaluate slot history against CURRENT range
    // Dedup by (location, date) so each unique slot counts once
    const userHistory = (data.slotHistory || []).filter((e) => e.username === u);
    const seenKeys = new Set();
    let inRangeCount = 0;
    let outOfRangeCount = 0;
    const outOfRangeSlots = []; // for "nearest available" suggestion

    userHistory.forEach((e) => {
      const key = `${e.location}|${e.date}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const inR = isDateInRange(e.date, curStart, curEnd);
      if (inR) {
        inRangeCount++;
      } else {
        outOfRangeCount++;
        outOfRangeSlots.push({ location: e.location, date: e.date });
      }
    });

    // Don't offer if there are slots actually in current range
    if (inRangeCount > 0) {
      log(`Range expansion skipped: ${inRangeCount} slots actually in current range (counter was stale)`);
      return;
    }
    if (outOfRangeCount === 0) return;

    // Group out-of-range by location → earliest date per location
    const byLoc = {};
    outOfRangeSlots.forEach((s) => {
      if (!byLoc[s.location] || s.date < byLoc[s.location]) {
        byLoc[s.location] = s.date;
      }
    });
    const nearestList = Object.entries(byLoc)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, 5);

    if (nearestList.length === 0) return;

    const nearestText = nearestList.map(([loc, date]) => `• <b>${loc}:</b> ${date}`).join("\n");

    const msg =
      `⚠️ <b>NO SLOTS IN RANGE</b>\n\n` +
      `👤 <b>User:</b> ${u}\n` +
      `🔁 <b>Round:</b> ${roundCount}\n` +
      `📅 <b>Current range:</b> ${curStart || "—"} → ${curEnd || "—"}\n` +
      `✅ In range: <b>0</b>\n` +
      `⚪ Out of range: <b>${outOfRangeCount}</b>\n\n` +
      `<b>Nearest available:</b>\n${nearestText}\n\n` +
      `Expand date range?`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "+30 days", callback_data: `expand:${u}:30` },
          { text: "+60 days", callback_data: `expand:${u}:60` },
          { text: "+90 days", callback_data: `expand:${u}:90` },
        ],
        [
          { text: "✖️ Ignore", callback_data: `expand_ignore:${u}` },
        ],
      ],
    };

    sendTelegramNotification("error", msg, replyMarkup);
    setUserCounter(u, "lastExpansionOfferAt", new Date().toISOString());
    trackEvent(EVENT_TYPES.CYCLING, `Range expansion offered (round ${roundCount}, ${outOfRangeCount} out of range)`, u);
    log(`Range expansion offer sent for ${u}`);
  }

  function stopCycling(reason) {
    const roundsCompleted = cycling.round;
    cycling.active = false;
    if (cycling.timer) {
      clearTimeout(cycling.timer);
      cycling.timer = null;
    }
    // Flush final rate stats and stop timer
    if (rateTracker.flushTimer) { clearInterval(rateTracker.flushTimer); rateTracker.flushTimer = null; }
    rateTrackerFlush();
    // Reset grace period state
    cycling.gracePeriod = {
      active: false, location: null, roundsRemaining: 0,
      fastIntervalMs: GRACE_PERIOD_INTERVAL_MS, missedDate: null,
    };
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

  // Cache the latest time-slot entries feed (vST) so we can report the real
  // booked time (ScheduleEntries[].Time = "09:00") instead of the radio's value/index.
  let __lastScheduleEntries = null;
  addEventListener("vSCP", (e) => {
    if (e.detail && e.detail.resource === "vST" && e.detail.data && Array.isArray(e.detail.data.ScheduleEntries)) {
      __lastScheduleEntries = e.detail.data.ScheduleEntries;
    }
  });

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

  async function selectDateInCalendar(dateObj, timeout = 10000) {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const day = dateObj.getDate();
    const start = Date.now();
    // Poll up to `timeout` for the datepicker to render + the day to be clickable.
    // Handles a slow calendar under heavy traffic; returns false only if the day is
    // still not clickable after the full window (e.g. a genuinely disabled date).
    while (Date.now() - start < timeout) {
      const yearSel = document.querySelector(".ui-datepicker-year");
      const monthSel = document.querySelector(".ui-datepicker-month");
      if (yearSel && monthSel) {
        let navigated = false;
        if (yearSel.value !== String(year)) {
          yearSel.value = String(year);
          yearSel.dispatchEvent(new Event("change", { bubbles: true }));
          navigated = true;
        }
        if (monthSel.value !== String(month)) {
          monthSel.value = String(month);
          monthSel.dispatchEvent(new Event("change", { bubbles: true }));
          navigated = true;
        }
        if (navigated) { await sleep(400); continue; } // let the month re-render
        const dateLink = document.querySelector(`.ui-datepicker-calendar a[data-date="${day}"]`);
        if (dateLink) {
          dateLink.click();
          log(`Selected date: ${year}-${month + 1}-${day}`);
          return true;
        }
      }
      await sleep(300);
    }
    log(`Date not clickable after ${timeout}ms: ${year}-${month + 1}-${day}`);
    return false;
  }

  // After submit click, detect outcome:
  // - "confirmed":     URL = /appointment-confirmation (final success — interview submitted)
  // - "ofc_submitted": URL transitioned from /ofc-schedule → /schedule (mid-flow success)
  // - "failed":        error alert/text on page (slot taken, no longer available, etc.)
  // - "timeout":       no clear signal within timeout window
  async function waitForBookingOutcome(timeout = 15000) {
    const start = Date.now();
    const originPath = window.location.pathname.toLowerCase();
    const wasOnOfc = originPath.includes("/ofc-schedule");
    const wasOnInterview = !wasOnOfc && originPath.includes("/schedule");

    const failPatterns = [
      /no\s+longer\s+available/i,
      /slot\s+(is\s+)?(no\s+longer\s+|not\s+)?available/i,
      /already\s+(been\s+)?booked/i,
      /please\s+select\s+(a\s+)?different/i,
      /unable\s+to\s+(book|schedule|reserve)/i,
      /try\s+again/i,
      /booking\s+failed/i,
      /appointment\s+could\s+not\s+be\s+(scheduled|booked)/i,
      /someone\s+else\s+(has\s+)?booked/i,
    ];

    while (Date.now() - start < timeout) {
      const currentPath = window.location.pathname.toLowerCase();

      // FINAL success: appointment-confirmation page
      if (currentPath.includes("appointment-confirmation")) {
        return "confirmed";
      }

      // MID-FLOW success: OFC submitted, page navigating to /schedule/ (interview)
      // OFC URL: /en-US/ofc-schedule/    Interview URL: /en-US/schedule/
      if (wasOnOfc && currentPath.includes("/schedule") && !currentPath.includes("ofc-schedule")) {
        return "ofc_submitted";
      }

      // Check for known error containers
      const errorEls = document.querySelectorAll(
        ".alert-danger, .error-message, .error-content, .swal2-popup, .swal2-html-container, .toast-error"
      );
      for (const el of errorEls) {
        const txt = (el.textContent || "").trim();
        if (!txt) continue;
        for (const re of failPatterns) {
          if (re.test(txt)) return "failed";
        }
      }

      // Generic page-wide pattern check (last resort)
      const bodyTxt = (document.body?.textContent || "").substring(0, 5000);
      for (const re of failPatterns) {
        if (re.test(bodyTxt)) return "failed";
      }

      await sleep(500);
    }
    return "timeout";
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

  // Real time-of-day of the selected slot (e.g. "09:00").
  // Prefer the site's own time-slot feed (ScheduleEntries[].Time), mapping the
  // selected radio's value (= entry Num) to its Time. Falls back to scanning the
  // row text for an HH:MM pattern. (Radio value alone is just the slot number.)
  function getSelectedTimeText() {
    const radio = document.querySelector('#time_select input[type="radio"]:checked')
      || document.querySelector('#time_select input[type="radio"]');
    if (__lastScheduleEntries && __lastScheduleEntries.length) {
      if (radio && radio.value) {
        const hit = __lastScheduleEntries.find((en) => String(en.Num) === String(radio.value));
        if (hit && hit.Time) return String(hit.Time);
      }
      if (__lastScheduleEntries[0] && __lastScheduleEntries[0].Time) return String(__lastScheduleEntries[0].Time);
    }
    if (!radio) return "";
    const cands = [
      radio.getAttribute("aria-label"),
      radio.id ? document.querySelector(`#time_select label[for="${radio.id}"]`)?.textContent : "",
      radio.closest("tr,label,td,div")?.textContent,
    ].filter(Boolean);
    for (const c of cands) {
      const m = String(c).match(/\b([01]?\d|2[0-3]):[0-5]\d\s*(?:[AaPp]\.?[Mm]\.?)?/);
      if (m) return m[0].replace(/\s+/g, " ").trim();
    }
    return (cands[0] || "").trim().slice(0, 20);
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

  // Weighted random delay — mimics human attention patterns
  function humanDelay() {
    const r = Math.random();
    if (r < 0.60) return 4 + Math.random() * 4;       // 60%: 4-8s (normal)
    if (r < 0.85) return 8 + Math.random() * 7;       // 25%: 8-15s (reading)
    return 15 + Math.random() * 10;                    // 15%: 15-25s (distracted)
  }

  // Human-activity simulation removed (#45) — synthetic events (isTrusted=false) didn't
  // fool Cloudflare and added log noise + a few seconds delay between checks.

  // Track when next idle gap / long break should trigger
  if (!cycling.nextIdleAt) cycling.nextIdleAt = 0;
  if (!cycling.nextBreakAt) cycling.nextBreakAt = 0;

  async function runCycleLoop() {
    if (!cycling.active || __abortAll) return;
    if (await checkStopSignal()) return;

    cycling.round++;
    cycling.lastRefresh = Date.now();

    // Increment per-user round counter
    chrome.storage.local.get(["loginDetails"], (d) => {
      const u = d.loginDetails?.username || "";
      if (u) incrementUserCounter(u, "roundCount", 1);
    });

    // Schedule idle gap and long break thresholds on first round
    if (cycling.nextIdleAt === 0) cycling.nextIdleAt = cycling.round + 4 + Math.floor(Math.random() * 5);   // 4-8 rounds
    if (cycling.nextBreakAt === 0) cycling.nextBreakAt = cycling.round + 15 + Math.floor(Math.random() * 11); // 15-25 rounds

    // Skip idle gap + long break during grace period (don't waste recovery window)
    // DISABLE_HUMAN_PAUSES: idle/break caused cold-session 403 after pauses; removed in parallel build.
    // Steady ~45s round wait keeps rate low without going cold.
    if (!cycling.gracePeriod.active && !DISABLE_HUMAN_PAUSES) {
    // Layer 2: Idle gap (30-90s every 4-8 rounds)
    if (cycling.round >= cycling.nextIdleAt) {
      const idleSec = 30 + Math.floor(Math.random() * 61);
      log(`Idle gap: pausing ${idleSec}s at round ${cycling.round}`);
      for (let s = idleSec; s > 0; s--) {
        if (!cycling.active || __abortAll) return;
        if (await checkStopSignal()) return;
        setStatus(`Idle pause ${s}s (human-like)...`);
        await sleep(1000);
      }
      cycling.nextIdleAt = cycling.round + 4 + Math.floor(Math.random() * 5);
    }

    // Layer 3: Long break (2-5 min every 15-25 rounds)
    if (cycling.round >= cycling.nextBreakAt) {
      const breakSec = 120 + Math.floor(Math.random() * 181);
      log(`Long break: pausing ${breakSec}s at round ${cycling.round}`);
      chrome.storage.local.get(["loginDetails"], (d) => {
        const u = d.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.CYCLING, `Long break ${breakSec}s at round ${cycling.round} (anti-detection)`, u);
      });
      for (let s = breakSec; s > 0; s--) {
        if (!cycling.active || __abortAll) return;
        if (await checkStopSignal()) return;
        const m = Math.floor(s / 60);
        const r = s % 60;
        setStatus(`Taking a break ${m}m ${r}s...`);
        await sleep(1000);
      }
      cycling.nextBreakAt = cycling.round + 15 + Math.floor(Math.random() * 11);
    }
    } // end !grace skip

    const startDate = document.getElementById("ab-start-date")?.value || "";
    const endDate = document.getElementById("ab-end-date")?.value || "";
    const interval =
      parseInt(document.getElementById("ab-interval")?.value || "30") * 1000;

    // On first round, wait for page to be fully ready (no "Loading..." state)
    if (cycling.round === 1) {
      let loadWait = 0;
      while (loadWait < 20) {
        const calText = document.querySelector(".col-sm-8, .atlas_section, #page_form")?.textContent || "";
        if (!calText.includes("Loading")) break;
        log(`Waiting for page to finish loading... (${loadWait + 1}/20)`);
        await sleep(500);
        loadWait++;
      }
      log("Page ready — starting first cycle");
    }

    const allChecked = document.querySelectorAll(".ab-loc-cb:checked");
    let locations = Array.from(allChecked).map((cb) => ({
      value: cb.value,
      name: cb.dataset.name,
    }));

    // Grace period: focus only on missed location, skip shuffle
    if (cycling.gracePeriod.active) {
      const graceLoc = locations.find((l) => l.name === cycling.gracePeriod.location);
      if (graceLoc) {
        locations = [graceLoc];
        setCycleInfo(`Round ${cycling.round} · 🔥 Grace ${cycling.gracePeriod.roundsRemaining}/${GRACE_PERIOD_ROUNDS} on ${graceLoc.name}`);
      } else {
        // Location no longer checked — exit grace period
        log("Grace period location not selected — exiting grace");
        cycling.gracePeriod.active = false;
      }
    }

    if (!cycling.gracePeriod.active) {
      // Shuffle locations each round (break sequential pattern)
      for (let i = locations.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [locations[i], locations[j]] = [locations[j], locations[i]];
      }
      setCycleInfo(`Round ${cycling.round}`);
    }

    // ── PARALLEL ROUND (A3) — replaces sequential per-city loop once template captured ──
    // Detection only. No booking (A4 adds in-range match + alerts). Falls back to sequential on failure.
    // Bootstrap fast-start (#38): remember if a template already existed this round.
    // If not (very first round), the sequential sweep below stops after the FIRST city
    // captures the template, so we jump to parallel next round instead of checking all.
    const hadTemplateAtStart = !!scheduleTemplate;
    let didParallel = false;
    // #46 adaptive: after a parallel tarpit, do a short sequential probe (2 checks, escalating)
    // before re-trying parallel; reset the probe size the moment parallel succeeds.
    if (USE_PARALLEL_SCAN && scheduleTemplate && !cycling.gracePeriod.active && __seqProbeChecks <= 0 && Date.now() >= __parallelBenchUntil) {
      // Rotating batch: scan only the next PARALLEL_BATCH_SIZE cities from the STABLE selected list.
      // Keeps max 2 concurrent (fast, no tarpit, low rate); covers all selected over successive rounds.
      const stable = Array.from(document.querySelectorAll(".ab-loc-cb:checked")).map((cb) => ({ value: cb.value, name: cb.dataset.name }));
      const batch = [];
      const n = Math.min(PARALLEL_BATCH_SIZE, stable.length);
      for (let k = 0; k < n; k++) batch.push(stable[(__scanCursor + k) % stable.length]);
      __scanCursor = stable.length ? (__scanCursor + n) % stable.length : 0;
      setStatus(`⚡ Parallel scanning ${batch.map((b) => b.name).join(", ")}...`);
      if (!__parallelStartedNotified) {
        __parallelStartedNotified = true;
        chrome.storage.local.get(["loginDetails"], (d) => sendTelegramNotification("rate",
          `▶️ <b>PARALLEL STARTED</b>\n\n👤 ${d.loginDetails?.username || ""}\n⚡ Fast "2-at-once" scanning is now running.`));
      }
      const res = await parallelScan(batch.map((l) => l.value));
      if (!cycling.active || __abortAll) return;
      if (!res) {
        log("[parallel] no result — falling back to sequential this round");
      } else {
        let anyErr = false, any429 = false, anyChallenge = false, anyTimeout = false;
        let grabCity = null, grabDate = null; // first in-range hit
        const found = [];
        for (const pid of Object.keys(res)) {
          const r = res[pid];
          rateTrackerRecord(r.name, r.ok, (r.ms || 0) / 1000);
          if (r.challenge) anyChallenge = true;
          if (!r.ok) {
            anyErr = true;
            if (r.status === 429) any429 = true;
            if (r.timedOut) anyTimeout = true;
            rateTrackerRecordError(r.challenge ? "cf_challenge" : (r.status === 429 ? "429" : "parallel_err"));
            log(`[parallel] ${r.name}: ERROR ${r.challenge ? "CF-CHALLENGE" : (r.error || r.status)}`);
          } else if (r.dates.length) {
            found.push(`${r.name}(${r.dates.length})`);
            log(`[parallel] ${r.name}: ${r.dates.length} date(s) → ${r.dates.slice(0, 5).join(", ")}`);
            sendSlotsOverview(r.name, r.dates, startDate, endDate); // availability ping — every parallel round
            // First in-range date wins (user choice: grab first detected)
            if (!grabCity) {
              const inRange = r.dates.filter((d) => isDateInRange(d, startDate, endDate) && !isDeadSlot(pid, d)).sort();
              if (inRange.length) { grabCity = { value: pid, name: r.name }; grabDate = inRange[0]; }
            }
          } else {
            log(`[parallel] No slots at ${r.name}`);
          }
        }
        // SLOT IN RANGE → fast-grab booking (event-driven). Overrides everything else.
        if (grabCity) { await fastGrabBooking(grabCity.value, grabCity.name, grabDate); return; }
        // Cloudflare visible challenge → alert operator for remote-desktop solve, then auto-resume
        if (anyChallenge) { await handleCloudflareChallenge(); return; }
        if (any429) { handleSevereError("429 Rate Limited (parallel)"); return; }
        if (anyErr) {
          if (anyTimeout) {
            __parallelTimeoutStreak++;
            if (__parallelTimeoutStreak >= MAX_PARALLEL_STRIKES) {
              // Sustained tarpit — stop wasting 12s/round re-probing a dead parallel. Bench it.
              __parallelBenchUntil = Date.now() + PARALLEL_BENCH_MS;
              __seqProbeChecks = 0; // full sequential sweeps while benched
              const benchMin = Math.round(PARALLEL_BENCH_MS / 60000);
              log(`[parallel] ${__parallelTimeoutStreak} timeouts in a row — benching parallel ${benchMin}min, sequential only`);
              if (!__parallelBenchNotified) {
                __parallelBenchNotified = true;
                chrome.storage.local.get(["loginDetails"], (d) => sendTelegramNotification("rate",
                  `⏸️ <b>PARALLEL PAUSED</b>\n\n👤 ${d.loginDetails?.username || ""}\n🐢 Fast "2-at-once" scan timed out ${MAX_PARALLEL_STRIKES}× in a row — switching to steady one-at-a-time for ${benchMin} min.`));
              }
            } else {
              __seqProbeChecks = __seqBackoff;
              log(`[parallel] tarpit (timeout #${__parallelTimeoutStreak}) — sequential probe of ${__seqProbeChecks} check(s), then retry parallel`);
              __seqBackoff = Math.min(__seqBackoff + 2, SEQ_PROBE_MAX); // escalate if it keeps jamming
            }
          } else {
            log("[parallel] some requests failed — falling back to sequential this round");
          }
        } else {
          didParallel = true;
          __seqBackoff = SEQ_PROBE_BASE;     // parallel healthy → reset probe size to base
          __parallelTimeoutStreak = 0;       // #46b parallel recovered → clear strikes + bench
          __parallelBenchUntil = 0;
          if (__parallelBenchNotified) {
            __parallelBenchNotified = false;
            chrome.storage.local.get(["loginDetails"], (d) => sendTelegramNotification("rate",
              `▶️ <b>PARALLEL RESUMED</b>\n\n👤 ${d.loginDetails?.username || ""}\n⚡ Fast "2-at-once" scan working again — back to normal speed.`));
          }
          setStatus(`⚡ Parallel done — ${found.length ? "SLOTS: " + found.join(", ") : "no slots"} — ${rateTrackerGetRate()} req/min`);
        }
      }
    }

    // #46 probe mode: cap the sweep to __seqProbeChecks checks (else full sweep).
    const seqCap = __seqProbeChecks > 0 ? Math.min(__seqProbeChecks, locations.length) : locations.length;
    for (let i = 0; !didParallel && i < seqCap; i++) {
      if (!cycling.active) return;

      if (await checkStopSignal()) return;

      // Bootstrap fast-start (#38): once the first city has captured the template,
      // stop the slow sequential sweep — next round runs parallel. (Fallback rounds,
      // where a template already existed, still check every city.)
      if (i > 0 && !hadTemplateAtStart && scheduleTemplate) {
        log("[bootstrap] template captured on first city — switching to parallel next round");
        break;
      }

      // Layer 1: Human-like weighted random delay between locations
      if (i > 0) {
        const delaySec = humanDelay();
        const totalSec = Math.ceil(delaySec);
        const rateInfo = rateTrackerGetRate();
        for (let s = totalSec; s > 0; s--) {
          if (!cycling.active || __abortAll) return;
          if (await checkStopSignal()) return;
          setStatus(`Waiting ${s}s before next location — ${rateInfo} req/min`);
          await sleep(1000);
        }
      }

      // ── Layer 2: Cloudflare Turnstile challenge detection ──
      if (detectTurnstileChallenge()) {
        __cfChallengeActive = true;
        setStatus("🛡️ Cloudflare challenge detected — waiting for manual solve...");
        log("Turnstile challenge detected — pausing cycling");
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.ERROR, `Cloudflare Turnstile challenge detected at round ${cycling.round}`, u);
          sendTelegramNotification("rate",
            `🛡️ <b>CLOUDFLARE CHALLENGE</b>\n\n` +
            `👤 <b>User:</b> ${u}\n` +
            `⚠️ "Verify you are human" detected\n` +
            `⏸️ Cycling PAUSED — solve manually\n` +
            `🔁 Round ${cycling.round}`
          );
        });
        const solved = await waitForChallengeSolved();
        if (!cycling.active) return;
        if (!solved) {
          stopCycling("Cloudflare challenge not solved within timeout");
          return;
        }
        // Challenge solved — add cooldown before resuming
        setStatus("✅ Challenge solved — resuming in 10s...");
        await sleep(10000);
        if (!cycling.active) return;
        // Reset re-entry count since user just solved challenge
        __reentryCount = 0;
        sessionStorage.removeItem("__abUnableCount"); // #49
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.SESSION, "Cloudflare challenge solved — cycling resumed", u);
          sendTelegramNotification("rate", `✅ <b>CHALLENGE SOLVED</b>\n\n👤 <b>User:</b> ${u}\n▶️ Cycling resumed\n🔁 Round ${cycling.round}`);
        });
      }

      // Check for 429 rate limit — severe error, auto-logout
      if (__rateLimited429) {
        __rateLimited429 = false;
        handleSevereError("429 Rate Limited");
        return;
      }

      // ── Rate throttle check before request ──
      const currentRate = rateTrackerGetRate();
      if (currentRate >= RATE_HARD_LIMIT) {
        log(`Rate hard cap hit: ${currentRate} req/min — pausing 60s`);
        rateTrackerRecordError("hard_cap");
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.CYCLING, `Rate hard cap (${currentRate}/min) — pausing 60s`, u);
        });
        for (let s = 60; s > 0; s--) {
          if (!cycling.active || __abortAll) return;
          setStatus(`⚠️ Rate cap (${currentRate}/min) — cooling ${s}s...`);
          await sleep(1000);
        }
      } else if (currentRate >= RATE_SOFT_LIMIT) {
        const extraWait = 15;
        log(`Rate soft throttle: ${currentRate} req/min — adding ${extraWait}s delay`);
        for (let s = extraWait; s > 0; s--) {
          if (!cycling.active || __abortAll) return;
          setStatus(`🐢 Soft throttle (${currentRate}/min) — extra ${s}s...`);
          await sleep(1000);
        }
      }

      const loc = locations[i];
      const rateDisplay = rateTrackerGetRate();
      setStatus(`Checking ${loc.name} (${i + 1}/${locations.length}) — ${rateDisplay} req/min`);

      const select = document.getElementById("post_select");
      if (!select) {
        // Page degraded (often after 429/challenge) — recover via dashboard re-entry instead of hard-stopping
        log("Location dropdown not found — page degraded, re-entering via dashboard");
        onUnableToLoadAlert("Location dropdown missing — page degraded");
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

      const requestStartTime = Date.now();
      const data = await dataPromise;
      const requestDelaySec = (Date.now() - requestStartTime) / 1000;

      // Check for Turnstile after data fetch
      if (detectTurnstileChallenge()) {
        rateTrackerRecord(loc.name, false, requestDelaySec);
        rateTrackerRecordError("turnstile");
        continue; // loop back — Turnstile handler at top of next iteration
      }

      // Check for 429 after data fetch
      if (__rateLimited429) {
        __rateLimited429 = false;
        rateTrackerRecord(loc.name, false, requestDelaySec);
        rateTrackerRecordError("429");
        cycling.backoffMs = cycling.backoffMs ? Math.min(cycling.backoffMs * 2, 300000) : 60000;
        const waitSec = Math.round(cycling.backoffMs / 1000);
        setStatus(`Rate limited (429)! Pausing ${waitSec}s...`);
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.ERROR, `429 rate limited after fetch — backoff ${waitSec}s at ${loc.name}`, u);
          sendTelegramNotification("rate", `🟠 <b>429 RATE LIMITED</b>\n\n👤 <b>User:</b> ${u}\n📍 ${loc.name}\n⏳ Backoff ${waitSec}s`);
        });
        await sleep(cycling.backoffMs);
        if (!cycling.active) return;
        continue; // retry this round
      }

      // Record successful request
      rateTrackerRecord(loc.name, true, requestDelaySec);

      // Reset backoff on successful request
      cycling.backoffMs = 0;
      // Reset re-entry count on successful request
      if (__reentryCount > 0 || sessionStorage.getItem("__abUnableCount")) {
        log(`Successful fetch — resetting re-entry counter (was ${__reentryCount})`);
        __reentryCount = 0;
        sessionStorage.removeItem("__abUnableCount"); // #49 genuine recovery → reset persisted counter
      }

      // Check for 401 / session expiry
      if (isSessionExpired()) {
        await handle401Recovery();
        return;
      }

      if (!data || !data.ScheduleDays || data.ScheduleDays.length === 0) {
        // Diagnostic: check if DOM shows enabled calendar dates that XHR intercept missed
        const enabledDateLinks = document.querySelectorAll(".ui-datepicker-calendar td:not(.ui-state-disabled) a[data-date]");
        if (enabledDateLinks.length > 0) {
          // XHR intercept missed slots that ARE visible in DOM
          const visibleDates = Array.from(enabledDateLinks).slice(0, 10).map(a => a.getAttribute("data-date"));
          log(`⚠️ DOM shows ${enabledDateLinks.length} enabled dates at ${loc.name} but XHR data was empty! Days: ${visibleDates.join(", ")}`);
          chrome.storage.local.get(["loginDetails"], (d) => {
            const u = d.loginDetails?.username || "";
            trackEvent(EVENT_TYPES.ERROR, `XHR data empty but ${enabledDateLinks.length} dates visible in DOM at ${loc.name}`, u);
            sendTelegramNotification("error",
              `🐛 <b>XHR INTERCEPT MISSED — ${loc.name}</b>\n\n` +
              `👤 <b>User:</b> ${u}\n` +
              `📊 DOM shows ${enabledDateLinks.length} enabled dates\n` +
              `📅 Visible days: ${visibleDates.slice(0, 5).join(", ")}\n` +
              `❌ But XHR intercept got 0 dates — page.js (MAIN world) may have failed\n` +
              `💡 Try reloading page`
            );
          });
        }
        setStatus(`No slots at ${loc.name}`);
        await sleep(2000);
        if (isSessionExpired()) { await handle401Recovery(); return; }
        continue;
      }

      // Record every detected slot to history for analytics + counters
      {
        const histUser = (await getSettings()).loginDetails?.username || "";
        if (histUser) {
          let inCount = 0, outCount = 0;
          data.ScheduleDays.forEach((d) => {
            const inR = isDateInRange(d.Date, startDate, endDate);
            if (inR) inCount++; else outCount++;
            recordSlotHistory({
              username: histUser,
              location: loc.name,
              date: d.Date,
              inRange: inR,
              action: "detected",
            });
          });
          if (inCount > 0) incrementUserCounter(histUser, "slotsInRangeFound", inCount);
          if (outCount > 0) incrementUserCounter(histUser, "slotsOutOfRangeFound", outCount);

          // Daily stats
          const total = data.ScheduleDays.length;
          if (total > 0) {
            bumpDailyStat({ key: "slotsFound", delta: total });
            bumpDailyStat({ key: "slotsInRange", delta: inCount });
            bumpDailyStat({ key: "slotsOutOfRange", delta: outCount });
            bumpDailyStat({ delta: total, location: loc.name });
            bumpDailyStat({ delta: total, hour: istHour() });
            bumpDailyStat({ delta: 1, username: histUser });
          }
        }
      }

      // Separate in-range and out-of-range dates
      const inRange = data.ScheduleDays.filter((d) =>
        isDateInRange(d.Date, startDate, endDate)
      ).sort((a, b) => new Date(a.Date) - new Date(b.Date));

      const outOfRange = data.ScheduleDays.filter((d) =>
        !isDateInRange(d.Date, startDate, endDate)
      ).sort((a, b) => new Date(a.Date) - new Date(b.Date));

      // Group by month (in-range)
      const inRangeByMonth = {};
      inRange.forEach(d => {
        const date = new Date(d.Date);
        const monthKey = date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        if (!inRangeByMonth[monthKey]) {
          inRangeByMonth[monthKey] = [];
        }
        inRangeByMonth[monthKey].push(date.getDate());
      });

      // Group by month (out-of-range)
      const outOfRangeByMonth = {};
      outOfRange.forEach(d => {
        const date = new Date(d.Date);
        const monthKey = date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        if (!outOfRangeByMonth[monthKey]) {
          outOfRangeByMonth[monthKey] = [];
        }
        outOfRangeByMonth[monthKey].push(date.getDate());
      });

      // Format in-range section
      let inRangeText = "";
      for (const [month, days] of Object.entries(inRangeByMonth)) {
        inRangeText += `${month}: ${days.sort((a, b) => a - b).join(", ")}\n`;
      }

      // Format out-of-range section
      let outOfRangeText = "";
      for (const [month, days] of Object.entries(outOfRangeByMonth)) {
        outOfRangeText += `${month}: ${days.sort((a, b) => a - b).join(", ")}\n`;
      }

      // Send Telegram overview with user context
      chrome.storage.local.get(["loginDetails", "userProfilesList", "__supabase_device_name"], (d) => {
        const u = d.loginDetails?.username || "";
        const profile = (d.userProfilesList || []).find(p => p.username === u) || {};
        const deviceName = d.__supabase_device_name || "Unknown";
        const applicants = profile.applicantCount || 1;
        const visaType = profile.visaType || "";
        const msg =
          `📍 <b>SLOTS OVERVIEW: ${loc.name}</b>\n\n` +
          `👤 <b>User:</b> ${u}\n` +
          `💻 <b>Device:</b> ${deviceName}\n` +
          `📆 <b>Date Range:</b> ${startDate || "—"} to ${endDate || "—"}\n` +
          `👥 <b>Applicants:</b> ${applicants}\n` +
          (visaType ? `🎫 <b>Visa:</b> ${visaType}\n` : "") +
          `🔄 <b>Round:</b> ${cycling.round} | <b>Cycle:</b> ${i + 1}/${locations.length} locations\n\n` +
          `📅 <b>Available:</b> ${data.ScheduleDays.length} dates\n\n` +
          `✅ <b>IN RANGE (${inRange.length}):</b>\n` +
          (inRangeText || "None\n") +
          `\n❌ <b>OUT OF RANGE (${outOfRange.length}):</b>\n` +
          (outOfRangeText || "None\n");

        trackEvent(EVENT_TYPES.CYCLING, `Slots overview sent for ${loc.name}: ${inRange.length} in range, ${outOfRange.length} out of range`, u);
        sendTelegramNotification("availability", msg);
      });

      if (inRange.length === 0) {
        setStatus(
          `${loc.name}: ${data.ScheduleDays.length} dates found but none in range`
        );
        await sleep(2000);
        continue;
      }

      // ── UNIFIED BOOKING PATH (Issue #36) ──
      // Sequential round-1 + fallback rounds route their in-range catch through the
      // SAME fast-grab used by the parallel scan: one booking path, one message set
      // (🎯 / 🧪 / 🎉), one dry-run guard. Already on this city with days loaded, so
      // pass alreadyOnCity=true to skip the redundant dropdown re-switch.
      // (Replaces the old multi-date retry + grace-period submit block — chosen design
      //  is "grab FIRST in-range, fastest".)
      const liveInRange = inRange.filter((d) => !isDeadSlot(loc.value, d.Date));
      if (!liveInRange.length) { await sleep(1500); continue; } // all in-range here on cooldown — next location
      const grabDate = liveInRange[0].Date; // first non-dead in-range, sorted ascending
      log(`[unified] sequential in-range at ${loc.name} → fast-grab ${grabDate}`);
      await fastGrabBooking(loc.value, loc.name, grabDate, true);
      return;
    }

    // #46 probe consumed this round — next round re-tries parallel.
    if (!didParallel && __seqProbeChecks > 0) __seqProbeChecks = 0;

    // Smart range expansion offer — check at end of round
    await maybeOfferRangeExpansion();

    // Grace period round counting
    if (cycling.gracePeriod.active) {
      cycling.gracePeriod.roundsRemaining--;
      if (cycling.gracePeriod.roundsRemaining <= 0) {
        log("Grace period ended — resuming normal cycling");
        chrome.storage.local.get(["loginDetails"], (d) => {
          const u = d.loginDetails?.username || "";
          trackEvent(EVENT_TYPES.BOOKING, `Grace period ended — slot ${cycling.gracePeriod.missedDate} at ${cycling.gracePeriod.location} not recovered`, u);
          sendTelegramNotification("error",
            `ℹ️ <b>GRACE PERIOD ENDED</b>\n\n` +
            `👤 <b>User:</b> ${u}\n` +
            `📍 <b>Location:</b> ${cycling.gracePeriod.location}\n` +
            `📅 <b>Missed:</b> ${cycling.gracePeriod.missedDate}\n` +
            `🔄 Resuming normal cycling`
          );
        });
        cycling.gracePeriod = {
          active: false, location: null, roundsRemaining: 0,
          fastIntervalMs: GRACE_PERIOD_INTERVAL_MS, missedDate: null,
        };
      }
    }

    // All locations checked — wait and repeat
    if (!cycling.active) return;

    // Use fast interval during grace period, parallel interval after a parallel round, else normal jitter
    let waitMs;
    if (cycling.gracePeriod.active) {
      waitMs = cycling.gracePeriod.fastIntervalMs;
    } else if (didParallel) {
      waitMs = PARALLEL_ROUND_MS * (0.85 + Math.random() * 0.3); // ~38-52s jitter
    } else {
      waitMs = interval * (0.8 + Math.random() * 0.4);
    }
    const sec = Math.round(waitMs / 1000);
    for (let s = sec; s > 0; s--) {
      if (!cycling.active || __abortAll) return;
      if (await checkStopSignal()) return;
      const prefix = cycling.gracePeriod.active ? `🔥 Grace ${cycling.gracePeriod.roundsRemaining}/${GRACE_PERIOD_ROUNDS}` : "All locations checked";
      setStatus(`${prefix}. Next round in ${s}s...`);
      await sleep(1000);
    }
    if (cycling.active) runCycleLoop();
  }

  // ─── AUTO-SUBMIT OBSERVER (standalone, without cycling) ────────────

  function setupAutoSubmit() {
    if (TEST_MODE && TEST_FORCE_NO_SUBMIT) {
      log("TEST_MODE: auto-submit DISABLED — detection-only stage, will not book");
      sendTelegramNotification("cycling", `🧪 Auto-submit blocked (TEST detection stage) — no real booking`);
      return;
    }
    log("Auto-submit observer active");

    // Narrow observation to #time_select or #page_form instead of entire body
    const targetNode = document.getElementById("time_select")
      || document.getElementById("page_form")
      || document.getElementById("main_container");
    if (!targetNode) {
      log("Auto-submit: no target container found, falling back to polling");
      const pollId = setInterval(() => {
        if (cycling.active || __fastGrabbing) return;
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
      if (cycling.active || __fastGrabbing) return;

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
    const isInterviewPage = window.location.pathname.toLowerCase().includes("/schedule") &&
                            !window.location.pathname.toLowerCase().includes("/ofc-schedule");

    // SGA error on interview page = OFC not yet booked → redirect to /ofc-schedule
    if (isInterviewPage) {
      await sleep(1500);
      const errorRow = document.querySelector("#error_row .alert-danger");
      const errorText = (errorRow?.textContent || "").trim();
      if (errorRow && /^SGA\d+$/i.test(errorText)) {
        const activeUser = settings.loginDetails?.username || "";
        log(`SGA error "${errorText}" on interview page — OFC booking required first, redirecting to /ofc-schedule`);
        trackEvent(EVENT_TYPES.ERROR, `${errorText} on interview — redirecting to OFC schedule`, activeUser);
        sendTelegramNotification("error",
          `⚠️ <b>${errorText} — OFC REQUIRED</b>\n\n` +
          `👤 <b>User:</b> ${activeUser}\n` +
          `📋 Interview page shows ${errorText} error\n` +
          `🔄 Redirecting to OFC schedule page`
        );
        window.location.href = window.location.origin + "/en-US/ofc-schedule/";
        return;
      }
    }

    // Check for "exceeded the limit" rate limit warning on OFC/booking page
    // Wait a moment for page to render the warning
    await sleep(2000);
    const rateLimitWarning = document.querySelector("#error_row .alert-warning, .alert-warning.warning");
    if (rateLimitWarning) {
      const warnText = (rateLimitWarning.textContent || "").toLowerCase();
      if (warnText.includes("exceeded") || warnText.includes("limit for viewing")) {
        const activeUser = settings.loginDetails?.username || "";
        log(`Rate limit exceeded on booking page: "${rateLimitWarning.textContent.trim()}"`);
        trackEvent(EVENT_TYPES.ERROR, "Rate limit exceeded on booking page — auto-logout", activeUser);
        sendTelegramNotification("error",
          `🔴 <b>RATE LIMIT EXCEEDED</b>\n\n` +
          `👤 <b>User:</b> ${activeUser}\n` +
          `⚠️ "${rateLimitWarning.textContent.trim()}"\n` +
          `🔒 <b>Blocked for ~24 hours</b>\n` +
          `🚪 Auto-logout in progress...`
        );
        updateUserStatus(activeUser, "rate_limited");
        // Save rate_limited_at timestamp to Supabase
        if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
          try {
            await SupabaseSync.setRateLimitedAt(activeUser, new Date().toISOString());
          } catch (e) { log("Failed to save rate_limited_at: " + e.message); }
        }
        // Use same severe logout flow as #21
        if (cycling.active) stopCycling("Rate limit exceeded — auto-logout");
        __abortAll = true;
        window.__autoBookingLoginActive = false;
        if (cycling.keepAliveTimer) { clearInterval(cycling.keepAliveTimer); cycling.keepAliveTimer = null; }
        // Clear credentials so bot doesn't auto-login after sign-out
        chrome.storage.local.remove(["activeAutomationUser"]);
        sessionStorage.clear();
        sessionStorage.setItem("__abSevereLogout", "Rate Limit Exceeded (24h block)");
        window.location.href = window.location.origin + "/en-US/";
        return;
      }
    }

    // Wait for applicant name label to appear inside #gm_select
    // "No Class Selected" (alert-warning) is a loading state, NOT an error — we must wait past it
    let memberAttempts = 0;
    let pageReady = false;
    while (memberAttempts < 120) {
      const nameLabel = document.querySelector("#gm_select li.list-group-item label");
      const alertWarning = document.querySelector("#gm_select .alert-warning");
      const hasRealName = nameLabel && nameLabel.textContent.trim().length > 0;
      const hasNoClass = alertWarning && alertWarning.textContent.includes("No Class Selected");

      if (hasRealName) {
        log(`Applicant loaded after ${memberAttempts * 500}ms: "${nameLabel.textContent.trim()}"`);
        pageReady = true;
        break;
      }

      if (hasNoClass) {
        log(`"No Class Selected" showing — page still loading (attempt ${memberAttempts + 1}/40)`);
      } else {
        log(`Waiting for applicant name... (attempt ${memberAttempts + 1}/40)`);
      }
      await sleep(500);
      memberAttempts++;
    }

    // If applicant name never loaded after 60 seconds, check if it's a real error
    if (!pageReady) {
      log("Applicant name did not load after 60 seconds — checking if page is genuinely broken");
      const alertWarning = document.querySelector("#gm_select .alert-warning");
      const stillNoClass = alertWarning && alertWarning.textContent.includes("No Class Selected");
      if (!stillNoClass) {
        // No "No Class Selected" and no name — might just be a slow page, try to continue
        log("No alert-warning either — attempting to continue anyway");
      }
    }

    // Wait for dropdown to appear and populate
    let attempts = 0;
    while (!document.getElementById("post_select") && attempts < 20) {
      log(`Waiting for post_select dropdown... (attempt ${attempts + 1}/20)`);
      await sleep(500);
      attempts++;
    }

    const postSelect = document.getElementById("post_select");
    if (postSelect) {
      let optAttempts = 0;
      while (postSelect.options.length <= 1 && optAttempts < 10) {
        log(`Waiting for dropdown options to populate... (${postSelect.options.length} options, attempt ${optAttempts + 1}/10)`);
        await sleep(500);
        optAttempts++;
      }
      log(`Dropdown ready: ${postSelect.options.length} options, value="${postSelect.value}"`);
    }

    // Treat as error if applicant never loaded AND (dropdown empty OR "No Class Selected" warning still showing)
    const nameLabel = document.querySelector("#gm_select li.list-group-item label");
    const hasRealName = nameLabel && nameLabel.textContent.trim().length > 0;
    const isEmptyPage = !postSelect || (postSelect.options.length <= 1 && !postSelect.value);
    const persistentNoClass = !!document.querySelector('#gm_select .alert-warning')?.textContent?.includes("No Class Selected");
    const isGenuineError = !hasRealName && (isEmptyPage || persistentNoClass);

    if (isGenuineError) {
      log(`Booking page error detected — hasName: ${hasRealName}, emptyPage: ${isEmptyPage}, persistentNoClass: ${persistentNoClass}, options: ${postSelect?.options?.length || 0}, value: "${postSelect?.value || ''}"`);
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

        const reason = persistentNoClass ? "No Class Selected (persistent)" : "Empty page";
        log(`Booking page error (${errorCount}/3, ${reason}) — observing ${ERROR_OBSERVE_SEC}s before recovery...`);
        trackEvent(EVENT_TYPES.ERROR, `Booking page error — ${reason} (attempt ${errorCount}/3)`, activeUser);
        sendTelegramNotification("error", `⚠️ <b>BOOKING PAGE ERROR</b>\n\n👤 <b>User:</b> ${activeUser}\n❌ ${reason} (attempt ${errorCount}/3)\n👀 Observing ${ERROR_OBSERVE_SEC}s before reload (check the page!)\n🔄 Then ${errorCount < 3 ? "reload" : "redirect to dashboard"}`);
        await observeBeforeRecovery(`Booking error: ${reason}`);
        if (errorCount < 3) {
          window.location.reload();
        } else {
          window.location.href = window.location.origin + "/en-US/";
        }
        return;
      }
    }

    // Page loaded successfully — clear error counter
    log("Booking page loaded OK — injecting panel");
    sessionStorage.removeItem("__abOFCErrorCount");

    injectBookingPanel();

    // Restore cycling state after keep-alive refresh or dashboard re-entry
    const savedState = getReloginState();
    if (savedState && savedState.active) {
      const activeUser = settings.loginDetails?.username || "";
      // Restore re-entry count if this is an "unable to load" re-entry
      if (savedState.reentryCount) {
        __reentryCount = savedState.reentryCount;
        log(`Dashboard re-entry #${__reentryCount} — resuming cycling with fresh rounds`);
      } else {
        log("Restoring cycling after page refresh...");
      }
      trackEvent(EVENT_TYPES.SESSION, `Restoring cycling — re-entry #${savedState.reentryCount || 0}, fresh round`, activeUser);
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
    // Initialize Supabase sync from stored config
    if (SUPABASE_ENABLED) {
      try { await SupabaseSync.initFromStorage(); } catch (e) { console.warn("[AutoBook] Supabase init skipped:", e.message); }
    }

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

      // Parallel-scan A1: capture the real schedule-days request template from page.js (MAIN world)
      window.addEventListener("vSCPTemplate", (e) => {
        const t = e.detail || {};
        if (!t.url || !t.body) return;
        scheduleTemplate = t;
        const hasAppd = /appd=/.test(t.url);
        const hasPrimary = /primaryId/.test(t.body);
        log(`[parallel] template captured — appd:${hasAppd} primaryId:${hasPrimary} url:${t.url.slice(0, 80)}`);
      });

      // Listen for auto-dismissed alerts (from alert-override.js MAIN world script)
      document.addEventListener("__abAlertDismissed", (e) => {
        const msg = (e.detail || "").toLowerCase();
        log("Alert auto-dismissed: " + e.detail);
        const activeUser = settings.loginDetails?.username || "";

        // Detect "Unable to load appointment available days" → trigger dashboard re-entry
        if (msg.includes("unable to load") || msg.includes("could not load") || msg.includes("failed to load")) {
          onUnableToLoadAlert(e.detail);
          trackEvent(EVENT_TYPES.ERROR, "Alert (unable to load): " + e.detail, activeUser);
          return;
        }

        // Detect "An error has occurred!" → same dashboard re-entry logic
        if (msg.includes("error has occurred") || msg.includes("an error has occurred")) {
          onUnableToLoadAlert(e.detail);
          trackEvent(EVENT_TYPES.ERROR, "Alert (error occurred): " + e.detail, activeUser);
          return;
        }

        trackEvent(EVENT_TYPES.ERROR, "Alert dismissed: " + e.detail, activeUser);
        sendTelegramNotification("error", `⚠️ <b>ALERT DISMISSED</b>\n\n👤 <b>User:</b> ${activeUser}\n📋 ${e.detail}`);
      });
    }

    // Cloudflare Waiting Room detection — any domain (b2clogin, usvisascheduling)
    // Must run BEFORE Turnstile check — waiting room has CF elements that trigger false positive
    if (isWaitingRoom()) {
      const wrUser = settings.loginDetails?.username || activeAutoUser || "";
      if (!automationActive) {
        log("Waiting room detected but automation stopped — not refreshing");
        return;
      }
      const attempt = parseInt(sessionStorage.getItem("__abWaitingRoomCount") || "0") + 1;
      sessionStorage.setItem("__abWaitingRoomCount", String(attempt));
      if (attempt > 30) {
        log("Waiting room — max retries (30) reached, stopping");
        trackEvent(EVENT_TYPES.ERROR, "Waiting room max retries reached", wrUser);
        sessionStorage.removeItem("__abWaitingRoomCount");
        sendTelegramNotification("error", `🔴 <b>WAITING ROOM TIMEOUT</b>\n\n👤 <b>User:</b> ${wrUser}\n⚠️ 30 retries exhausted — needs manual check`);
        return;
      }
      log(`Waiting room detected (attempt ${attempt}) on ${host} — auto-refreshing in 30s`);
      trackEvent(EVENT_TYPES.SESSION, `Waiting room detected (attempt ${attempt}) on ${host}`, wrUser);
      if (attempt === 1) {
        sendTelegramNotification("rate",
          `⏳ <b>WAITING ROOM</b>\n\n` +
          `👤 <b>User:</b> ${wrUser}\n` +
          `🌐 <b>Domain:</b> ${host}\n` +
          `⏸️ In queue — page will auto-refresh\n` +
          `🔄 Attempt ${attempt}/30`
        );
      }
      await sleep(30000);
      window.location.reload();
      return;
    }

    // Cloudflare Turnstile challenge — any domain
    // Runs AFTER waiting room check so no false positives
    if (detectTurnstileChallenge()) {
      const cfUser = settings.loginDetails?.username || activeAutoUser || "";
      const cfStored = await new Promise((r) => chrome.storage.local.get(["__supabase_device_name"], r));
      const cfDevice = cfStored.__supabase_device_name || "this device";
      log("Cloudflare challenge detected on page load — alerting operator for remote solve");
      __cfChallengeActive = true;
      trackEvent(EVENT_TYPES.ERROR, `Cloudflare challenge on ${host} — remote solve needed`, cfUser);
      sendTelegramNotification("rate",
        `🛡️ <b>CLOUDFLARE CHALLENGE</b>\n\n` +
        `👤 <b>User:</b> ${cfUser}\n` +
        `🖥️ <b>Device:</b> ${cfDevice}\n` +
        `⚠️ "Verify you are human" checkbox blocking the bot.\n` +
        `🔧 <b>Remote into ${cfDevice}</b> (Chrome Remote Desktop) and click the checkbox.\n` +
        `▶️ Bot auto-resumes once solved.`
      );
      const solved = await waitForChallengeSolved();
      if (solved) {
        log("Challenge solved on page load — reloading");
        trackEvent(EVENT_TYPES.SESSION, "Turnstile solved on page load — reloading", cfUser);
        sendTelegramNotification("rate", `✅ <b>CHALLENGE SOLVED</b>\n\n👤 <b>User:</b> ${cfUser}\n🔄 Reloading page...`);
        await sleep(2000);
        window.location.reload();
      }
      return;
    }

    if (host.includes("b2clogin.com")) {
      sessionStorage.removeItem("__ab401RetryCount");
      log("On b2clogin.com — detecting page type...");
      await handleLoginPage();
      return;
    }

    // Cloudflare block detection on page load — severe error, auto-logout
    if (host.includes("usvisascheduling.com") && isCloudflareBlocked()) {
      log("Cloudflare block detected on page load — triggering auto-logout");
      handleSevereError("Cloudflare Blocked (Error 1015)");
      return;
    }

    // Generic site error page detection ("We're sorry, but something went wrong")
    if (host.includes("usvisascheduling.com")) {
      const errorDialog = document.querySelector('div.dialog[role="main"]');
      const errorBodyText = (errorDialog?.textContent || "").toLowerCase();
      if (errorDialog && (errorBodyText.includes("we're sorry") || errorBodyText.includes("something went wrong"))) {
        if (!automationActive) {
          log("Site error page detected but automation stopped — not retrying");
          return;
        }

        const errIdMatch = errorDialog.textContent.match(/Error ID #\s*\[([^\]]+)\]/i);
        const errId = errIdMatch ? errIdMatch[1] : "unknown";
        const retryCount = parseInt(sessionStorage.getItem("__abSiteErrorCount") || "0") + 1;
        sessionStorage.setItem("__abSiteErrorCount", String(retryCount));

        const errUser = settings.loginDetails?.username || activeAutoUser || "";

        if (retryCount > 5) {
          log(`Site error max retries (5) — stopping. Error ID: ${errId}`);
          trackEvent(EVENT_TYPES.ERROR, `Site error max retries — Error ID: ${errId}`, errUser);
          sessionStorage.removeItem("__abSiteErrorCount");
          sendTelegramNotification("error",
            `🔴 <b>SITE ERROR — STOPPED</b>\n\n` +
            `👤 <b>User:</b> ${errUser}\n` +
            `❌ Error ID: <code>${errId}</code>\n` +
            `⚠️ 5 retries failed — needs manual intervention`
          );
          chrome.storage.local.remove("activeAutomationUser");
          return;
        }

        const waitSec = 30 * retryCount;
        log(`Site error (${retryCount}/5) — retry in ${waitSec}s — Error ID: ${errId}`);
        trackEvent(EVENT_TYPES.ERROR, `Site error retry ${retryCount}/5 — Error ID: ${errId}`, errUser);
        sendTelegramNotification("error",
          `⚠️ <b>SITE ERROR</b>\n\n` +
          `👤 <b>User:</b> ${errUser}\n` +
          `❌ Error ID: <code>${errId}</code>\n` +
          `👀 Observing ${waitSec}s (check the page for real error!)\n` +
          `🔁 Then retry ${retryCount}/5`
        );
        for (let s = waitSec; s > 0; s--) {
          if (sessionStorage.getItem("__abortAll") === "true") return;
          const statusEl = document.getElementById("ab-status");
          if (statusEl) statusEl.textContent = `⚠️ Site error — recovery in ${s}s...`;
          log(`Site error countdown: ${s}s`);
          await sleep(1000);
        }
        window.location.reload();
        return;
      }
      // Clear counter on successful (non-error) page load
      sessionStorage.removeItem("__abSiteErrorCount");
    }

    // Sign-in failed page detection (/Account/Login/ExternalAuthenticationFailed)
    if (host.includes("usvisascheduling.com")) {
      const bodyTextLower = (document.body?.textContent || "").toLowerCase();
      const isSignInFailed = path.includes("externalauthenticationfailed") ||
                             path.includes("/account/login/") && bodyTextLower.includes("sign in failed");
      if (isSignInFailed) {
        if (!automationActive) {
          log("Sign-in failed page but automation stopped — not retrying");
          return;
        }

        const failUser = settings.loginDetails?.username || activeAutoUser || "";
        const retryCount = parseInt(sessionStorage.getItem("__abSignInFailCount") || "0") + 1;
        sessionStorage.setItem("__abSignInFailCount", String(retryCount));

        if (retryCount > 3) {
          log(`Sign-in failed max retries (3) — stopping`);
          trackEvent(EVENT_TYPES.ERROR, "Sign-in failed max retries — ExternalAuthenticationFailed", failUser);
          sessionStorage.removeItem("__abSignInFailCount");
          sendTelegramNotification("error",
            `🔴 <b>SIGN-IN FAILED — STOPPED</b>\n\n` +
            `👤 <b>User:</b> ${failUser}\n` +
            `❌ ExternalAuthenticationFailed 3 times\n` +
            `⚠️ Needs manual login`
          );
          chrome.storage.local.remove("activeAutomationUser");
          return;
        }

        log(`Sign-in failed (${retryCount}/3) — observing ${ERROR_OBSERVE_SEC}s before clicking Sign in`);
        trackEvent(EVENT_TYPES.LOGIN, `Sign-in failed retry ${retryCount}/3 — ExternalAuthenticationFailed`, failUser);
        sendTelegramNotification("error",
          `⚠️ <b>SIGN-IN FAILED</b>\n\n` +
          `👤 <b>User:</b> ${failUser}\n` +
          `🔁 Retry ${retryCount}/3\n` +
          `👀 Observing ${ERROR_OBSERVE_SEC}s before recovery (check the page!)\n` +
          `🔄 Then click Sign in button`
        );

        await observeBeforeRecovery("Sign-in failed");

        // Find Sign in button — anchor with text "Sign in" or button
        let signInBtn = null;
        const allLinks = document.querySelectorAll('a, button');
        for (const el of allLinks) {
          const txt = (el.textContent || "").trim().toLowerCase();
          if (txt === "sign in" || txt.includes("sign in")) {
            signInBtn = el;
            break;
          }
        }

        if (signInBtn) {
          log("Clicking Sign in button");
          clickSafe(signInBtn);
        } else {
          log("Sign in button not found — redirecting to home");
          window.location.href = window.location.origin + "/en-US/";
        }
        return;
      }
      // Clear counter on successful page load
      sessionStorage.removeItem("__abSignInFailCount");
    }

    // Bare 401 Unauthorized response page detection
    // Server returns minimal HTML with just "401 Unauthorized" text when session/cookies invalid
    if (host.includes("usvisascheduling.com")) {
      const bodyTextRaw = (document.body?.textContent || "").trim();
      const titleLower = (document.title || "").toLowerCase();
      const isBare401 = /^401(\s+unauthorized)?$/i.test(bodyTextRaw) ||
                        (bodyTextRaw.length < 50 && /^401\b/i.test(bodyTextRaw)) ||
                        titleLower.includes("401") ||
                        titleLower.includes("unauthorized");

      if (isBare401) {
        if (!automationActive) {
          log("Bare 401 page but automation stopped — not retrying");
          return;
        }

        const u401 = settings.loginDetails?.username || activeAutoUser || "";
        const retry401 = parseInt(sessionStorage.getItem("__abBare401Count") || "0") + 1;
        sessionStorage.setItem("__abBare401Count", String(retry401));
        const isOfcSchedule = path.includes("/ofc-schedule") || path.includes("/schedule");

        if (retry401 > 5) {
          log("Bare 401 max retries (5) — stopping");
          trackEvent(EVENT_TYPES.ERROR, "Bare 401 page max retries reached", u401);
          sessionStorage.removeItem("__abBare401Count");
          sendTelegramNotification("error",
            `🔴 <b>401 UNAUTHORIZED — STOPPED</b>\n\n` +
            `👤 <b>User:</b> ${u401}\n` +
            `❌ Session re-login failed 5 times\n` +
            `⚠️ Needs manual login`
          );
          chrome.storage.local.remove("activeAutomationUser");
          return;
        }

        // Strategy: at /ofc-schedule attempt 1-2 = reload (transient 401 sometimes recovers)
        // attempt 3+ = full re-login flow via /en-US/
        const useReload = isOfcSchedule && retry401 <= 2;
        const action = useReload ? "reload page" : "full re-login";

        log(`Bare 401 page (${retry401}/5) — ${action} after ${ERROR_OBSERVE_SEC}s observation`);
        trackEvent(EVENT_TYPES.SESSION, `Bare 401 detected — ${action} (${retry401}/5)`, u401);
        sendTelegramNotification("error",
          `⚠️ <b>401 UNAUTHORIZED</b>\n\n` +
          `👤 <b>User:</b> ${u401}\n` +
          `📍 <b>URL:</b> ${path}\n` +
          `👀 Observing ${ERROR_OBSERVE_SEC}s before recovery (check the page!)\n` +
          `🔄 Then: ${action} (attempt ${retry401}/5)`
        );

        await observeBeforeRecovery(`401 Unauthorized at ${path}`);

        if (useReload) {
          window.location.reload();
          return;
        }

        // Full re-login flow
        sessionStorage.setItem(RELOGIN_FLAG, "true");
        const existingState = sessionStorage.getItem("ab-cycling-state");
        if (!existingState) {
          sessionStorage.setItem("ab-cycling-state", JSON.stringify({
            active: true,
            round: 0,
            startDate: "",
            endDate: "",
            interval: "30",
            locations: [],
            timestamp: Date.now()
          }));
        }

        window.location.href = window.location.origin + "/en-US/";
        return;
      }
      // Clear counter on successful (non-401) page load
      sessionStorage.removeItem("__abBare401Count");
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
      // Update most recent submitted slot for this user → confirmed
      chrome.storage.local.get(["slotHistory"], (data) => {
        const history = data.slotHistory || [];
        const idx = history.findIndex((e) => e.username === routerUser && e.action === "submitted");
        if (idx !== -1) {
          history[idx].action = "confirmed";
          history[idx].confirmedAt = new Date().toISOString();
          chrome.storage.local.set({ slotHistory: history });
          if (SUPABASE_ENABLED && SupabaseSync.isReady()) {
            SupabaseSync.updateSlotAction(routerUser, history[idx].location, history[idx].date, "confirmed");
          }
        }
      });
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
    if (msg.action === "updateDateRange") {
      // Auto-apply expanded date range from Telegram callback
      const targetUser = msg.username;
      const newEndDate = msg.endDate;
      chrome.storage.local.get(["loginDetails"], (d) => {
        const currentUser = d.loginDetails?.username;
        // Only apply if this tab is for the same user
        if (targetUser && currentUser && targetUser !== currentUser) {
          sendResponse({ applied: false, reason: "different_user" });
          return;
        }
        const endInput = document.getElementById("ab-end-date");
        if (endInput && newEndDate) {
          const oldVal = endInput.value;
          endInput.value = newEndDate;
          endInput.dispatchEvent(new Event("change", { bubbles: true }));
          log(`Date range auto-extended: ${oldVal} → ${newEndDate}`);
          trackEvent(EVENT_TYPES.CYCLING, `Date range auto-extended via Telegram: ${oldVal} → ${newEndDate}`, currentUser || "");
          setStatus(`✨ Range extended to ${newEndDate}`);
          sendResponse({ applied: true });
        } else {
          sendResponse({ applied: false, reason: "no_input" });
        }
      });
      return true;
    }
    if (msg.action === "logout") {
      log("LOGOUT command received — clearing session and redirecting to login...");
      // Get username BEFORE removing loginDetails
      chrome.storage.local.get(["loginDetails"], (d) => {
        const u = d.loginDetails?.username || "";
        trackEvent(EVENT_TYPES.SESSION, `Logout command received — clearing session for ${u}`, u);
        sendTelegramNotification("logout", `🚪 <b>LOGGED OUT</b>\n\n👤 <b>User:</b> ${u}\n🔒 Session cleared from dashboard\n✅ Ready for next user`);
        // Always update status to idle (even if not cycling)
        updateUserStatus(u, "idle");

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
      });
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
