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

    // Wait for login form
    const waitForForm = setInterval(async () => {
      const userField = document.getElementById("signInName");
      const passField = document.getElementById("password");
      const captchaImg = document.getElementById("captchaImage");

      if (userField && passField && captchaImg) {
        clearInterval(waitForForm);

        log("Login form detected — auto-filling...");
        userField.value = loginDetails.username;
        userField.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(300);

        passField.value = loginDetails.password;
        passField.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(300);

        await handleCaptcha(settings);
      }

      // Security questions page
      const responseFields = document.querySelectorAll(
        '[id$="_response"]'
      );
      if (responseFields.length === 2 && settings.securityQuestions) {
        clearInterval(waitForForm);
        await handleSecurityQuestions(settings.securityQuestions);
      }
    }, 500);
  }

  // ─── DASHBOARD ──────────────────────────────────────────────────────

  async function handleDashboard(settings) {
    if (!settings["is_auto-dashboard"]) return;

    // Check for rate limit
    const warning = document.querySelector(".alert-warning.warning");
    if (warning) {
      const text = warning.textContent.trim().toLowerCase();
      if (text.includes("exceeded") || text.includes("maximum")) {
        log("Rate limited: " + text);
        return;
      }
    }

    // Wait for dashboard buttons
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

    // Stop waiting after 30s
    setTimeout(() => clearInterval(waitForBtn), 30000);
  }

  // ─── AUTO-SUBMIT ON BOOKING PAGES ──────────────────────────────────

  async function handleBookingPageSubmit(settings) {
    if (!settings["is_auto-submit"]) return;

    log("Watching for auto-submit opportunity...");

    const observer = new MutationObserver(() => {
      const submitBtn = document.getElementById("submitbtn");
      if (submitBtn && !submitBtn.disabled) {
        const selectedRadio = document.querySelector(
          '#time_select input[type="radio"]:checked'
        );
        if (selectedRadio) {
          log("Time slot selected + submit ready — clicking submit!");
          observer.disconnect();
          setTimeout(() => {
            submitBtn.click();
          }, 1500);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Fallback: also poll
    const pollInterval = setInterval(() => {
      const submitBtn = document.getElementById("submitbtn");
      if (submitBtn && !submitBtn.disabled) {
        const selectedRadio = document.querySelector(
          '#time_select input[type="radio"]:checked'
        );
        if (selectedRadio) {
          log("(poll) Time slot selected + submit ready — clicking submit!");
          clearInterval(pollInterval);
          observer.disconnect();
          setTimeout(() => {
            submitBtn.click();
          }, 1500);
        }
      }
    }, 2000);

    // Stop after 5 minutes
    setTimeout(() => {
      clearInterval(pollInterval);
      observer.disconnect();
    }, 300000);
  }

  // ─── MAIN ROUTER ───────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    const path = window.location.pathname.toLowerCase();
    const host = window.location.hostname.toLowerCase();

    // B2C Login page
    if (host.includes("b2clogin.com")) {
      log("On login page");
      await handleLoginPage(settings);
      return;
    }

    // Dashboard
    if (/^\/[a-z]{2}-[a-z]{2}\/?$/i.test(path)) {
      log("On dashboard");
      await handleDashboard(settings);
      return;
    }

    // OFC or Interview booking pages
    if (path.includes("/ofc-schedule") || path.includes("/schedule")) {
      log("On booking page: " + path);
      await handleBookingPageSubmit(settings);
      return;
    }

    // Confirmation page
    if (path.includes("appointment-confirmation")) {
      log("On confirmation page");
      return;
    }
  }

  // Wait for document ready then init
  if (document.readyState === "complete") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
