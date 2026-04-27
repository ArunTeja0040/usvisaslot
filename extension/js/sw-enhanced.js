// Enhanced service worker — adds CAPTCHA solving + auto-submit setting
// Runs alongside original sw.js logic

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.storage.local.get(
    ["is_display-slots", "is_sel-1st-slot", "is_auto-login", "is_auto-submit", "captchaMode"],
    function (t) {
      chrome.storage.local.set(
        {
          extVersion: chrome.runtime.getManifest().version,
          "is_display-slots": t["is_display-slots"] ?? true,
          "is_sel-1st-slot": t["is_sel-1st-slot"] ?? true,
          "is_auto-login": t["is_auto-login"] ?? true,
          "is_auto-submit": t["is_auto-submit"] ?? false,
          "is_auto-dashboard": t["is_auto-dashboard"] ?? true,
          captchaMode: t["captchaMode"] ?? "manual",
        },
        function () {
          if ("install" === reason)
            chrome.tabs.create({ url: "options.html" });
        }
      );

      chrome.scripting
        .registerContentScripts([
          {
            id: "usvisascheduling",
            js: ["js/page.js"],
            matches: ["https://www.usvisascheduling.com/*/*schedule/*"],
            runAt: "document_start",
            world: "MAIN",
          },
        ])
        .catch(console.log);
    }
  );
});

chrome.runtime.onMessageExternal.addListener((e, t, s) => {
  if (e) {
    if (e.message && "version" === e.message)
      s({ version: chrome.runtime.getManifest().version });
    else if (e.apiKey) chrome.storage.local.set({ apiKey: e.apiKey });
  }
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// CAPTCHA solving via offscreen canvas in service worker
async function solveCaptchaLocal(base64Image) {
  try {
    const resp = await fetch("data:image/png;base64," + base64Image);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Simple preprocessing: convert to grayscale, threshold
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const bw = gray > 128 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = bw;
    }
    ctx.putImageData(imageData, 0, 0);

    // For now, return null — actual OCR needs Tesseract.js or external API
    // The content script will fall back to manual mode
    return null;
  } catch (e) {
    console.log("CAPTCHA local solve error:", e);
    return null;
  }
}

function getAppointmentConfirmation() {
  return fetch("https://www.usvisascheduling.com/en-US/appointment-confirmation/")
    .then((e) => e.text())
    .then((e) => e);
}

function randomFileName(len = 5) {
  return (
    Array.from({ length: len }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(62 * Math.random())
      )
    ).join("") + ".png"
  );
}

function flattenScheduleDays(e) {
  return e.length ? e.reduce((acc, t) => ((acc[t.ID] = t.Date), acc), {}) : {};
}

// ─── TELEGRAM BOT COMMANDS (2-way communication) ─────────────────

const TG_POLL_ALARM = "telegram-poll";
const TG_POLL_INTERVAL = 0.25; // minutes (15 seconds)

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TG_POLL_ALARM) pollTelegramCommands();
});

function startTelegramPolling() {
  chrome.storage.local.get(["telegramBotToken", "telegramChatId"], (data) => {
    if (data.telegramBotToken && data.telegramChatId) {
      chrome.alarms.create(TG_POLL_ALARM, { periodInMinutes: TG_POLL_INTERVAL });
      console.log("Telegram polling started");
    }
  });
}

function stopTelegramPolling() {
  chrome.alarms.clear(TG_POLL_ALARM);
  console.log("Telegram polling stopped");
}

chrome.runtime.onStartup.addListener(startTelegramPolling);
chrome.runtime.onInstalled.addListener(() => {
  setTimeout(startTelegramPolling, 2000);
});

async function sendTelegramReply(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.log("Telegram reply error:", e);
  }
}

function deriveProfileName(username) {
  if (!username) return "User";
  const atIdx = username.indexOf("@");
  return atIdx > 0 ? username.substring(0, atIdx) : username;
}

function statusLabel(status) {
  const labels = {
    idle: "Idle", logging_in: "Logging In", security_questions: "Security Qs",
    on_dashboard: "Dashboard", cycling: "Cycling", slot_found: "Slot Found",
    confirmed: "Confirmed", rate_limited: "Rate Limited",
    session_expired: "Session Expired", error: "Error",
  };
  return labels[status] || status || "Idle";
}

async function pollTelegramCommands() {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["telegramBotToken", "telegramChatId", "tgLastUpdateId"], r);
  });
  if (!data.telegramBotToken || !data.telegramChatId) return;

  const token = data.telegramBotToken;
  const chatId = data.telegramChatId;

  // First run: flush old messages to avoid processing stale commands
  if (data.tgLastUpdateId === undefined || data.tgLastUpdateId === null) {
    try {
      const flushResp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=1`);
      if (flushResp.ok) {
        const flushResult = await flushResp.json();
        if (flushResult.ok && flushResult.result && flushResult.result.length > 0) {
          const lastId = flushResult.result[flushResult.result.length - 1].update_id;
          chrome.storage.local.set({ tgLastUpdateId: lastId });
          console.log("Telegram: flushed old messages, starting from update_id " + lastId);
        } else {
          chrome.storage.local.set({ tgLastUpdateId: 0 });
        }
      }
    } catch (e) { console.log("Telegram flush error:", e); }
    return;
  }

  const offset = data.tgLastUpdateId + 1;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1&allowed_updates=["message"]`);
    if (!resp.ok) return;
    const result = await resp.json();
    if (!result.ok || !result.result || result.result.length === 0) return;

    let maxId = data.tgLastUpdateId || 0;
    for (const update of result.result) {
      if (update.update_id > maxId) maxId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text || String(msg.chat.id) !== String(chatId)) continue;
      await handleTelegramCommand(token, chatId, msg.text.trim());
    }
    chrome.storage.local.set({ tgLastUpdateId: maxId });
  } catch (e) {
    console.log("Telegram poll error:", e);
  }
}

async function handleTelegramCommand(token, chatId, text) {
  const parts = text.split(/\s+/);
  let cmd = parts[0].toLowerCase();
  let arg = parts.slice(1).join(" ").trim();

  // Handle /start_username, /stop_username, /logout_username style commands
  if (cmd.startsWith("/start_") && cmd.length > 7) {
    arg = cmd.substring(7);
    cmd = "/start";
  } else if (cmd.startsWith("/stop_") && cmd.length > 6) {
    arg = cmd.substring(6);
    cmd = "/stop";
  } else if (cmd.startsWith("/logout_") && cmd.length > 8) {
    arg = cmd.substring(8);
    cmd = "/logout";
  }

  if (cmd === "/start" && arg) {
    await tgStartUser(token, chatId, arg);
  } else if (cmd === "/stop") {
    await tgStopUser(token, chatId, arg);
  } else if (cmd === "/logout") {
    await tgLogoutUser(token, chatId, arg);
  } else if (cmd === "/status") {
    await tgStatus(token, chatId);
  } else if (cmd === "/list") {
    await tgListUsers(token, chatId);
  } else if (cmd === "/help" || cmd === "/start") {
    await sendTelegramReply(token, chatId,
      `🤖 <b>Visa Bot Commands</b>\n\n` +
      `/start &lt;username&gt; — Start automation for a user\n` +
      `/stop — Stop active user\n` +
      `/stop &lt;username&gt; — Stop specific user\n` +
      `/logout — Logout active user\n` +
      `/logout &lt;username&gt; — Logout specific user\n` +
      `/status — Show current status\n` +
      `/list — Show all users\n` +
      `/help — Show this help`
    );
  }
}

function findUserByPartialName(profiles, query) {
  if (!query) return null;
  const q = query.toLowerCase();
  return profiles.find((p) => p.username.toLowerCase() === q) ||
    profiles.find((p) => p.username.toLowerCase().includes(q)) ||
    profiles.find((p) => (p.name || "").toLowerCase().includes(q));
}

async function tgStartUser(token, chatId, nameQuery) {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["userProfilesList", "activeAutomationUser"], r);
  });
  const profiles = data.userProfilesList || [];

  if (data.activeAutomationUser) {
    await sendTelegramReply(token, chatId,
      `⚠️ <b>${deriveProfileName(data.activeAutomationUser)}</b> is already active.\n\nUse /stop first, then /start ${nameQuery}`
    );
    return;
  }

  const profile = findUserByPartialName(profiles, nameQuery);
  if (!profile) {
    await sendTelegramReply(token, chatId, `❌ No user found matching "<b>${nameQuery}</b>".\n\nUse /list to see all users.`);
    return;
  }

  await new Promise((r) => {
    chrome.storage.local.set({
      loginDetails: { username: profile.username, password: profile.password },
      securityQuestions: profile.securityQuestions || {},
      "is_auto-login": profile.autoLogin !== false,
      "is_auto-dashboard": profile.autoDashboard !== false,
      "is_sel-1st-slot": profile.autoSelect !== false,
      "is_auto-submit": profile.autoSubmit === true,
      captchaMode: profile.captchaMode || "manual",
    }, r);
  });

  await new Promise((r) => chrome.storage.local.remove("__stopSignal", r));

  await new Promise((r) => {
    chrome.storage.local.get(["userStatuses"], (d) => {
      const statuses = d.userStatuses || {};
      statuses[profile.username] = { status: "logging_in", updatedAt: new Date().toISOString() };
      chrome.storage.local.set({ userStatuses: statuses, activeAutomationUser: profile.username }, r);
    });
  });

  chrome.tabs.query({ url: "https://*.usvisascheduling.com/*" }, (tabs) => {
    if (tabs.length > 0) {
      const tab = tabs[0];
      if (tab.url && (tab.url.includes("/ofc-schedule") || tab.url.includes("/schedule"))) {
        chrome.tabs.update(tab.id, { active: true });
        chrome.tabs.sendMessage(tab.id, { action: "startCycling" }, () => {
          if (chrome.runtime.lastError) chrome.tabs.update(tab.id, { url: tab.url });
        });
      } else {
        chrome.tabs.update(tab.id, { active: true, url: "https://www.usvisascheduling.com/en-US/" });
      }
    } else {
      chrome.tabs.create({ url: "https://www.usvisascheduling.com/en-US/" });
    }
  });

  await sendTelegramReply(token, chatId,
    `✅ <b>Starting ${deriveProfileName(profile.username)}</b>\n\n🔄 Logging in and navigating to booking page...`
  );
}

async function tgStopUser(token, chatId, nameQuery) {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["activeAutomationUser", "userProfilesList", "userStatuses"], r);
  });

  let targetUser = data.activeAutomationUser;
  if (nameQuery) {
    const profile = findUserByPartialName(data.userProfilesList || [], nameQuery);
    if (profile) targetUser = profile.username;
  }

  if (!targetUser) {
    await sendTelegramReply(token, chatId, `ℹ️ No active user to stop.`);
    return;
  }

  chrome.storage.local.remove("activeAutomationUser");
  chrome.storage.local.set({ __stopSignal: Date.now() });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.url && (tab.url.includes("usvisascheduling.com") || tab.url.includes("b2clogin.com"))) {
        chrome.tabs.sendMessage(tab.id, { action: "stopAll" }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    });
  });

  const statuses = data.userStatuses || {};
  statuses[targetUser] = { ...(statuses[targetUser] || {}), status: "idle", updatedAt: new Date().toISOString() };
  chrome.storage.local.set({ userStatuses: statuses });

  await sendTelegramReply(token, chatId, `⏹ <b>Stopped ${deriveProfileName(targetUser)}</b>\n\nAutomation halted. Session still active.`);
}

async function tgLogoutUser(token, chatId, nameQuery) {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["activeAutomationUser", "userProfilesList", "userStatuses"], r);
  });

  let targetUser = data.activeAutomationUser;
  if (nameQuery) {
    const profile = findUserByPartialName(data.userProfilesList || [], nameQuery);
    if (profile) targetUser = profile.username;
  }

  if (!targetUser) {
    await sendTelegramReply(token, chatId, `ℹ️ No active user to logout.`);
    return;
  }

  chrome.storage.local.remove(["activeAutomationUser", "loginDetails", "securityQuestions"]);
  chrome.storage.local.set({ __stopSignal: Date.now() });
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.url && (tab.url.includes("usvisascheduling.com") || tab.url.includes("b2clogin.com"))) {
        chrome.tabs.sendMessage(tab.id, { action: "stopAll" }, () => { if (chrome.runtime.lastError) {} });
        chrome.tabs.sendMessage(tab.id, { action: "logout" }, () => { if (chrome.runtime.lastError) {} });
      }
    });
  });

  const statuses = data.userStatuses || {};
  statuses[targetUser] = { ...(statuses[targetUser] || {}), status: "idle", updatedAt: new Date().toISOString() };
  chrome.storage.local.set({ userStatuses: statuses });

  await sendTelegramReply(token, chatId, `🚪 <b>Logged out ${deriveProfileName(targetUser)}</b>\n\n🔒 Session cleared. Ready for next user.`);
}

async function tgStatus(token, chatId) {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["activeAutomationUser", "userStatuses", "userProfilesList"], r);
  });

  const activeUser = data.activeAutomationUser;
  const statuses = data.userStatuses || {};
  const profiles = data.userProfilesList || [];

  if (!activeUser) {
    await sendTelegramReply(token, chatId, `ℹ️ <b>No active user</b>\n\n${profiles.length} user(s) configured.\nUse /start &lt;username&gt; to begin.`);
    return;
  }

  const s = statuses[activeUser] || {};
  const profile = profiles.find((p) => p.username === activeUser);
  const locs = profile?.locations?.join(", ") || "—";
  const dates = profile?.startDate && profile?.endDate ? `${profile.startDate} → ${profile.endDate}` : "—";

  let msg = `📊 <b>Current Status</b>\n\n`;
  msg += `👤 <b>User:</b> ${deriveProfileName(activeUser)}\n`;
  msg += `📌 <b>Status:</b> ${statusLabel(s.status)}\n`;
  msg += `📍 <b>Locations:</b> ${locs}\n`;
  msg += `📅 <b>Date Range:</b> ${dates}\n`;
  if (s.updatedAt) msg += `🕐 <b>Updated:</b> ${new Date(s.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

  await sendTelegramReply(token, chatId, msg);
}

async function tgListUsers(token, chatId) {
  const data = await new Promise((r) => {
    chrome.storage.local.get(["userProfilesList", "userStatuses", "activeAutomationUser"], r);
  });

  const profiles = data.userProfilesList || [];
  const statuses = data.userStatuses || {};
  const activeUser = data.activeAutomationUser;

  if (profiles.length === 0) {
    await sendTelegramReply(token, chatId, `ℹ️ No users configured. Add users from the dashboard.`);
    return;
  }

  let msg = `👥 <b>All Users (${profiles.length})</b>\n\n`;
  profiles.forEach((p, i) => {
    const s = statuses[p.username] || {};
    const isActive = p.username === activeUser;
    const icon = isActive ? "🟢" : "⚪";
    const name = p.name || deriveProfileName(p.username);
    const visa = p.visaType || "—";
    const locs = p.locations?.join(", ") || "—";
    const shortName = deriveProfileName(p.username);
    msg += `${icon} <b>${name}</b>${isActive ? " ⬅️ ACTIVE" : ""}\n`;
    msg += `    📧 <code>${p.username}</code>\n`;
    msg += `    📌 ${statusLabel(s.status)} · ${visa} · ${locs}\n`;
    msg += `    ▶️ /start_${shortName}  ⏹ /stop_${shortName}  🚪 /logout_${shortName}\n\n`;
  });


  await sendTelegramReply(token, chatId, msg);
}

// Re-start polling when Telegram settings are saved
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "telegramSettingsUpdated") {
    stopTelegramPolling();
    startTelegramPolling();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CAPTCHA solving request from content script
  if (msg.action === "solveCaptcha") {
    (async () => {
      try {
        const resp = await fetch("http://localhost:5123/solve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: msg.imageBase64 }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.text) {
            console.log("CAPTCHA solved:", data.text);
            sendResponse({ text: data.text });
            return;
          }
        }
      } catch (e) {
        console.log("Local CAPTCHA server error:", e);
      }
      sendResponse({ text: null });
    })();
    return true;
  }

  // Telegram notification
  if (msg.action === "sendTelegram") {
    (async () => {
      try {
        const { telegramBotToken, telegramChatId } = await new Promise((r) => {
          chrome.storage.local.get(["telegramBotToken", "telegramChatId"], r);
        });
        if (!telegramBotToken || !telegramChatId) {
          sendResponse({ ok: false, error: "Telegram not configured" });
          return;
        }
        const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: msg.text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        const data = await resp.json();
        if (data.ok) {
          console.log("Telegram notification sent");
          sendResponse({ ok: true });
        } else {
          console.log("Telegram error:", data.description);
          sendResponse({ ok: false, error: data.description });
        }
      } catch (e) {
        console.log("Telegram send error:", e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Get appointment confirmation
  if (msg.action === "getApntConfDets") {
    (async () => {
      try {
        const html = await getAppointmentConfirmation();
        sendResponse({ apntConfDets: html });
      } catch (e) {
        console.log("getApntConfDets error:", e);
        sendResponse({ apntConfDets: null });
      }
    })();
    return true;
  }

  // Appointment confirmation push
  if (msg.resource === "/push/appointment-confirmation") {
    chrome.storage.local.get(["apiKey", "extVersion"], function (settings) {
      const formData = new FormData();
      ["apntDetails", "userDetails", "capturedAt"].forEach((key) => {
        if (msg.hasOwnProperty(key)) {
          const val = msg[key];
          formData.append(
            key,
            typeof val === "object" && val !== null ? JSON.stringify(val) : val
          );
        }
      });

      fetch("https://app.checkvisaslots.com" + msg.resource, {
        headers: {
          "x-api-key": settings.apiKey,
          extVersion: settings.extVersion,
        },
        method: "POST",
        body: formData,
      })
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          console.log("Error sending appointment confirmation:", e);
          sendResponse({ success: false, error: e });
        });
    });
    return true;
  }

  // Slot data push (existing functionality)
  if (msg.resource && msg.imgUri && msg.portal_id) {
    const queryString = sender?.tab?.url?.split("?")[1] ?? null;
    chrome.storage.local.get(
      ["apiKey", "userProfiles", "extVersion", "sn_uid_valid"],
      function (settings) {
        try {
          let slotPage = msg.slot_page;
          let profile = JSON.parse(settings.userProfiles)[msg.portal_id];
          let [header, b64data] = msg.imgUri.split(",");
          let decoded = atob(b64data);
          let bytes = Array.from({ length: decoded.length }).map((_, i) =>
            decoded.charCodeAt(i)
          );
          let filename = randomFileName();
          let formData = new FormData();

          formData.append(
            "input",
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
            filename
          );

          if (profile.hasOwnProperty("VisaClass")) {
            let visaDets = { VisaClass: profile.VisaClass };
            if (profile.VisaClassID) visaDets.VisaClassID = profile.VisaClassID;
            if (profile.visaPriority)
              visaDets.visaPriority = profile.visaPriority;
            formData.append("visaDetails", JSON.stringify(visaDets));
          } else {
            formData.append("visaDetails", profile.visaDetails);
          }

          formData.append("userDetails", profile.userDetails);
          formData.append(
            "apntDetails",
            JSON.stringify(profile.apntDetails)
          );
          formData.append("applicants", profile.applicantsCount);
          formData.append(
            "slotDetails",
            JSON.stringify(slotPage.slotDetails)
          );
          formData.append(
            "appointmentTimes",
            JSON.stringify(slotPage.appointmentTimes)
          );
          formData.append("visaCountry", profile?.visaCountry);
          formData.append("slotLocationVal", slotPage.slotLocationVal);
          if (queryString) formData.append("pageUri", queryString);
          if (
            slotPage.hasOwnProperty("slotdetails") &&
            settings.sn_uid_valid
          ) {
            formData.append(
              "slotdetails",
              btoa(
                JSON.stringify(flattenScheduleDays(slotPage.slotdetails)).replaceAll(
                  "T00:00:00",
                  ""
                )
              )
            );
          }

          fetch("https://app.checkvisaslots.com" + msg.resource, {
            headers: {
              "x-api-key": settings.apiKey,
              extVersion: settings.extVersion,
            },
            method: "POST",
            body: formData,
          }).catch((e) => console.log(e));
        } catch (e) {
          console.log("Slot push error:", e);
        }
      }
    );
  }

  return true;
});
