(function () {
  "use strict";

  const LOG_PREFIX = "[AutoBook]";
  const CAPTCHA_MAX_RETRIES = 5;
  const DASHBOARD_CLICK_DELAY = 2000;

  function log(msg) {
    console.log(`${LOG_PREFIX} ${msg}`);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
        return resp.text.toUpperCase().trim();
      }
    } catch (e) {
      log("CAPTCHA solve error: " + e.message);
    }
    return null;
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

    for (let attempt = 1; attempt <= CAPTCHA_MAX_RETRIES; attempt++) {
      await sleep(1000);

      if (!captchaImg.complete || !captchaImg.naturalWidth) {
        await new Promise((r) => (captchaImg.onload = r));
      }

      const answer = await solveCaptchaOCR(captchaImg);
      if (!answer) {
        log(`Attempt ${attempt}: OCR failed, refreshing...`);
        if (refreshBtn) refreshBtn.click();
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
        if (refreshBtn) refreshBtn.click();
        await sleep(2000);
        continue;
      }

      log("CAPTCHA appears solved or page navigated");
      return;
    }

    log("Max CAPTCHA retries reached — falling back to manual");
    captchaInput.focus();
  }

  // ─── SECURITY QUESTIONS ─────────────────────────────────────────────

  async function handleSecurityQuestions(securityQAs) {
    const questionItems = document.querySelectorAll(
      "#attributeList li.Paragraph"
    );
    if (questionItems.length < 2) {
      await sleep(1000);
      return handleSecurityQuestions(securityQAs);
    }

    log("Security questions detected");
    let answered = 0;

    for (const item of questionItems) {
      const questionEl = item.querySelector("p.textInParagraph");
      if (!questionEl) continue;

      const questionText = questionEl.textContent.trim();
      const answer = securityQAs[questionText];

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
        log(`No answer found for: "${questionText.substring(0, 50)}..."`);
      }
    }

    if (answered >= 2) {
      await sleep(1000);
      const continueBtn = document.getElementById("continue");
      if (continueBtn) {
        log("Clicking Continue after security questions");
        continueBtn.click();
      }
    }
  }

  // ─── LOGIN PAGE ─────────────────────────────────────────────────────

  async function handleLoginPage(settings) {
    if (!settings["is_auto-login"]) return;

    const loginDetails = settings.loginDetails;
    if (!loginDetails || !loginDetails.username || !loginDetails.password) {
      log("No login credentials configured");
      return;
    }

    if (window.__autoBookingLoginActive) return;
    window.__autoBookingLoginActive = true;

    const waitForForm = setInterval(async () => {
      const userField = document.getElementById("signInName");
      const passField = document.getElementById("password");
      const captchaImg = document.getElementById("captchaImage");

      if (userField && passField && captchaImg) {
        clearInterval(waitForForm);

        await sleep(600);

        log("Login form detected — auto-filling...");
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

  // ─── DASHBOARD ──────────────────────────────────────────────────────

  async function handleDashboard(settings) {
    if (!settings["is_auto-dashboard"]) return;

    const warning = document.querySelector(".alert-warning.warning");
    if (warning) {
      const text = warning.textContent.trim().toLowerCase();
      if (text.includes("exceeded") || text.includes("maximum")) {
        log("Rate limited: " + text);
        return;
      }
    }

    const waitForBtn = setInterval(() => {
      const rescheduleBtn = document.getElementById("reschedule_appointment");
      const continueBtn = document.getElementById("continue_application");

      if (rescheduleBtn) {
        clearInterval(waitForBtn);
        log("Found Reschedule Appointment — clicking...");
        setTimeout(() => rescheduleBtn.click(), DASHBOARD_CLICK_DELAY);
      } else if (continueBtn) {
        clearInterval(waitForBtn);
        log("Found Continue Application — clicking...");
        setTimeout(() => continueBtn.click(), DASHBOARD_CLICK_DELAY);
      }
    }, 1000);

    setTimeout(() => clearInterval(waitForBtn), 30000);
  }

  // ─── BOOKING PANEL UI ──────────────────────────────────────────────

  let cycling = { active: false, timer: null, round: 0 };

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
          <span id="ab-cycle-info" style="font-size:12px;color:#888;margin-left:10px;"></span>
        </div>
      </div>`;

    mainContainer.parentNode.insertBefore(panel, mainContainer);

    chrome.storage.local.get(
      ["preferred_window", "preferred_locations"],
      (data) => {
        if (data.preferred_window) {
          const sd = document.getElementById("ab-start-date");
          const ed = document.getElementById("ab-end-date");
          if (sd && data.preferred_window.slot_start_date)
            sd.value = data.preferred_window.slot_start_date;
          if (ed && data.preferred_window.slot_end_date)
            ed.value = data.preferred_window.slot_end_date;
        }
        if (data.preferred_locations) {
          const key = isOFC ? "ofc" : "ca";
          const prefs = data.preferred_locations[key];
          if (prefs && prefs.length > 0) {
            document.querySelectorAll(".ab-loc-cb").forEach((cb) => {
              cb.checked = prefs.includes(cb.dataset.name);
            });
          }
        }
      }
    );

    document
      .getElementById("ab-start-btn")
      .addEventListener("click", startCycling);
    document
      .getElementById("ab-stop-btn")
      .addEventListener("click", () => stopCycling("Stopped by user"));

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

  // ─── CYCLING LOGIC ─────────────────────────────────────────────────

  function startCycling() {
    const checked = document.querySelectorAll(".ab-loc-cb:checked");
    if (checked.length === 0) {
      setStatus("Select at least one location");
      return;
    }

    cycling.active = true;
    cycling.round = 0;

    const startBtn = document.getElementById("ab-start-btn");
    const stopBtn = document.getElementById("ab-stop-btn");
    startBtn.disabled = true;
    startBtn.style.opacity = "0.5";
    stopBtn.disabled = false;
    stopBtn.style.opacity = "1";

    // Save current date preferences
    chrome.storage.local.set({
      preferred_window: {
        slot_start_date: document.getElementById("ab-start-date")?.value || "",
        slot_end_date: document.getElementById("ab-end-date")?.value || "",
      },
    });

    setStatus("Starting...");
    runCycleLoop();
  }

  function stopCycling(reason) {
    cycling.active = false;
    if (cycling.timer) {
      clearTimeout(cycling.timer);
      cycling.timer = null;
    }

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

  async function waitForTimeSlotAndSubmit(timeout = 12000) {
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
          setStatus("Slot found — submitting!");
          await sleep(1000);
          submitBtn.click();
          return true;
        }
      }
      await sleep(500);
    }
    return false;
  }

  async function runCycleLoop() {
    if (!cycling.active) return;

    cycling.round++;
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
        // Same location already selected — re-trigger to refresh
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const data = await dataPromise;

      if (!data || !data.ScheduleDays || data.ScheduleDays.length === 0) {
        setStatus(`No slots at ${loc.name}`);
        await sleep(2000);
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

      // Wait for time slots to load and submit
      await sleep(1500);
      const submitted = await waitForTimeSlotAndSubmit(12000);

      if (submitted) {
        stopCycling("Booking submitted!");
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

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => observer.disconnect(), 300000);
  }

  // ─── BOOKING PAGE HANDLER ──────────────────────────────────────────

  async function handleBookingPage(settings) {
    // Wait for the location dropdown to appear
    let attempts = 0;
    while (!document.getElementById("post_select") && attempts < 20) {
      await sleep(500);
      attempts++;
    }

    injectBookingPanel();

    if (settings["is_auto-submit"] && !cycling.active) {
      setupAutoSubmit();
    }
  }

  // ─── MAIN ROUTER ───────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    const path = window.location.pathname.toLowerCase();
    const host = window.location.hostname.toLowerCase();

    if (host.includes("b2clogin.com")) {
      log("On login page");
      await handleLoginPage(settings);
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
      return;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
