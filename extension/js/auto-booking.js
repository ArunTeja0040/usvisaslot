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

    for (let attempt = 1; attempt <= CAPTCHA_MAX_RETRIES; attempt++) {
      await sleep(1000);

      if (!captchaImg.complete || !captchaImg.naturalWidth) {
        await new Promise((r) => (captchaImg.onload = r));
      }

      const answer = await solveCaptchaOCR(captchaImg);
      if (!answer) {
        log(`Attempt ${attempt}: OCR failed, refreshing...`);
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
        clickSafe(refreshBtn);
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

  // ─── SETTINGS PANEL (injected on login page) ─────────────────────

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

    // Load saved settings
    chrome.storage.local.get(
      [
        "loginDetails",
        "securityQuestions",
        "is_auto-login",
        "is_auto-submit",
        "is_auto-dashboard",
        "is_sel-1st-slot",
        "captchaMode",
      ],
      (data) => {
        if (data.loginDetails) {
          document.getElementById("sp-username").value = data.loginDetails.username || "";
          document.getElementById("sp-password").value = data.loginDetails.password || "";
        }

        if (data.securityQuestions) {
          const entries = Object.entries(data.securityQuestions);
          entries.forEach(([q, a], idx) => {
            const qEl = document.getElementById(`sp-q${idx + 1}`);
            const aEl = document.getElementById(`sp-a${idx + 1}`);
            if (qEl) qEl.value = q;
            if (aEl) aEl.value = a;
          });
        }

        document.getElementById("sp-auto-login").checked = data["is_auto-login"] !== false;
        document.getElementById("sp-auto-dashboard").checked = data["is_auto-dashboard"] !== false;
        document.getElementById("sp-auto-select").checked = data["is_sel-1st-slot"] !== false;
        document.getElementById("sp-auto-submit").checked = data["is_auto-submit"] === true;

        const mode = data.captchaMode || "manual";
        const radio = document.querySelector(`input[name="sp-captcha"][value="${mode}"]`);
        if (radio) radio.checked = true;

      }
    );

    // Save handler
    document.getElementById("sp-save-btn").addEventListener("click", () => {
      const loginDetails = {
        username: document.getElementById("sp-username").value,
        password: document.getElementById("sp-password").value,
      };

      const securityQuestions = {};
      for (let i = 1; i <= 3; i++) {
        const q = document.getElementById(`sp-q${i}`).value;
        const a = document.getElementById(`sp-a${i}`).value;
        if (q && a) securityQuestions[q] = a;
      }

      const captchaMode = document.querySelector('input[name="sp-captcha"]:checked')?.value || "manual";

      chrome.storage.local.set(
        {
          loginDetails,
          securityQuestions,
          "is_auto-login": document.getElementById("sp-auto-login").checked,
          "is_auto-dashboard": document.getElementById("sp-auto-dashboard").checked,
          "is_sel-1st-slot": document.getElementById("sp-auto-select").checked,
          "is_auto-submit": document.getElementById("sp-auto-submit").checked,
          captchaMode,
        },
        () => {
          const status = document.getElementById("sp-save-status");
          status.textContent = "Saved!";
          setTimeout(() => (status.textContent = ""), 3000);
          log("All settings saved");
        }
      );
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

  // ─── LOGIN PAGE (panel only — waits for START, unless re-login) ────

  async function handleLoginPage() {
    injectSettingsPanel();

    // If re-login flag is set (session expired during cycling), auto-login immediately
    if (sessionStorage.getItem(RELOGIN_FLAG) === "true") {
      sessionStorage.removeItem(RELOGIN_FLAG);
      log("Re-login triggered after session expiry — auto-starting...");
      await sleep(1500);
      const settings = await getSettings();
      if (settings.loginDetails?.username && settings.loginDetails?.password) {
        const body = document.getElementById("sp-body");
        if (body) body.style.display = "none";
        document.getElementById("sp-toggle").innerHTML = "&#9654;";
        runLogin(settings);
      }
    }
  }

  // ─── DASHBOARD ──────────────────────────────────────────────────────

  async function handleDashboard(settings) {
    // After re-login, always auto-navigate to booking page
    const savedState = getReloginState();
    if (savedState && savedState.active) {
      log("Re-login complete — auto-navigating from dashboard...");
    } else if (!settings["is_auto-dashboard"]) {
      return;
    }

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

  let cycling = { active: false, timer: null, round: 0, keepAliveTimer: null, lastRefresh: 0 };
  const SESSION_REFRESH_MS = 8 * 60 * 1000; // 8 minutes
  const RELOGIN_FLAG = "__autoBookingRelogin";

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

  // ─── SESSION KEEP-ALIVE & 401 RECOVERY ─────────────────────────────

  // Listen for 401 events dispatched by XHR/fetch on the page
  // page.js (MAIN world) fires vSCP events — we also listen for a custom 401 signal
  let __session401Detected = false;

  // Inject a script into MAIN world to intercept XHR 401 responses
  // Uses a hidden DOM element as bridge since custom events don't cross worlds
  function inject401Detector() {
    const marker = document.createElement("div");
    marker.id = "__ab401marker";
    marker.style.display = "none";
    document.documentElement.appendChild(marker);

    const script = document.createElement("script");
    script.textContent = `
      (function() {
        var marker = document.getElementById("__ab401marker");
        function signal401(url) {
          console.log("[AutoBook] 401 detected:", url);
          if (marker) marker.setAttribute("data-hit", Date.now());
        }

        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._abUrl = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          this.addEventListener("load", function() {
            if (this.status === 401) signal401(this._abUrl);
          });
          return origSend.apply(this, arguments);
        };

        var origFetch = window.fetch;
        window.fetch = function() {
          return origFetch.apply(this, arguments).then(function(resp) {
            if (resp.status === 401) signal401(resp.url);
            return resp;
          });
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    // Content script (ISOLATED world) observes the marker attribute change
    const observer = new MutationObserver(() => {
      log("401 detected via DOM bridge");
      __session401Detected = true;
    });
    observer.observe(marker, { attributes: true });
  }

  function isSessionExpired() {
    if (__session401Detected) return true;
    const body = document.body?.innerText || "";
    if (body.includes("401") && body.includes("Unauthorized")) return true;
    if (document.querySelector(".error-page, .session-expired")) return true;
    if (window.location.hostname.includes("b2clogin.com")) return true;
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
    stopCycling("Session expired — re-logging in...");
    saveReloginState();
    sessionStorage.setItem(RELOGIN_FLAG, "true");
    window.location.href = window.location.origin;
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

    startKeepAlive();
    setStatus("Starting...");
    runCycleLoop();
  }

  function stopCycling(reason) {
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

      // Check for 401 / session expiry after every network call
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

    if (settings["is_auto-submit"] && !cycling.active) {
      setupAutoSubmit();
    }
  }

  // ─── MAIN ROUTER ───────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    const path = window.location.pathname.toLowerCase();
    const host = window.location.hostname.toLowerCase();

    // Inject 401 detector on scheduling pages (MAIN world XHR intercept)
    if (host.includes("usvisascheduling.com")) {
      inject401Detector();
    }

    if (host.includes("b2clogin.com")) {
      log("On login page — waiting for START");
      await handleLoginPage();
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
