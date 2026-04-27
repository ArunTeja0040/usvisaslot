(function () {
  "use strict";

  const REFRESH_INTERVAL = 2000;
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function sendDashboardTelegram(type, message) {
    chrome.storage.local.get(["telegramBotToken", "telegramChatId", "telegramNotify"], (data) => {
      if (!data.telegramBotToken || !data.telegramChatId) return;
      const notify = data.telegramNotify || { slot: true, confirmed: true, error: true, rate: true, login: true, cycling: true, stopped: true, logout: true };
      if (notify[type] === false) return;
      const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" });
      const fullMessage = message + `\n\n🕐 <i>${ts} IST</i>`;
      chrome.runtime.sendMessage({ action: "sendTelegram", text: fullMessage }, (resp) => {
        if (chrome.runtime.lastError) console.log("Telegram send failed:", chrome.runtime.lastError.message);
      });
    });
  }

  function formatTime(isoString) {
    if (!isoString) return "—";
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }

  function timeAgo(isoString) {
    if (!isoString) return "";
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  }

  function deriveProfileName(username) {
    if (!username) return "User";
    const atIdx = username.indexOf("@");
    return atIdx > 0 ? username.substring(0, atIdx) : username;
  }

  function statusLabel(status) {
    const labels = {
      idle: "Idle", logging_in: "Logging In",
      security_questions: "Security Qs", on_dashboard: "Dashboard",
      cycling: "Cycling", slot_found: "Slot Found", confirmed: "Confirmed",
      no_slots: "No Slots", rate_limited: "Rate Limited",
      session_expired: "Session Expired", error: "Error",
    };
    return labels[status] || status || "Idle";
  }

  function loadData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ["userProfilesList", "userStatuses", "eventLog"],
        (data) => resolve({
          profiles: data.userProfilesList || [],
          statuses: data.userStatuses || {},
          events: data.eventLog || [],
        })
      );
    });
  }

  // ─── STATS ─────────────────────────────────────────────────────────

  function updateStats(profiles, statuses, events) {
    document.getElementById("stat-total").textContent = profiles.length;

    const statusValues = Object.values(statuses);
    document.getElementById("stat-active").textContent =
      statusValues.filter((s) => ["cycling", "logging_in", "security_questions", "on_dashboard"].includes(s.status)).length;
    document.getElementById("stat-slots-found").textContent =
      statusValues.filter((s) => s.status === "slot_found").length;
    document.getElementById("stat-confirmed").textContent =
      statusValues.filter((s) => s.status === "confirmed").length;

    const errors = events.filter((e) => e.type === "error");
    document.getElementById("stat-errors").textContent = errors.length;

    const captchaEvents = events.filter((e) => e.type === "captcha");
    const captchaSolved = captchaEvents.filter((e) => e.message.includes("Solved"));
    const rate = captchaEvents.length > 0
      ? Math.round((captchaSolved.length / captchaEvents.length) * 100) : 0;
    document.getElementById("stat-captcha").textContent = rate + "%";
  }

  // ─── USER CARDS ────────────────────────────────────────────────────

  function renderUserCards(profiles, statuses) {
    const container = document.getElementById("user-cards");
    const filterStatus = document.getElementById("filter-status").value;

    const filtered = profiles.filter((p) => {
      if (filterStatus === "all") return true;
      const userStatus = statuses[p.username]?.status || "idle";
      if (filterStatus === "error") {
        return ["rate_limited", "session_expired", "error"].includes(userStatus);
      }
      return userStatus === filterStatus;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="log-empty">No users match the filter</div>';
      return;
    }

    container.innerHTML = filtered.map((profile) => {
      const status = statuses[profile.username] || {};
      const userStatus = status.status || "idle";
      const name = esc(profile.name || deriveProfileName(profile.username));
      const isActive = ["cycling", "logging_in", "security_questions", "on_dashboard"].includes(userStatus);

      let cardClass = "user-card";
      if (isActive) cardClass += " active";
      else if (userStatus === "confirmed") cardClass += " confirmed";
      else if (userStatus === "slot_found") cardClass += " slot-found";
      else if (["rate_limited", "session_expired", "error"].includes(userStatus)) cardClass += " error";

      const locs = (profile.locations || []).map((l) => `<span class="loc-tag">${esc(l)}</span>`).join("");
      const safeUser = esc(profile.username);

      return `
        <div class="${cardClass}" data-username="${safeUser}">
          <div class="card-header">
            <div>
              <div class="card-name">${name}</div>
              <div class="card-username">${safeUser}</div>
            </div>
            <span class="status-badge status-${userStatus}">${statusLabel(userStatus)}</span>
          </div>
          <div class="card-details">
            <div class="card-detail">
              <span class="detail-label">Dates:</span>
              <span class="detail-value">${formatDate(profile.startDate)} — ${formatDate(profile.endDate)}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">Visa:</span>
              <span class="detail-value">${esc(profile.visaType) || "—"}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">Price:</span>
              <span class="detail-value">${profile.agreedPrice ? "₹" + Number(profile.agreedPrice).toLocaleString() : "—"}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">CAPTCHA:</span>
              <span class="detail-value">${esc(profile.captchaMode) || "manual"}</span>
            </div>
          </div>
          ${locs ? `<div class="card-locations">${locs}</div>` : ""}
          <div class="card-actions">
            ${isActive
              ? `<button class="btn btn-small btn-red btn-stop" data-user="${safeUser}">Stop</button>
                 <button class="btn btn-small btn-orange btn-logout" data-user="${safeUser}">Logout</button>`
              : `<button class="btn btn-small btn-green btn-start" data-user="${safeUser}">Start Now</button>`}
            <button class="btn btn-small btn-gray btn-edit" data-user="${safeUser}">Edit</button>
          </div>
          <div class="card-footer">
            ${status.updatedAt ? "Updated " + timeAgo(status.updatedAt) : "No activity yet"}
            ${status.foundAt ? " · Slot found " + timeAgo(status.foundAt) : ""}
            ${status.confirmedAt ? " · Confirmed " + timeAgo(status.confirmedAt) : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  // ─── ACTIVITY LOG ──────────────────────────────────────────────────

  function renderActivityLog(events) {
    const container = document.getElementById("activity-log");
    const filterUser = document.getElementById("log-filter-user").value;
    const filterType = document.getElementById("log-filter-type").value;

    let filtered = events;
    if (filterUser !== "all") filtered = filtered.filter((e) => e.username === filterUser);
    if (filterType !== "all") filtered = filtered.filter((e) => e.type === filterType);

    const displayEvents = filtered.slice(0, 200);

    if (displayEvents.length === 0) {
      container.innerHTML = '<div class="log-empty">No events to display</div>';
      return;
    }

    container.innerHTML = displayEvents.map((e) => {
      const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      return `
      <div class="log-entry">
        <span class="log-time">${formatTime(e.timestamp)}</span>
        <span class="log-type log-type-${esc(e.type)}">${esc(e.type)}</span>
        <span class="log-user">${esc(deriveProfileName(e.username))}</span>
        <span class="log-message">${esc(e.message)}</span>
      </div>`;
    }).join("");
  }

  function updateLogUserFilter(profiles) {
    const select = document.getElementById("log-filter-user");
    const current = select.value;
    const opts = ['<option value="all">All Users</option>'];
    profiles.forEach((p) => {
      const name = p.name || deriveProfileName(p.username);
      opts.push(`<option value="${p.username}"${p.username === current ? " selected" : ""}>${name}</option>`);
    });
    select.innerHTML = opts.join("");
  }

  // ─── USER ACTIONS ──────────────────────────────────────────────────

  function activateUser(username, callback) {
    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = data.userProfilesList || [];
      const profile = profiles.find((p) => p.username === username);
      if (!profile) return;

      chrome.storage.local.set({
        loginDetails: { username: profile.username, password: profile.password },
        securityQuestions: profile.securityQuestions || {},
        "is_auto-login": profile.autoLogin !== false,
        "is_auto-dashboard": profile.autoDashboard !== false,
        "is_sel-1st-slot": profile.autoSelect !== false,
        "is_auto-submit": profile.autoSubmit === true,
        captchaMode: profile.captchaMode || "manual",
      }, () => {
        if (callback) callback(profile);
      });
    });
  }

  function openVisaSite() {
    chrome.tabs.query({ url: "https://*.usvisascheduling.com/*" }, (tabs) => {
      if (tabs.length > 0) {
        const tab = tabs[0];
        // If already on booking page, just activate the tab and tell it to start cycling
        if (tab.url && (tab.url.includes("/ofc-schedule") || tab.url.includes("/schedule"))) {
          chrome.tabs.update(tab.id, { active: true });
          chrome.tabs.sendMessage(tab.id, { action: "startCycling" }, () => {
            if (chrome.runtime.lastError) {
              console.log("startCycling message failed, reloading tab");
              chrome.tabs.update(tab.id, { url: tab.url });
            }
          });
        } else {
          chrome.tabs.update(tab.id, { active: true, url: "https://www.usvisascheduling.com/en-US/" });
        }
      } else {
        chrome.tabs.create({ url: "https://www.usvisascheduling.com/en-US/" });
      }
    });
  }

  function startUser(username) {
    activateUser(username, () => {
      chrome.storage.local.remove("__stopSignal", () => {
        chrome.storage.local.get(["userStatuses"], (d) => {
          const statuses = d.userStatuses || {};
          statuses[username] = { ...(statuses[username] || {}), status: "logging_in", updatedAt: new Date().toISOString() };
          chrome.storage.local.set({ userStatuses: statuses, activeAutomationUser: username }, () => {
            sendDashboardTelegram("login", `🚀 <b>STARTED</b>\n\n👤 <b>User:</b> ${username}\n🔄 Opening visa site & logging in...`);
            openVisaSite();
          });
        });
      });
    });
  }

  function stopUser(username) {
    sendDashboardTelegram("stopped", `⏹ <b>STOPPED</b>\n\n👤 <b>User:</b> ${username}\n📍 Stopped from dashboard`);
    // Clear persistent automation flag FIRST so page reloads won't restart
    chrome.storage.local.remove("activeAutomationUser");
    // Set a storage flag that the content script checks on its own
    chrome.storage.local.set({ __stopSignal: Date.now() });
    // Send stop to all visa tabs (both usvisascheduling and b2clogin)
    chrome.tabs.query({}, (tabs) => {
      let sent = 0;
      tabs.forEach((tab) => {
        if (tab.url && (tab.url.includes("usvisascheduling.com") || tab.url.includes("b2clogin.com"))) {
          sent++;
          chrome.tabs.sendMessage(tab.id, { action: "stopAll" }, (response) => {
            if (chrome.runtime.lastError) {
              console.log("Stop message failed for tab " + tab.id + ": " + chrome.runtime.lastError.message);
            } else {
              console.log("Stop message sent to tab " + tab.id, response);
            }
          });
        }
      });
      console.log("Stop sent to " + sent + " tabs");
    });
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = { ...(statuses[username] || {}), status: "idle", updatedAt: new Date().toISOString() };
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  function logoutUser(username) {
    sendDashboardTelegram("logout", `🚪 <b>LOGGED OUT</b>\n\n👤 <b>User:</b> ${username}\n🔒 Session cleared from dashboard\n✅ Ready for next user`);
    chrome.storage.local.remove(["activeAutomationUser", "loginDetails", "securityQuestions"]);
    chrome.storage.local.set({ __stopSignal: Date.now() });
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.url && (tab.url.includes("usvisascheduling.com") || tab.url.includes("b2clogin.com"))) {
          chrome.tabs.sendMessage(tab.id, { action: "stopAll" }, () => {
            if (chrome.runtime.lastError) console.log("Logout stop failed for tab " + tab.id);
          });
          chrome.tabs.sendMessage(tab.id, { action: "logout" }, () => {
            if (chrome.runtime.lastError) console.log("Logout message failed for tab " + tab.id);
          });
        }
      });
    });
    chrome.storage.local.get(["userStatuses"], (data) => {
      const statuses = data.userStatuses || {};
      statuses[username] = { ...(statuses[username] || {}), status: "idle", updatedAt: new Date().toISOString() };
      chrome.storage.local.set({ userStatuses: statuses });
    });
  }

  document.getElementById("clear-log-btn").addEventListener("click", () => {
    chrome.storage.local.set({ eventLog: [] });
  });

  // ─── EXPORT / IMPORT ──────────────────────────────────────────────

  document.getElementById("export-btn").addEventListener("click", () => {
    if (!confirm("Export includes passwords in plaintext. Keep the file secure.\n\nContinue?")) return;
    chrome.storage.local.get(["userProfilesList", "userStatuses"], (data) => {
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: data.userProfilesList || [],
        statuses: data.userStatuses || {},
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "visa-profiles-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  document.getElementById("import-btn").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });

  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const importData = JSON.parse(evt.target.result);
        const rawProfiles = importData.profiles;
        if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
          alert("No valid profiles found in file.");
          return;
        }
        const profiles = rawProfiles.filter((p) => p && typeof p.username === "string" && p.username.trim());
        if (profiles.length === 0) {
          alert("No profiles with valid usernames found.");
          return;
        }

        const mode = confirm(
          `Found ${profiles.length} profiles.\n\nOK = Merge (add new, update existing)\nCancel = Replace all existing profiles`
        );

        chrome.storage.local.get(["userProfilesList"], (data) => {
          let finalProfiles;

          if (mode) {
            // Merge mode
            finalProfiles = [...(data.userProfilesList || [])];
            for (const imported of profiles) {
              const idx = finalProfiles.findIndex((p) => p.username === imported.username);
              if (idx >= 0) {
                finalProfiles[idx] = { ...finalProfiles[idx], ...imported };
              } else {
                finalProfiles.push(imported);
              }
            }
          } else {
            // Replace mode
            finalProfiles = profiles;
          }

          const updates = { userProfilesList: finalProfiles };
          if (importData.statuses) {
            updates.userStatuses = importData.statuses;
          }

          chrome.storage.local.set(updates, () => {
            alert(`Imported ${profiles.length} profiles successfully!`);
            refresh();
          });
        });
      } catch (err) {
        alert("Invalid JSON file: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // Event delegation for user card buttons
  document.getElementById("user-cards").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-user]");
    if (!btn) return;
    const username = btn.dataset.user;
    if (btn.classList.contains("btn-start")) {
      startUser(username);
    } else if (btn.classList.contains("btn-stop")) {
      stopUser(username);
    } else if (btn.classList.contains("btn-logout")) {
      logoutUser(username);
    } else if (btn.classList.contains("btn-edit")) {
      openEditModal(username);
    }
  });

  // ─── MAIN REFRESH LOOP ────────────────────────────────────────────

  async function refresh() {
    const data = await loadData();
    updateStats(data.profiles, data.statuses, data.events);
    renderUserCards(data.profiles, data.statuses);
    renderActivityLog(data.events);
    updateLogUserFilter(data.profiles);

    // Update header with active user
    const badge = document.getElementById("active-user-status");
    const activeStatuses = Object.entries(data.statuses).filter(([, s]) =>
      ["cycling", "logging_in", "security_questions", "on_dashboard"].includes(s.status)
    );
    if (activeStatuses.length > 0) {
      const [user, s] = activeStatuses[0];
      badge.textContent = `Active: ${deriveProfileName(user)} — ${statusLabel(s.status)}`;
      badge.className = "queue-badge running";
    } else {
      badge.textContent = "No active user";
      badge.className = "queue-badge";
    }
  }

  document.getElementById("filter-status").addEventListener("change", refresh);
  document.getElementById("log-filter-user").addEventListener("change", refresh);
  document.getElementById("log-filter-type").addEventListener("change", refresh);

  // ─── EDIT MODAL ────────────────────────────────────────────────────

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

  const LOCATIONS = ["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"];

  function buildQOptions() {
    return '<option value="">-- Select --</option>' +
      SECURITY_QUESTIONS.map((q) => `<option value="${q}">${q}</option>`).join("");
  }

  // Populate question dropdowns once
  const qOpts = buildQOptions();
  document.getElementById("edit-q1").innerHTML = qOpts;
  document.getElementById("edit-q2").innerHTML = qOpts;
  document.getElementById("edit-q3").innerHTML = qOpts;

  function openEditModal(username) {
    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = data.userProfilesList || [];
      const profile = profiles.find((p) => p.username === username);
      if (!profile) return;

      document.getElementById("edit-original-username").value = username;
      document.getElementById("edit-modal-title").textContent = "Edit — " + (profile.name || deriveProfileName(username));
      document.getElementById("edit-username").value = profile.username || "";
      document.getElementById("edit-password").value = profile.password || "";

      // Security questions
      const qEntries = Object.entries(profile.securityQuestions || {});
      for (let i = 0; i < 3; i++) {
        document.getElementById("edit-q" + (i + 1)).value = qEntries[i] ? qEntries[i][0] : "";
        document.getElementById("edit-a" + (i + 1)).value = qEntries[i] ? qEntries[i][1] : "";
      }

      // Dates
      document.getElementById("edit-start-date").value = profile.startDate || "";
      document.getElementById("edit-end-date").value = profile.endDate || "";

      // Locations
      const savedLocs = profile.locations || [];
      document.querySelectorAll("#edit-locations input[type=checkbox]").forEach((cb) => {
        cb.checked = savedLocs.length === 0 || savedLocs.includes(cb.value);
      });

      // Other fields
      document.getElementById("edit-visa-type").value = profile.visaType || "";
      document.getElementById("edit-price").value = profile.agreedPrice || "";

      // Automation
      document.getElementById("edit-auto-login").checked = profile.autoLogin !== false;
      document.getElementById("edit-auto-dashboard").checked = profile.autoDashboard !== false;
      document.getElementById("edit-auto-select").checked = profile.autoSelect !== false;
      document.getElementById("edit-auto-submit").checked = profile.autoSubmit === true;

      const captchaRadio = document.querySelector(`input[name="edit-captcha"][value="${profile.captchaMode || "manual"}"]`);
      if (captchaRadio) captchaRadio.checked = true;

      document.getElementById("edit-delete-btn").style.display = "inline-block";
      document.getElementById("edit-modal").style.display = "flex";
    });
  }

  function closeEditModal() {
    document.getElementById("edit-modal").style.display = "none";
  }

  function saveEdit() {
    const originalUsername = document.getElementById("edit-original-username").value;

    const securityQuestions = {};
    for (let i = 1; i <= 3; i++) {
      const q = document.getElementById("edit-q" + i).value;
      const a = document.getElementById("edit-a" + i).value.trim();
      if (q && a) securityQuestions[q] = a;
    }

    const locations = [];
    document.querySelectorAll("#edit-locations input[type=checkbox]:checked").forEach((cb) => {
      locations.push(cb.value);
    });

    const captchaMode = (document.querySelector('input[name="edit-captcha"]:checked') || {}).value || "manual";

    const updated = {
      username: document.getElementById("edit-username").value.trim(),
      password: document.getElementById("edit-password").value.trim(),
      name: deriveProfileName(document.getElementById("edit-username").value.trim()),
      securityQuestions,
      startDate: document.getElementById("edit-start-date").value,
      endDate: document.getElementById("edit-end-date").value,
      locations,
      visaType: document.getElementById("edit-visa-type").value.trim(),
      agreedPrice: document.getElementById("edit-price").value.trim(),
      autoLogin: document.getElementById("edit-auto-login").checked,
      autoDashboard: document.getElementById("edit-auto-dashboard").checked,
      autoSelect: document.getElementById("edit-auto-select").checked,
      autoSubmit: document.getElementById("edit-auto-submit").checked,
      captchaMode,
    };

    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = data.userProfilesList || [];
      const idx = profiles.findIndex((p) => p.username === originalUsername);
      if (idx >= 0) {
        profiles[idx] = { ...profiles[idx], ...updated };
      } else {
        profiles.push(updated);
      }
      chrome.storage.local.set({ userProfilesList: profiles }, () => {
        closeEditModal();
        refresh();
      });
    });
  }

  function deleteProfile() {
    const username = document.getElementById("edit-original-username").value;
    if (!confirm("Delete profile for \"" + deriveProfileName(username) + "\"?")) return;

    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = (data.userProfilesList || []).filter((p) => p.username !== username);
      chrome.storage.local.set({ userProfilesList: profiles }, () => {
        closeEditModal();
        refresh();
      });
    });
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
        return Math.min((weekNum - 1) * 7 + 1, new Date(year, monthNum + 1, 0).getDate());
      }
      return null;
    }

    const firstEntry = monthEntries[0];
    const lastEntry = monthEntries[monthEntries.length - 1];
    const startWeekDay = weekToDay(firstEntry.num, lower.substring(firstEntry.idx));
    const startDay = startWeekDay || 1;
    const startDate = `${year}-${String(firstEntry.num + 1).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
    const endWeekDay = weekToDay(lastEntry.num, lower.substring(lastEntry.idx));
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
      visaType: "", agreedPrice: "",
      autoLogin: true, autoDashboard: true, autoSelect: true,
      autoSubmit: false, captchaMode: "auto",
    };

    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let pendingQuestion = null;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      const exactQ = SECURITY_QUESTIONS.find((q) =>
        line.replace(/[*\d]/g, "").trim().toLowerCase() === q.toLowerCase() ||
        line.toLowerCase().includes(q.toLowerCase().substring(0, 30))
      );
      if (exactQ) { pendingQuestion = exactQ; continue; }

      if (pendingQuestion && /^ans(wer)?\s*[:.]?\s*/i.test(line)) {
        const answer = line.replace(/^ans(wer)?\s*[:.]?\s*/i, "").trim();
        if (answer) profile.securityQuestions[pendingQuestion] = answer;
        pendingQuestion = null;
        continue;
      }

      if (/^security\s+question\s*\d/i.test(line)) continue;
      pendingQuestion = null;

      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) {
        if (/(\d+\.?\d*)\s*k/i.test(line)) profile.agreedPrice = parsePrice(line);
        continue;
      }

      const key = line.substring(0, colonIdx).replace(/[.\s]+$/g, "").trim();
      const value = line.substring(colonIdx + 1).trim();
      const keyLower = key.toLowerCase().replace(/[^a-z\s]/g, "");

      if (/u?ser\s*name|user\s*id|email/i.test(keyLower)) { profile.username = value; continue; }
      if (/pass\s*word|pwd/i.test(keyLower)) { profile.password = value; continue; }
      if (/date|month|when|prefer.*date|slot.*date/i.test(keyLower)) {
        const { startDate, endDate } = parseMonthRange(value);
        if (startDate) profile.startDate = startDate;
        if (endDate) profile.endDate = endDate;
        continue;
      }
      if (/location|city|consulate|place.*prefer|prefer.*place/i.test(keyLower)) { profile.locations = parseLocations(value); continue; }
      if (/visa|typ.*visa|visa.*typ/i.test(keyLower)) { profile.visaType = value.replace(/\s+/g, "").toUpperCase(); continue; }
      if (/price|cost|amount|fee|\d+\s*k/i.test(key) || (/agreed|confirm|ok|done/i.test(value) && /\d/.test(key))) { profile.agreedPrice = parsePrice(key + " " + value); continue; }

      const question = matchSecurityQuestion(key);
      if (question) { profile.securityQuestions[question] = value; continue; }
    }

    if (profile.username) profile.name = deriveProfileName(profile.username);
    return profile;
  }

  function fillModalFromProfile(profile) {
    if (profile.username) document.getElementById("edit-username").value = profile.username;
    if (profile.password) document.getElementById("edit-password").value = profile.password;

    const qEntries = Object.entries(profile.securityQuestions || {});
    for (let i = 0; i < 3; i++) {
      document.getElementById("edit-q" + (i + 1)).value = qEntries[i] ? qEntries[i][0] : "";
      document.getElementById("edit-a" + (i + 1)).value = qEntries[i] ? qEntries[i][1] : "";
    }

    if (profile.startDate) document.getElementById("edit-start-date").value = profile.startDate;
    if (profile.endDate) document.getElementById("edit-end-date").value = profile.endDate;

    if (profile.locations && profile.locations.length > 0) {
      document.querySelectorAll("#edit-locations input[type=checkbox]").forEach((cb) => {
        cb.checked = profile.locations.includes(cb.value);
      });
    }

    if (profile.visaType) document.getElementById("edit-visa-type").value = profile.visaType;
    if (profile.agreedPrice) document.getElementById("edit-price").value = profile.agreedPrice;
  }

  document.getElementById("edit-paste-toggle").addEventListener("click", () => {
    const area = document.getElementById("edit-paste-area");
    area.style.display = area.style.display === "none" ? "block" : "none";
  });

  document.getElementById("edit-paste-parse").addEventListener("click", () => {
    const text = document.getElementById("edit-paste-box").value.trim();
    const statusEl = document.getElementById("edit-paste-status");
    if (!text) { statusEl.textContent = "Paste a message first"; return; }

    const parsed = parseClientMessage(text);
    if (!parsed.username) { statusEl.textContent = "Could not find username in message"; return; }

    fillModalFromProfile(parsed);
    const parts = [];
    if (parsed.username) parts.push("username");
    if (parsed.password) parts.push("password");
    const qCount = Object.keys(parsed.securityQuestions).length;
    if (qCount) parts.push(qCount + " security Q");
    if (parsed.startDate) parts.push("dates");
    if (parsed.locations.length) parts.push(parsed.locations.join(", "));
    if (parsed.visaType) parts.push(parsed.visaType);
    if (parsed.agreedPrice) parts.push("₹" + Number(parsed.agreedPrice).toLocaleString());
    statusEl.textContent = "Filled: " + parts.join(", ");
    statusEl.style.color = "#81c784";
  });

  document.getElementById("add-user-btn").addEventListener("click", () => {
    document.getElementById("edit-original-username").value = "";
    document.getElementById("edit-modal-title").textContent = "Add New User";
    document.getElementById("edit-username").value = "";
    document.getElementById("edit-password").value = "";
    for (let i = 1; i <= 3; i++) {
      document.getElementById("edit-q" + i).value = "";
      document.getElementById("edit-a" + i).value = "";
    }
    document.getElementById("edit-start-date").value = "";
    document.getElementById("edit-end-date").value = "";
    document.querySelectorAll("#edit-locations input[type=checkbox]").forEach((cb) => { cb.checked = false; });
    document.getElementById("edit-visa-type").value = "";
    document.getElementById("edit-price").value = "";
    document.getElementById("edit-auto-login").checked = true;
    document.getElementById("edit-auto-dashboard").checked = true;
    document.getElementById("edit-auto-select").checked = true;
    document.getElementById("edit-auto-submit").checked = false;
    document.querySelector('input[name="edit-captcha"][value="auto"]').checked = true;
    document.getElementById("edit-delete-btn").style.display = "none";
    document.getElementById("edit-paste-area").style.display = "none";
    document.getElementById("edit-paste-box").value = "";
    document.getElementById("edit-paste-status").textContent = "";
    document.getElementById("edit-modal").style.display = "flex";
  });

  document.getElementById("edit-close-btn").addEventListener("click", closeEditModal);
  document.getElementById("edit-cancel-btn").addEventListener("click", closeEditModal);
  document.getElementById("edit-save-btn").addEventListener("click", saveEdit);
  document.getElementById("edit-delete-btn").addEventListener("click", deleteProfile);

  // Close modal on overlay click
  document.getElementById("edit-modal").addEventListener("click", (e) => {
    if (e.target.id === "edit-modal") closeEditModal();
  });

  // ─── TELEGRAM SETTINGS ──────────────────────────────────────────

  document.getElementById("telegram-btn").addEventListener("click", () => {
    chrome.storage.local.get(["telegramBotToken", "telegramChatId", "telegramNotify"], (data) => {
      document.getElementById("tg-bot-token").value = data.telegramBotToken || "";
      document.getElementById("tg-chat-id").value = data.telegramChatId || "";
      const notify = data.telegramNotify || { slot: true, confirmed: true, error: true, rate: true, login: true, cycling: true, stopped: true, logout: true };
      document.getElementById("tg-notify-slot").checked = notify.slot !== false;
      document.getElementById("tg-notify-confirmed").checked = notify.confirmed !== false;
      document.getElementById("tg-notify-error").checked = notify.error !== false;
      document.getElementById("tg-notify-rate").checked = notify.rate !== false;
      document.getElementById("tg-notify-login").checked = notify.login !== false;
      document.getElementById("tg-notify-cycling").checked = notify.cycling !== false;
      document.getElementById("tg-notify-stopped").checked = notify.stopped !== false;
      document.getElementById("tg-notify-logout").checked = notify.logout !== false;
      document.getElementById("tg-status").textContent = "";
      document.getElementById("telegram-modal").style.display = "flex";
    });
  });

  document.getElementById("tg-close-btn").addEventListener("click", () => {
    document.getElementById("telegram-modal").style.display = "none";
  });

  document.getElementById("telegram-modal").addEventListener("click", (e) => {
    if (e.target.id === "telegram-modal") {
      document.getElementById("telegram-modal").style.display = "none";
    }
  });

  document.getElementById("tg-save-btn").addEventListener("click", () => {
    const token = document.getElementById("tg-bot-token").value.trim();
    const chatId = document.getElementById("tg-chat-id").value.trim();
    const notify = {
      slot: document.getElementById("tg-notify-slot").checked,
      confirmed: document.getElementById("tg-notify-confirmed").checked,
      error: document.getElementById("tg-notify-error").checked,
      rate: document.getElementById("tg-notify-rate").checked,
      login: document.getElementById("tg-notify-login").checked,
      cycling: document.getElementById("tg-notify-cycling").checked,
      stopped: document.getElementById("tg-notify-stopped").checked,
      logout: document.getElementById("tg-notify-logout").checked,
    };
    chrome.storage.local.set({ telegramBotToken: token, telegramChatId: chatId, telegramNotify: notify }, () => {
      chrome.runtime.sendMessage({ action: "telegramSettingsUpdated" }, () => {
        if (chrome.runtime.lastError) console.log("Polling restart signal failed");
      });
      const status = document.getElementById("tg-status");
      status.textContent = "Saved!";
      status.style.color = "#81c784";
      setTimeout(() => { status.textContent = ""; }, 3000);
    });
  });

  document.getElementById("tg-test-btn").addEventListener("click", () => {
    const token = document.getElementById("tg-bot-token").value.trim();
    const chatId = document.getElementById("tg-chat-id").value.trim();
    const status = document.getElementById("tg-status");

    if (!token || !chatId) {
      status.textContent = "Enter both Bot Token and Chat ID";
      status.style.color = "#ef5350";
      return;
    }

    status.textContent = "Sending...";
    status.style.color = "#78909c";

    // Save first, then send test via service worker
    chrome.storage.local.set({ telegramBotToken: token, telegramChatId: chatId }, () => {
      chrome.runtime.sendMessage({
        action: "sendTelegram",
        text: "✅ <b>Test Notification</b>\n\nUS Visa Auto Booking is connected!\nYou will receive alerts for slot found, booking confirmed, and errors."
      }, (resp) => {
        if (chrome.runtime.lastError) {
          status.textContent = "Failed: " + chrome.runtime.lastError.message;
          status.style.color = "#ef5350";
        } else if (resp && resp.ok) {
          status.textContent = "Test sent! Check your Telegram.";
          status.style.color = "#81c784";
        } else {
          status.textContent = "Failed: " + (resp?.error || "Unknown error");
          status.style.color = "#ef5350";
        }
      });
    });
  });

  refresh();
  setInterval(refresh, REFRESH_INTERVAL);
})();
