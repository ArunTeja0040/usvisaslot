(function () {
  "use strict";

  const REFRESH_INTERVAL = 2000;
  const SUPABASE_POLL_INTERVAL = 30000;
  const STALE_DEVICE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Supabase-sourced profiles + device map (shared across all Chromes)
  let cloudProfiles = [];
  let cloudDevices = {};  // deviceId → { device_name, last_seen }

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
        ["userProfilesList", "userStatuses", "eventLog", "slotHistory", "dailyStats", "__storageStats"],
        (data) => resolve({
          profiles: data.userProfilesList || [],
          statuses: data.userStatuses || {},
          events: data.eventLog || [],
          slotHistory: data.slotHistory || [],
          dailyStats: data.dailyStats || {},
          storageStats: data.__storageStats || null,
        })
      );
    });
  }

  // ─── STATS ─────────────────────────────────────────────────────────

  function updateStats(profiles, statuses, events) {
    document.getElementById("stat-total").textContent = profiles.length;

    // Use cloud data if available, fallback to local
    const ACTIVE_STATES = ["cycling", "logging_in", "security_questions", "on_dashboard"];
    const cloudStatusMap = {};
    cloudProfiles.forEach(cp => { cloudStatusMap[cp.username] = cp; });

    let activeCount = 0, slotFoundCount = 0, confirmedCount = 0;
    for (const p of profiles) {
      const cloud = cloudStatusMap[p.username] || {};
      const local = statuses[p.username] || {};
      const st = ACTIVE_STATES.includes(local.status) ? local.status : (cloud.status || local.status || "idle");
      if (ACTIVE_STATES.includes(st)) activeCount++;
      if (st === "slot_found" || cloud.status === "slot_found") slotFoundCount++;
      if (st === "confirmed" || cloud.status === "confirmed") confirmedCount++;
    }

    document.getElementById("stat-active").textContent = activeCount;
    document.getElementById("stat-slots-found").textContent = slotFoundCount;
    document.getElementById("stat-confirmed").textContent = confirmedCount;

    const errors = events.filter((e) => e.type === "error");
    document.getElementById("stat-errors").textContent = errors.length;

    const captchaEvents = events.filter((e) => e.type === "captcha");
    const captchaSolved = captchaEvents.filter((e) => e.message.includes("Solved"));
    const rate = captchaEvents.length > 0
      ? Math.round((captchaSolved.length / captchaEvents.length) * 100) : 0;
    document.getElementById("stat-captcha").textContent = rate + "%";
  }

  // ─── USER CARDS ────────────────────────────────────────────────────

  function renderUserCards(profiles, statuses, slotHistory) {
    const container = document.getElementById("user-cards");
    const filterStatus = document.getElementById("filter-status").value;
    const filterVisa = document.getElementById("filter-visa")?.value || "all";
    const filterMonth = document.getElementById("filter-month")?.value || "all";

    // Build slot stats per user
    const slotStats = {};
    (slotHistory || []).forEach((s) => {
      const u = s.username;
      if (!slotStats[u]) {
        slotStats[u] = {
          total: 0, inRange: 0, outRange: 0,
          confirmed: 0, submitted: 0, selected: 0, detected: 0,
          lastFoundAt: null, lastLocation: null, lastDate: null,
        };
      }
      slotStats[u].total++;
      if (s.inRange) slotStats[u].inRange++;
      else slotStats[u].outRange++;
      if (slotStats[u][s.action] !== undefined) slotStats[u][s.action]++;
      if (!slotStats[u].lastFoundAt || new Date(s.foundAt) > new Date(slotStats[u].lastFoundAt)) {
        slotStats[u].lastFoundAt = s.foundAt;
        slotStats[u].lastLocation = s.location;
        slotStats[u].lastDate = s.date;
      }
    });

    const filtered = profiles.filter((p) => {
      // Status filter
      if (filterStatus !== "all") {
        const userStatus = statuses[p.username]?.status || "idle";
        if (filterStatus === "error") {
          if (!["rate_limited", "session_expired", "error"].includes(userStatus)) return false;
        } else if (userStatus !== filterStatus) {
          return false;
        }
      }
      // Visa filter
      if (filterVisa !== "all") {
        const visa = (p.visaType || "").trim().toUpperCase();
        if (filterVisa === "__unset__") {
          if (visa) return false;
        } else if (visa !== filterVisa.toUpperCase()) {
          return false;
        }
      }
      // Month filter — show user if selected month falls within their date range
      if (filterMonth !== "all") {
        const m = parseInt(filterMonth);
        const start = p.startDate ? new Date(p.startDate + "T00:00:00") : null;
        const end = p.endDate ? new Date(p.endDate + "T00:00:00") : null;
        if (!start && !end) return false;
        const startMonth = start ? start.getFullYear() * 12 + start.getMonth() + 1 : 0;
        const endMonth = end ? end.getFullYear() * 12 + end.getMonth() + 1 : 9999;
        // Check all possible years the user's range spans
        let monthInRange = false;
        for (let y = (start ? start.getFullYear() : 2026); y <= (end ? end.getFullYear() : 2027); y++) {
          const check = y * 12 + m;
          if (check >= startMonth && check <= endMonth) { monthInRange = true; break; }
        }
        if (!monthInRange) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="log-empty">No users match the filter</div>';
      return;
    }

    // Build cloud status map: username → { status, activeDeviceId, isActive }
    const cloudStatusMap = {};
    cloudProfiles.forEach(cp => {
      cloudStatusMap[cp.username] = { status: cp.status, activeDeviceId: cp.activeDeviceId, isActive: cp.isActive };
    });

    const myDeviceId = SUPA ? SUPA.getDeviceId() : null;

    container.innerHTML = filtered.map((profile) => {
      const status = statuses[profile.username] || {};
      const cloud = cloudStatusMap[profile.username] || {};
      // Use local status if active, otherwise prefer cloud
      const ACTIVE_STATES = ["cycling", "logging_in", "security_questions", "on_dashboard", "slot_found"];
      const localSt = status.status || "";
      const cloudSt = cloud.status || "";
      const userStatus = ACTIVE_STATES.includes(localSt) ? localSt : (ACTIVE_STATES.includes(cloudSt) ? cloudSt : (localSt || cloudSt || "idle"));
      const name = esc(profile.name || deriveProfileName(profile.username));
      const isActive = ["cycling", "logging_in", "security_questions", "on_dashboard"].includes(userStatus);
      const cloudIsRunning = cloud.isActive || ["cycling", "logging_in", "security_questions", "on_dashboard", "slot_found"].includes(cloud.status);
      const activeOnOtherDevice = cloudIsRunning && cloud.activeDeviceId && cloud.activeDeviceId !== myDeviceId;
      const activeDevice = cloud.activeDeviceId ? cloudDevices[cloud.activeDeviceId] : null;
      const activeDeviceName = activeDevice ? activeDevice.name : null;
      const deviceLastSeen = activeDevice && activeDevice.lastSeen ? timeAgo(activeDevice.lastSeen) : null;
      const isStaleDevice = activeDevice && activeDevice.lastSeen && (Date.now() - new Date(activeDevice.lastSeen).getTime() > STALE_DEVICE_THRESHOLD_MS);

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
          ${activeOnOtherDevice ? `<div style="background:#e74c3c22;border:1px solid #e74c3c55;border-radius:4px;padding:4px 8px;margin:4px 0;font-size:11px;color:#ef5350;">⚠️ Active on <b>${esc(activeDeviceName || "another device")}</b> ${deviceLastSeen ? `(${deviceLastSeen})` : ""} ${isStaleDevice ? '<span style="color:#f39c12;"> — stale</span>' : ""}</div>` : ""}
          ${isActive && activeDeviceName && !activeOnOtherDevice ? `<div style="font-size:11px;color:#3ecf8e;margin:2px 0;">📍 Running on <b>${esc(activeDeviceName)}</b> ${deviceLastSeen ? `(${deviceLastSeen})` : ""}</div>` : ""}
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
              <span class="detail-label">Applicants:</span>
              <span class="detail-value">${profile.applicantCount || 1}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">Price:</span>
              <span class="detail-value">${profile.agreedPrice ? "₹" + Number(profile.agreedPrice).toLocaleString() + (profile.applicantCount > 1 ? " (" + (profile.pricePerPerson || profile.agreedPrice) + "/pp)" : "") : "—"}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">CAPTCHA:</span>
              <span class="detail-value">${esc(profile.captchaMode) || "manual"}</span>
            </div>
          </div>
          ${locs ? `<div class="card-locations">${locs}</div>` : ""}

          ${(() => {
            const st = slotStats[profile.username];
            if (!st) return `<div class="card-slots-summary" style="margin-top:8px;padding:6px 8px;background:#0f1923;border-radius:4px;font-size:11px;color:#78909c;">📜 No slot history yet</div>`;
            const lastInfo = st.lastFoundAt
              ? `· Last: <b>${esc(st.lastLocation)}</b> ${esc(st.lastDate)} (${timeAgo(st.lastFoundAt)})`
              : "";
            return `
              <div class="card-slots-summary" style="margin-top:8px;padding:6px 8px;background:#0f1923;border-radius:4px;font-size:11px;color:#cfd8dc;">
                🎯 <b>${st.total}</b> slots seen
                · ✅ <b style="color:#27ae60;">${st.inRange}</b> in range
                · ⚪ ${st.outRange} out
                ${st.confirmed > 0 ? `· 🎉 <b style="color:#27ae60;">${st.confirmed} confirmed</b>` : ""}
                ${st.submitted > 0 && st.confirmed === 0 ? `· ⏳ ${st.submitted} submitted` : ""}
                <div style="margin-top:3px;color:#78909c;">${lastInfo}</div>
              </div>`;
          })()}

          <div class="card-actions">
            ${activeOnOtherDevice
              ? `<span style="font-size:11px;color:#ef5350;font-weight:bold;">Running on ${esc(activeDeviceName || "other device")}</span>
                 <button class="btn btn-small btn-force-start" data-user="${safeUser}" data-device="${esc(activeDeviceName || "other device")}" style="background:#7f8c8d;color:white;font-size:10px;" title="Hold Shift+Click to force start">Force Start</button>`
              : isActive
                ? `<button class="btn btn-small btn-red btn-stop" data-user="${safeUser}">Stop</button>
                   <button class="btn btn-small btn-orange btn-logout" data-user="${safeUser}">Logout</button>`
                : `<button class="btn btn-small btn-green btn-start" data-user="${safeUser}">Start Now</button>`}
            <button class="btn btn-small btn-gray btn-edit" data-user="${safeUser}">Edit</button>
            <button class="btn btn-small btn-blue btn-history" data-user="${safeUser}" style="background:#3498db;color:white;">📜 History</button>
          </div>
          ${(() => {
            const r = status.roundCount || 0;
            const e = status.errorCount || 0;
            const inR = status.slotsInRangeFound || 0;
            const outR = status.slotsOutOfRangeFound || 0;
            const last429 = status.last429At ? `· 🟠 429 ${timeAgo(status.last429At)} ` : "";
            const last401 = status.last401At ? `· 🔴 401 ${timeAgo(status.last401At)} ` : "";
            // Hide only if user never started cycling AND no errors AND no slots
            const hasAnyData = r > 0 || e > 0 || inR > 0 || outR > 0 || status.cycleStartedAt || isActive;
            if (!hasAnyData) return "";
            return `
              <div class="card-counters" style="margin-top:6px;padding:5px 8px;background:#0a1119;border-radius:4px;font-size:11px;color:#b0bec5;display:flex;flex-wrap:wrap;gap:8px;">
                <span>🔁 Round <b>${r}</b></span>
                <span style="color:${e > 0 ? '#e74c3c' : '#78909c'};">⚠️ <b>${e}</b> errors</span>
                <span style="color:#27ae60;">✅ <b>${inR}</b> in</span>
                <span style="color:#90a4ae;">⚪ ${outR} out</span>
                ${last429}${last401}
              </div>`;
          })()}
          <div class="card-footer">
            ${status.updatedAt ? "Updated " + timeAgo(status.updatedAt) : "No activity yet"}
            ${status.cycleStartedAt ? " · Started " + timeAgo(status.cycleStartedAt) : ""}
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

    // Slot history user filter mirror
    const sselect = document.getElementById("slot-filter-user");
    if (sselect) {
      const cur2 = sselect.value;
      const opts2 = ['<option value="all">All Users</option>'];
      profiles.forEach((p) => {
        const name = p.name || deriveProfileName(p.username);
        opts2.push(`<option value="${p.username}"${p.username === cur2 ? " selected" : ""}>${name}</option>`);
      });
      sselect.innerHTML = opts2.join("");
    }
  }

  // ─── DAILY/WEEKLY STATS ────────────────────────────────────────────

  function istDayKeyFromDate(d) {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(d.getTime() + istOffsetMs);
    return ist.toISOString().substring(0, 10);
  }

  function renderStats(dailyStats, storageStats) {
    const container = document.getElementById("stats-pane");
    if (!container) return;

    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = istDayKeyFromDate(d);
      const s = dailyStats[key] || null;
      days.push({ key, label: i === 0 ? "Today" : i === 1 ? "Yesterday" : key, stats: s });
    }

    const last7 = days.slice(0, 7).map(d => d.stats).filter(Boolean);
    const weekTotal = {
      slotsFound: 0, slotsInRange: 0, booked: 0, missed: 0, errors: 0,
      byLocation: {}, byHour: {},
    };
    last7.forEach(s => {
      weekTotal.slotsFound += s.slotsFound || 0;
      weekTotal.slotsInRange += s.slotsInRange || 0;
      weekTotal.booked += s.booked || 0;
      weekTotal.missed += s.missed || 0;
      weekTotal.errors += s.errors || 0;
      for (const [k, v] of Object.entries(s.byLocation || {})) {
        weekTotal.byLocation[k] = (weekTotal.byLocation[k] || 0) + v;
      }
      for (const [k, v] of Object.entries(s.byHour || {})) {
        weekTotal.byHour[k] = (weekTotal.byHour[k] || 0) + v;
      }
    });

    const topLocs = Object.entries(weekTotal.byLocation).sort((a, b) => b[1] - a[1]);
    const topHours = Object.entries(weekTotal.byHour).sort((a, b) => b[1] - a[1]);

    // Hour heatmap (24 hours)
    const maxHour = Math.max(...Object.values(weekTotal.byHour), 1);
    const hourBars = Array.from({ length: 24 }, (_, h) => {
      const key = String(h).padStart(2, "0");
      const v = weekTotal.byHour[key] || 0;
      const pct = (v / maxHour) * 100;
      const color = pct > 60 ? "#27ae60" : pct > 30 ? "#f39c12" : pct > 0 ? "#3498db" : "#2d3e50";
      return `<div style="display:inline-block;width:20px;height:${Math.max(pct * 0.6, 2)}px;background:${color};margin:0 1px;vertical-align:bottom;" title="${key}:00 → ${v}"></div>`;
    }).join("");

    const dayBars = days.slice(0, 14).reverse().map(d => {
      const total = d.stats?.slotsFound || 0;
      const inR = d.stats?.slotsInRange || 0;
      const max = Math.max(...days.map(x => x.stats?.slotsFound || 0), 1);
      const h = (total / max) * 80;
      const inH = (inR / max) * 80;
      return `
        <div style="display:inline-block;width:36px;text-align:center;margin:0 2px;vertical-align:bottom;">
          <div style="position:relative;height:80px;display:flex;flex-direction:column;justify-content:flex-end;">
            <div style="height:${h - inH}px;background:#90a4ae;border-radius:2px 2px 0 0;"></div>
            <div style="height:${inH}px;background:#27ae60;"></div>
          </div>
          <div style="font-size:9px;color:#78909c;margin-top:2px;">${d.label.substring(5) || d.label.substring(0, 3)}</div>
          <div style="font-size:10px;color:#cfd8dc;font-weight:bold;">${total}</div>
        </div>`;
    }).join("");

    const storageBar = storageStats ? `
      <div style="margin-top:14px;padding:8px;background:#0a1119;border-radius:6px;">
        <div style="font-size:11px;color:#78909c;margin-bottom:4px;">Storage: ${storageStats.mb} MB / 10 MB</div>
        <div style="height:6px;background:#1a2733;border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${(storageStats.mb / 10) * 100}%;background:${storageStats.mb > 8 ? '#e74c3c' : storageStats.mb > 6 ? '#f39c12' : '#27ae60'};"></div>
        </div>
        ${storageStats.lastPrune ? `<div style="font-size:10px;color:#78909c;margin-top:4px;">Last prune: ${timeAgo(storageStats.lastPrune.at)} (${storageStats.lastPrune.pruned.join(", ")})</div>` : ""}
      </div>` : "";

    container.innerHTML = `
      <div style="padding:14px;color:#cfd8dc;">
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px;">
          <div style="background:#0a1119;padding:10px;border-radius:6px;text-align:center;">
            <div style="font-size:22px;font-weight:bold;color:#3498db;">${weekTotal.slotsFound}</div>
            <div style="font-size:10px;color:#78909c;">Slots (7d)</div>
          </div>
          <div style="background:#0a1119;padding:10px;border-radius:6px;text-align:center;">
            <div style="font-size:22px;font-weight:bold;color:#27ae60;">${weekTotal.slotsInRange}</div>
            <div style="font-size:10px;color:#78909c;">In Range</div>
          </div>
          <div style="background:#0a1119;padding:10px;border-radius:6px;text-align:center;">
            <div style="font-size:22px;font-weight:bold;color:#27ae60;">${weekTotal.booked}</div>
            <div style="font-size:10px;color:#78909c;">Booked</div>
          </div>
          <div style="background:#0a1119;padding:10px;border-radius:6px;text-align:center;">
            <div style="font-size:22px;font-weight:bold;color:#e67e22;">${weekTotal.missed}</div>
            <div style="font-size:10px;color:#78909c;">Missed</div>
          </div>
          <div style="background:#0a1119;padding:10px;border-radius:6px;text-align:center;">
            <div style="font-size:22px;font-weight:bold;color:#e74c3c;">${weekTotal.errors}</div>
            <div style="font-size:10px;color:#78909c;">Errors</div>
          </div>
        </div>

        <div style="background:#0a1119;padding:12px;border-radius:6px;margin-bottom:14px;">
          <div style="font-size:12px;color:#78909c;margin-bottom:8px;font-weight:bold;">📅 LAST 14 DAYS</div>
          <div style="display:flex;align-items:flex-end;justify-content:flex-start;flex-wrap:nowrap;overflow-x:auto;">
            ${dayBars}
          </div>
          <div style="font-size:10px;color:#78909c;margin-top:6px;">
            <span style="color:#27ae60;">■</span> In range
            <span style="color:#90a4ae;margin-left:10px;">■</span> Out of range
          </div>
        </div>

        <div style="background:#0a1119;padding:12px;border-radius:6px;margin-bottom:14px;">
          <div style="font-size:12px;color:#78909c;margin-bottom:8px;font-weight:bold;">🕐 HOUR HEATMAP (IST, last 7 days)</div>
          <div style="white-space:nowrap;overflow-x:auto;">${hourBars}</div>
          <div style="font-size:9px;color:#78909c;margin-top:4px;display:flex;justify-content:space-between;">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div style="background:#0a1119;padding:12px;border-radius:6px;">
            <div style="font-size:12px;color:#78909c;margin-bottom:8px;font-weight:bold;">📍 TOP LOCATIONS</div>
            ${topLocs.length === 0 ? '<div style="color:#78909c;font-size:11px;">No data</div>' :
              topLocs.slice(0, 5).map(([loc, c]) => `
                <div style="font-size:12px;display:flex;justify-content:space-between;padding:3px 0;">
                  <span>${loc}</span><b>${c}</b>
                </div>`).join("")}
          </div>
          <div style="background:#0a1119;padding:12px;border-radius:6px;">
            <div style="font-size:12px;color:#78909c;margin-bottom:8px;font-weight:bold;">🔥 HOT HOURS</div>
            ${topHours.length === 0 ? '<div style="color:#78909c;font-size:11px;">No data</div>' :
              topHours.slice(0, 5).map(([h, c]) => `
                <div style="font-size:12px;display:flex;justify-content:space-between;padding:3px 0;">
                  <span>${h}:00 IST</span><b>${c}</b>
                </div>`).join("")}
          </div>
        </div>

        ${storageBar}
      </div>
    `;
  }

  // ─── SLOT HISTORY ──────────────────────────────────────────────────

  function renderSlotHistory(history, profiles) {
    const container = document.getElementById("slot-history");
    if (!container) return;

    const fUser = document.getElementById("slot-filter-user")?.value || "all";
    const fLoc = document.getElementById("slot-filter-loc")?.value || "all";
    const fAct = document.getElementById("slot-filter-action")?.value || "all";
    const fRange = document.getElementById("slot-filter-range")?.value || "all";

    let filtered = history;
    if (fUser !== "all") filtered = filtered.filter((e) => e.username === fUser);
    if (fLoc !== "all") filtered = filtered.filter((e) => e.location === fLoc);
    if (fAct !== "all") filtered = filtered.filter((e) => e.action === fAct);
    if (fRange === "in") filtered = filtered.filter((e) => e.inRange);
    else if (fRange === "out") filtered = filtered.filter((e) => !e.inRange);

    const display = filtered.slice(0, 200);

    if (display.length === 0) {
      container.innerHTML = '<div class="log-empty">No slot history yet</div>';
      return;
    }

    const esc = (s) => (s || "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const actionColor = {
      detected: "#78909c",
      selected: "#3498db",
      submitted: "#f39c12",
      confirmed: "#27ae60",
      missed: "#e74c3c",
    };

    container.innerHTML = display.map((e) => {
      const color = actionColor[e.action] || "#78909c";
      const rangeIcon = e.inRange ? "✅" : "⚪";
      return `
      <div class="log-entry" style="border-left:3px solid ${color};">
        <span class="log-time">${formatTime(e.foundAt)}</span>
        <span class="log-type" style="background:${color};color:white;">${esc(e.action)}</span>
        <span class="log-user">${esc(deriveProfileName(e.username))}</span>
        <span class="log-message">${rangeIcon} ${esc(e.location)} → <b>${esc(e.date)}</b></span>
      </div>`;
    }).join("");
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

  async function preStartCheck(username) {
    if (!SUPA || !SUPA.isReady()) return true;
    try {
      const profiles = await SUPA.pullProfiles();
      const match = profiles.find(p => p.username === username);
      if (match && match.isActive && match.activeDeviceId && match.activeDeviceId !== SUPA.getDeviceId()) {
        const devName = cloudDevices[match.activeDeviceId]?.name || "another device";
        alert(`Cannot start "${username}".\n\nAlready running on "${devName}".\nStop it there first, or Shift+Click "Force Start".`);
        return false;
      }
    } catch (e) {
      console.warn("Pre-start check failed:", e.message);
    }
    return true;
  }

  async function forceStartUser(username) {
    if (SUPA && SUPA.isReady()) {
      await SUPA.updateProfileStatus(username, "idle", false);
    }
    startUser(username);
  }

  function startUser(username) {
    activateUser(username, () => {
      chrome.storage.local.remove("__stopSignal", () => {
        chrome.storage.local.get(["userStatuses"], (d) => {
          const statuses = d.userStatuses || {};
          statuses[username] = { ...(statuses[username] || {}), status: "logging_in", updatedAt: new Date().toISOString() };
          chrome.storage.local.set({ userStatuses: statuses, activeAutomationUser: username }, () => {
            if (SUPA && SUPA.isReady()) SUPA.updateProfileStatus(username, "logging_in", true);
            sendDashboardTelegram("login", `🚀 <b>STARTED</b>\n\n👤 <b>User:</b> ${username}\n🔄 Opening visa site & logging in...`);
            openVisaSite();
          });
        });
      });
    });
  }

  function stopUser(username) {
    sendDashboardTelegram("stopped", `⏹ <b>STOPPED</b>\n\n👤 <b>User:</b> ${username}\n📍 Stopped from dashboard`);
    if (SUPA && SUPA.isReady()) SUPA.updateProfileStatus(username, "idle", false);
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
    if (SUPA && SUPA.isReady()) SUPA.updateProfileStatus(username, "idle", false);
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

  document.getElementById("export-csv-btn").addEventListener("click", () => {
    if (!confirm("Export includes passwords in plaintext. Keep the file secure.\n\nContinue?")) return;
    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = data.userProfilesList || [];
      const headers = ["S.No", "Username", "Password", "Dates (From to To)", "Location", "Security Que Ans 1", "Security Que Ans 2", "Security Que Ans 3", "No of Applicants", "Price Agreed", "Category"];
      const csvEsc = (v) => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = [headers.join(",")];
      profiles.forEach((p, i) => {
        const qas = Object.entries(p.securityQuestions || {});
        const qa1 = qas[0] ? qas[0][0] + ": " + qas[0][1] : "";
        const qa2 = qas[1] ? qas[1][0] + ": " + qas[1][1] : "";
        const qa3 = qas[2] ? qas[2][0] + ": " + qas[2][1] : "";
        const locations = (p.locations || []).join(", ");
        const dates = (p.startDate && p.endDate) ? p.startDate + " to " + p.endDate : (p.startDate || p.endDate || "");
        rows.push([
          i + 1,
          csvEsc(p.username),
          csvEsc(p.password),
          csvEsc(dates),
          csvEsc(locations),
          csvEsc(qa1),
          csvEsc(qa2),
          csvEsc(qa3),
          p.applicantCount || 1,
          p.agreedPrice || "",
          csvEsc(p.visaType || ""),
        ].join(","));
      });
      const bom = "﻿";
      const blob = new Blob([bom + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "visa-profiles-" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // ─── GOOGLE SHEETS SYNC ────────────────────────────────────────────
  const SHEETS_ENABLED = typeof SheetsSync !== "undefined";

  async function sheetsAutoSync() {
    if (!SHEETS_ENABLED) return;
    try {
      const connected = await SheetsSync.isConnected();
      if (!connected) return;
      const profiles = await new Promise(r => chrome.storage.local.get(["userProfilesList"], d => r(d.userProfilesList || [])));
      await SheetsSync.fullSync(profiles);
      console.log("[Dashboard] Auto-synced to Google Sheets");
    } catch (e) {
      console.warn("[Dashboard] Sheets auto-sync failed:", e.message);
    }
  }

  async function updateSheetsUI() {
    if (!SHEETS_ENABLED) return;
    const btn = document.getElementById("sheets-sync-btn");
    const link = document.getElementById("sheets-link");
    const urlInput = document.getElementById("sheets-url-input");
    try {
      const connected = await SheetsSync.isConnected();
      if (connected) {
        btn.textContent = "🔄 Sync Sheets";
        btn.style.background = "#0f9d58";
        urlInput.style.display = "none";
        const sheetId = await SheetsSync.getSpreadsheetId();
        if (sheetId) {
          link.href = SheetsSync.getSheetUrl(sheetId);
          link.style.display = "inline";
        }
      } else {
        btn.textContent = "📊 Sheets Sync";
        btn.style.background = "#4285f4";
        link.style.display = "none";
        urlInput.style.display = "inline-block";
      }
    } catch { /* not connected */ }
  }

  updateSheetsUI();

  document.getElementById("sheets-sync-btn").addEventListener("click", async () => {
    const btn = document.getElementById("sheets-sync-btn");
    const urlInput = document.getElementById("sheets-url-input");
    const origText = btn.textContent;
    btn.textContent = "Connecting...";
    btn.disabled = true;
    try {
      const sheetUrl = urlInput.value.trim() || null;
      await SheetsSync.connect(sheetUrl);
      const profiles = await new Promise(r => chrome.storage.local.get(["userProfilesList"], d => r(d.userProfilesList || [])));
      btn.textContent = "Syncing...";
      const sheetId = await SheetsSync.fullSync(profiles);
      alert(`Synced ${profiles.length} profiles to Google Sheets!`);
      await updateSheetsUI();
      window.open(SheetsSync.getSheetUrl(sheetId), "_blank");
    } catch (e) {
      alert("Sheets sync failed: " + e.message);
      btn.textContent = origText;
    }
    btn.disabled = false;
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
            scheduleSheetsSync();
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
      preStartCheck(username).then(ok => { if (ok) startUser(username); });
    } else if (btn.classList.contains("btn-force-start")) {
      const deviceName = btn.dataset.device || "other device";
      if (!e.shiftKey) {
        alert(`This user is running on "${deviceName}".\n\nHold Shift + Click to force start.`);
        return;
      }
      if (!confirm(`Force start "${username}"?\n\nThis will mark it as stopped on "${deviceName}" and start it here.`)) return;
      forceStartUser(username);
    } else if (btn.classList.contains("btn-stop")) {
      stopUser(username);
    } else if (btn.classList.contains("btn-logout")) {
      logoutUser(username);
    } else if (btn.classList.contains("btn-edit")) {
      openEditModal(username);
    } else if (btn.classList.contains("btn-history")) {
      // Switch to slot history tab + auto-filter to this user
      const userSel = document.getElementById("slot-filter-user");
      if (userSel) userSel.value = username;
      switchTab("slots");
      refresh();
    }
  });

  // ─── MAIN REFRESH LOOP ────────────────────────────────────────────

  async function refresh() {
    const data = await loadData();
    updateStats(data.profiles, data.statuses, data.events);
    renderUserCards(data.profiles, data.statuses, data.slotHistory);
    renderActivityLog(data.events);
    renderSlotHistory(data.slotHistory, data.profiles);
    renderStats(data.dailyStats, data.storageStats);
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

  let __sheetsSyncTimer = null;
  function scheduleSheetsSync() {
    if (__sheetsSyncTimer) clearTimeout(__sheetsSyncTimer);
    __sheetsSyncTimer = setTimeout(() => { __sheetsSyncTimer = null; sheetsAutoSync(); }, 3000);
  }

  // ─── TOGGLE LOGS PANEL ─────────────────────────────────────────────
  const toggleBtn = document.getElementById("toggle-logs-btn");
  const rightPanel = document.querySelector(".right-panel");
  const leftPanel = document.querySelector(".left-panel");

  function applyLogsToggle(show) {
    if (show) {
      rightPanel.style.display = "";
      leftPanel.style.flex = "";
      leftPanel.style.maxWidth = "";
      toggleBtn.textContent = "Logs ◀";
    } else {
      rightPanel.style.display = "none";
      leftPanel.style.flex = "1 1 100%";
      leftPanel.style.maxWidth = "100%";
      toggleBtn.textContent = "Logs ▶";
    }
  }

  chrome.storage.local.get(["__dashboardShowLogs"], (d) => {
    const show = d.__dashboardShowLogs !== false;
    applyLogsToggle(show);
  });

  toggleBtn.addEventListener("click", () => {
    const isHidden = rightPanel.style.display === "none";
    applyLogsToggle(isHidden);
    chrome.storage.local.set({ __dashboardShowLogs: isHidden });
  });

  document.getElementById("filter-status").addEventListener("change", refresh);
  document.getElementById("filter-visa")?.addEventListener("change", refresh);
  document.getElementById("filter-month")?.addEventListener("change", refresh);
  document.getElementById("log-filter-user").addEventListener("change", refresh);
  document.getElementById("log-filter-type").addEventListener("change", refresh);

  // Slot history filters
  ["slot-filter-user", "slot-filter-loc", "slot-filter-action", "slot-filter-range"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", refresh);
  });

  // Clear slot history button
  document.getElementById("clear-slots-btn")?.addEventListener("click", () => {
    if (!confirm("Clear all slot history?")) return;
    chrome.storage.local.set({ slotHistory: [] }, refresh);
  });

  // Tab switching: Activity Log <-> Slot History <-> Stats
  function switchTab(tab) {
    const tabLog = document.getElementById("tab-log");
    const tabSlots = document.getElementById("tab-slots");
    const tabStats = document.getElementById("tab-stats");
    const ctrlA = document.getElementById("log-controls-activity");
    const ctrlS = document.getElementById("log-controls-slots");
    const paneA = document.getElementById("activity-log");
    const paneS = document.getElementById("slot-history");
    const paneStats = document.getElementById("stats-pane");

    // Reset all
    [tabLog, tabSlots, tabStats].forEach(el => el && (el.style.opacity = "0.5"));
    if (ctrlA) ctrlA.style.display = "none";
    if (ctrlS) ctrlS.style.display = "none";
    if (paneA) paneA.style.display = "none";
    if (paneS) paneS.style.display = "none";
    if (paneStats) paneStats.style.display = "none";

    if (tab === "slots") {
      tabSlots.style.opacity = "1";
      ctrlS.style.display = "flex";
      paneS.style.display = "block";
    } else if (tab === "stats") {
      tabStats.style.opacity = "1";
      paneStats.style.display = "block";
    } else {
      tabLog.style.opacity = "1";
      ctrlA.style.display = "flex";
      paneA.style.display = "block";
    }
  }
  document.getElementById("tab-log")?.addEventListener("click", () => switchTab("log"));
  document.getElementById("tab-slots")?.addEventListener("click", () => switchTab("slots"));
  document.getElementById("tab-stats")?.addEventListener("click", () => switchTab("stats"));

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
      document.getElementById("edit-applicants").value = profile.applicantCount || 1;
      document.getElementById("edit-price").value = profile.pricePerPerson || profile.agreedPrice || "";
      calcTotalPrice();

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
      applicantCount: parseInt(document.getElementById("edit-applicants").value) || 1,
      pricePerPerson: document.getElementById("edit-price").value.trim(),
      agreedPrice: String((parseInt(document.getElementById("edit-price").value) || 0) * (parseInt(document.getElementById("edit-applicants").value) || 1)),
      autoLogin: document.getElementById("edit-auto-login").checked,
      autoDashboard: document.getElementById("edit-auto-dashboard").checked,
      autoSelect: document.getElementById("edit-auto-select").checked,
      autoSubmit: document.getElementById("edit-auto-submit").checked,
      captchaMode,
    };

    chrome.storage.local.get(["userProfilesList"], async (data) => {
      const profiles = data.userProfilesList || [];
      const idx = profiles.findIndex((p) => p.username === originalUsername);
      if (idx >= 0) {
        profiles[idx] = { ...profiles[idx], ...updated };
      } else {
        profiles.push(updated);
      }
      // Write to Supabase first (primary), then local cache
      const saved = idx >= 0 ? profiles[idx] : updated;
      if (SUPA && SUPA.isReady()) {
        try { await SUPA.pushProfile(saved); } catch (e) { console.warn("Supabase push failed:", e.message); }
      }
      chrome.storage.local.set({ userProfilesList: profiles }, () => {
        closeEditModal();
        refresh();
        scheduleSheetsSync();
      });
    });
  }

  async function deleteProfile() {
    const username = document.getElementById("edit-original-username").value;
    if (!confirm("Delete profile for \"" + deriveProfileName(username) + "\"?")) return;

    // Delete from Supabase first
    if (SUPA && SUPA.isReady()) {
      try { await SUPA.deleteProfile(username); } catch (e) { console.warn("Supabase delete failed:", e.message); }
    }
    chrome.storage.local.get(["userProfilesList"], (data) => {
      const profiles = (data.userProfilesList || []).filter((p) => p.username !== username);
      chrome.storage.local.set({ userProfilesList: profiles }, () => {
        closeEditModal();
        refresh();
        scheduleSheetsSync();
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
      visaType: "", agreedPrice: "", pricePerPerson: "",
      applicantCount: 1,
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
      if (/number.*applicant|applicant.*count|no.*of.*applicant|applicants|members|family.*member/i.test(keyLower)) {
        const num = parseInt(value);
        if (num > 0) profile.applicantCount = num;
        continue;
      }
      if (/price|cost|amount|fee|\d+\s*k/i.test(key) || (/agreed|confirm|ok|done/i.test(value) && /\d/.test(key))) {
        const priceStr = parsePrice(key + " " + value);
        profile.pricePerPerson = priceStr;
        if (/each|per\s*person|per\s*head|per\s*applicant/i.test(key + " " + value)) {
          profile.agreedPrice = String((parseInt(priceStr) || 0) * profile.applicantCount);
        } else {
          profile.agreedPrice = priceStr;
        }
        continue;
      }

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
    if (profile.applicantCount) document.getElementById("edit-applicants").value = profile.applicantCount;
    if (profile.pricePerPerson || profile.agreedPrice) document.getElementById("edit-price").value = profile.pricePerPerson || profile.agreedPrice;
    calcTotalPrice();
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
    document.getElementById("edit-applicants").value = "1";
    document.getElementById("edit-price").value = "";
    document.getElementById("edit-total-price").value = "";
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
        text: "✅ <b>Test Notification</b>\n\nSlotHunter is connected!\nYou will receive alerts for slot found, booking confirmed, and errors."
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

  // ─── SUPABASE PROFILE SYNC ─────────────────────────────────────────

  async function pullCloudProfiles() {
    if (!SUPA || !SUPA.isReady()) return;
    if (!SUPA.hasEncryption()) {
      console.warn("[Dashboard] Skipping cloud pull — no encryption key (enter master password)");
      return;
    }
    try {
      const [profiles, devices] = await Promise.all([
        SUPA.pullProfiles(),
        SUPA.getDevices(),
      ]);
      cloudProfiles = profiles;
      cloudDevices = {};
      devices.forEach(d => { cloudDevices[d.id] = { name: d.device_name, lastSeen: d.last_seen }; });

      // Auto-cleanup stale active users (device heartbeat older than 10 min)
      const now = Date.now();
      for (const cp of cloudProfiles) {
        if (!cp.isActive || !cp.activeDeviceId) continue;
        const device = cloudDevices[cp.activeDeviceId];
        if (!device || !device.lastSeen) continue;
        const lastSeen = new Date(device.lastSeen).getTime();
        if (now - lastSeen > STALE_DEVICE_THRESHOLD_MS) {
          console.log(`[Dashboard] Stale cleanup: "${cp.username}" on "${device.name}" (last seen ${Math.round((now - lastSeen) / 60000)}min ago)`);
          await SUPA.updateProfileStatus(cp.username, "idle", false);
          cp.isActive = false;
          cp.status = "idle";
        }
      }

      // Merge cloud profiles into local storage (so booking logic can use them)
      const localData = await new Promise(r => chrome.storage.local.get(["userProfilesList"], r));
      let localProfiles = localData.userProfilesList || [];

      const canDecrypt = SUPA.hasEncryption();

      for (const cp of cloudProfiles) {
        const localProfile = {
          username: cp.username,
          autoLogin: cp.autoLogin,
          autoDashboard: cp.autoDashboard,
          autoSelect: cp.autoSelect,
          autoSubmit: cp.autoSubmit,
          captchaMode: cp.captchaMode,
          startDate: cp.startDate || "",
          endDate: cp.endDate || "",
          locations: cp.locations || [],
          visaType: cp.visaType || "",
          agreedPrice: cp.agreedPrice ? String(cp.agreedPrice) : "",
          applicantCount: cp.applicantCount || 1,
          pricePerPerson: cp.pricePerPerson ? String(cp.pricePerPerson) : "",
        };
        // Only merge password and security questions if decryption is available
        if (canDecrypt) {
          localProfile.password = cp.password;
          localProfile.securityQuestions = {};
          if (cp.securityQuestions) {
            cp.securityQuestions.forEach(sq => {
              if (sq.question && sq.answer) localProfile.securityQuestions[sq.question] = sq.answer;
            });
          }
        }
        const idx = localProfiles.findIndex(p => p.username === cp.username);
        if (idx >= 0) localProfiles[idx] = { ...localProfiles[idx], ...localProfile };
        else localProfiles.push(localProfile);
      }

      await new Promise(r => chrome.storage.local.set({ userProfilesList: localProfiles }, r));
      console.log("[Dashboard] Cloud sync: pulled", cloudProfiles.length, "profiles,", devices.length, "devices");
    } catch (e) {
      console.warn("[Dashboard] Cloud pull failed:", e.message);
    }
  }

  // Poll Supabase every 30s for fresh data
  let cloudPollTimer = null;
  function startCloudPolling() {
    if (cloudPollTimer) clearInterval(cloudPollTimer);
    pullCloudProfiles().then(() => refresh());
    cloudPollTimer = setInterval(async () => {
      await pullCloudProfiles();
      refresh();
    }, SUPABASE_POLL_INTERVAL);
  }

  // ─── TOTAL PRICE CALCULATOR ───────────────────────────────────────

  function calcTotalPrice() {
    const price = parseInt(document.getElementById("edit-price").value) || 0;
    const count = parseInt(document.getElementById("edit-applicants").value) || 1;
    const total = price * count;
    document.getElementById("edit-total-price").value = total > 0 ? total.toLocaleString("en-IN") : "";
  }

  document.getElementById("edit-price").addEventListener("input", calcTotalPrice);
  document.getElementById("edit-applicants").addEventListener("input", calcTotalPrice);

  // ─── CLOUD SYNC (SUPABASE) ────────────────────────────────────────

  const SUPA = typeof SupabaseSync !== "undefined" ? SupabaseSync : null;

  async function updateCloudUI() {
    const statusEl = document.getElementById("cloud-status");
    const pullBtn = document.getElementById("cloud-pull-btn");
    const pushBtn = document.getElementById("cloud-push-btn");
    const exportBtn = document.getElementById("cloud-export-btn");
    const importSection = document.getElementById("cloud-import-section");
    const deviceIdEl = document.getElementById("cloud-device-id");
    const deviceNameInput = document.getElementById("cloud-device-name");

    if (SUPA && SUPA.isReady()) {
      statusEl.textContent = "Connected";
      statusEl.style.color = "#81c784";
      pullBtn.style.display = "inline-block";
      pushBtn.style.display = "inline-block";
      if (exportBtn) exportBtn.style.display = "inline-block";
      if (importSection) importSection.style.display = "none";
      deviceIdEl.textContent = SUPA.getDeviceId() || "—";
      const savedName = await SUPA.getDeviceName();
      if (savedName && deviceNameInput) deviceNameInput.value = savedName;
      loadCloudDevices();
    } else {
      // Not connected — show import option
      if (importSection) importSection.style.display = "block";
    }
  }

  async function loadCloudDevices() {
    if (!SUPA || !SUPA.isReady()) return;
    const listEl = document.getElementById("cloud-devices-list");
    try {
      const devices = await SUPA.getDevices();
      if (devices.length === 0) { listEl.textContent = "No devices"; return; }
      const myId = SUPA.getDeviceId();
      listEl.innerHTML = devices.map(d => {
        const ago = timeSince(d.last_seen);
        const isMe = d.id === myId ? ' <span style="color:#3ecf8e;">(this device)</span>' : "";
        const deleteBtn = ` <button class="btn-delete-device" data-device-id="${d.id}" data-is-me="${d.id === myId}" data-device-name="${esc(d.device_name || "Unnamed")}" style="background:#e74c3c;color:white;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;font-weight:bold;margin-left:6px;">✕</button>`;
        return `<div style="margin-bottom:4px;">• <b>${esc(d.device_name || "Unnamed")}</b>${isMe} — last seen ${ago}${deleteBtn}</div>`;
      }).join("");

      // Wire up delete buttons
      listEl.querySelectorAll(".btn-delete-device").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const deviceId = btn.dataset.deviceId;
          const isMe = btn.dataset.isMe === "true";
          const deviceName = btn.dataset.deviceName;
          const confirmed = confirm(`Delete device "${deviceName}" from Supabase?${isMe ? " You'll need to re-connect Cloud Sync after." : ""}`);
          if (!confirmed) return;
          try {
            if (isMe) {
              await SUPA.deleteDevice();
              document.getElementById("cloud-status").textContent = "Device deleted. Re-connect to register.";
              document.getElementById("cloud-status").style.color = "#e74c3c";
              updateCloudUI();
            } else {
              // Delete other device directly via REST
              const opKey = document.getElementById("cloud-api-key").value.trim();
              const res = await fetch(`https://sbuaojiamicreyysvnqj.supabase.co/rest/v1/devices?id=eq.${deviceId}`, {
                method: "DELETE",
                headers: {
                  "apikey": "sb_publishable_OrTLSVqVljSOoIeUZIoIcw_O0udxgyq",
                  "Authorization": "Bearer sb_publishable_OrTLSVqVljSOoIeUZIoIcw_O0udxgyq",
                  "Content-Type": "application/json",
                  "Prefer": "return=representation",
                  "x-operator-key": opKey
                }
              });
              const body = await res.text();
              console.log("[CloudSync] Delete response:", res.status, body);
              if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
              if (body === "[]") throw new Error("RLS blocked delete — no rows affected. Check Supabase policies.");
              document.getElementById("cloud-status").textContent = `Deleted "${deviceName}"`;
              document.getElementById("cloud-status").style.color = "#27ae60";
            }
            // Small delay then refresh list
            await new Promise(r => setTimeout(r, 500));
            loadCloudDevices();
          } catch (err) {
            document.getElementById("cloud-status").textContent = "Delete failed: " + err.message;
            document.getElementById("cloud-status").style.color = "#e74c3c";
          }
        });
      });
    } catch (e) {
      listEl.textContent = "Error loading devices";
    }
  }

  function timeSince(isoStr) {
    if (!isoStr) return "never";
    const sec = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return Math.floor(sec / 60) + "m ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
    return Math.floor(sec / 86400) + "d ago";
  }

  // Cloud button → open modal
  document.getElementById("cloud-btn").addEventListener("click", () => {
    chrome.storage.local.get(["__supabase_operator_key"], (data) => {
      if (data.__supabase_operator_key) {
        document.getElementById("cloud-api-key").value = data.__supabase_operator_key;
      }
      document.getElementById("cloud-status").textContent = "";
      document.getElementById("cloud-modal").style.display = "flex";
      updateCloudUI();
    });
  });

  document.getElementById("cloud-close-btn").addEventListener("click", () => {
    document.getElementById("cloud-modal").style.display = "none";
  });

  document.getElementById("cloud-modal").addEventListener("click", (e) => {
    if (e.target.id === "cloud-modal") document.getElementById("cloud-modal").style.display = "none";
  });

  // Connect
  document.getElementById("cloud-connect-btn").addEventListener("click", async () => {
    const apiKey = document.getElementById("cloud-api-key").value.trim();
    const masterPw = document.getElementById("cloud-master-pw").value;
    const statusEl = document.getElementById("cloud-status");

    if (!apiKey) { statusEl.textContent = "Enter API key!"; statusEl.style.color = "#ef5350"; return; }
    if (!masterPw) { statusEl.textContent = "Enter master password!"; statusEl.style.color = "#ef5350"; return; }
    if (!SUPA) { statusEl.textContent = "SupabaseSync not loaded"; statusEl.style.color = "#ef5350"; return; }

    // Prompt for device name on first connect
    const existingDevice = await chrome.storage.local.get(["__supabase_device_id"]);
    let deviceName = null;
    if (!existingDevice.__supabase_device_id) {
      deviceName = prompt("Name this Chrome profile (e.g. Arun-Main, Kavita-Laptop):");
      if (!deviceName || !deviceName.trim()) { statusEl.textContent = "Device name required!"; statusEl.style.color = "#ef5350"; return; }
      deviceName = deviceName.trim();
    }

    statusEl.textContent = "Connecting...";
    statusEl.style.color = "#ffb74d";

    try {
      await SUPA.init(apiKey, masterPw, deviceName);

      // Push all existing local profiles
      const profiles = await new Promise(r => chrome.storage.local.get(["userProfilesList"], d => r(d.userProfilesList || [])));
      for (const p of profiles) { await SUPA.pushProfile(p); }

      statusEl.textContent = `Connected! ${profiles.length} profiles synced.`;
      statusEl.style.color = "#81c784";
      updateCloudUI();
      startCloudPolling();
    } catch (e) {
      statusEl.textContent = "Error: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  // Pull profiles from cloud (manual trigger)
  document.getElementById("cloud-pull-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("cloud-status");
    if (!SUPA || !SUPA.isReady()) { statusEl.textContent = "Not connected"; statusEl.style.color = "#ef5350"; return; }

    statusEl.textContent = "Pulling...";
    statusEl.style.color = "#ffb74d";

    try {
      await pullCloudProfiles();
      statusEl.textContent = `Pulled ${cloudProfiles.length} profiles!`;
      statusEl.style.color = "#81c784";
      refresh();
      scheduleSheetsSync();
    } catch (e) {
      statusEl.textContent = "Pull failed: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  // Push all local data to cloud
  document.getElementById("cloud-push-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("cloud-status");
    if (!SUPA || !SUPA.isReady()) { statusEl.textContent = "Not connected"; statusEl.style.color = "#ef5350"; return; }

    statusEl.textContent = "Pushing...";
    statusEl.style.color = "#ffb74d";

    try {
      const data = await new Promise(r => chrome.storage.local.get(["userProfilesList", "slotHistory", "eventLog"], r));

      // Push profiles
      const profiles = data.userProfilesList || [];
      for (const p of profiles) { await SUPA.pushProfile(p); }

      // Push slot history
      const slots = data.slotHistory || [];
      if (slots.length > 0) {
        const slotBatch = slots.map(s => ({
          username: s.username, location: s.location, date: s.date,
          action: s.action || "detected", inRange: !!s.inRange,
          detectedAt: s.foundAt,
        }));
        await SUPA.pushSlotBatch(slotBatch);
      }

      // Push events
      const events = data.eventLog || [];
      if (events.length > 0) {
        for (const e of events) {
          SUPA.bufferEvent({ type: e.type, message: e.message, username: e.username, timestamp: e.timestamp });
        }
        await SUPA.flushEvents();
      }

      statusEl.textContent = `Pushed! ${profiles.length} profiles, ${slots.length} slots, ${events.length} events`;
      statusEl.style.color = "#81c784";
    } catch (e) {
      statusEl.textContent = "Push failed: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  // Rename device
  document.getElementById("cloud-rename-btn").addEventListener("click", async () => {
    const name = document.getElementById("cloud-device-name").value.trim();
    if (!name || !SUPA || !SUPA.isReady()) return;
    await SUPA.renameDevice(name);
    loadCloudDevices();
  });

  // Export config — copies base64 config string to clipboard
  document.getElementById("cloud-export-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("cloud-status");
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
        statusEl.style.color = "#ef5350";
        return;
      }
      const encoded = btoa(JSON.stringify(config));
      await navigator.clipboard.writeText(encoded);
      statusEl.textContent = "📋 Config copied to clipboard!";
      statusEl.style.color = "#16a085";
      setTimeout(() => { statusEl.textContent = "Connected"; statusEl.style.color = "#81c784"; }, 3000);
    } catch (e) {
      statusEl.textContent = "Export failed: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  // Import config — decode base64, save, connect, pull profiles
  document.getElementById("cloud-import-btn").addEventListener("click", async () => {
    const input = document.getElementById("cloud-import-input");
    const statusEl = document.getElementById("cloud-import-status");
    const raw = (input.value || "").trim();
    if (!raw) { statusEl.textContent = "Paste config string first!"; statusEl.style.color = "#ef5350"; return; }

    let config;
    try {
      config = JSON.parse(atob(raw));
    } catch {
      statusEl.textContent = "Invalid config string!";
      statusEl.style.color = "#ef5350";
      return;
    }

    if (!config.supabaseOperatorKey || !config.supabaseMasterPassword) {
      statusEl.textContent = "Config missing Supabase keys!";
      statusEl.style.color = "#ef5350";
      return;
    }

    const deviceName = prompt("Name this Chrome profile (e.g. Ravi-Laptop, Arun-Main):");
    if (!deviceName || !deviceName.trim()) {
      statusEl.textContent = "Device name required!";
      statusEl.style.color = "#ef5350";
      return;
    }

    statusEl.textContent = "Importing...";
    statusEl.style.color = "#f39c12";

    try {
      await new Promise(r => chrome.storage.local.set({
        telegramBotToken: config.telegramBotToken || "",
        telegramChatId: config.telegramChatId || "",
        telegramNotify: true,
        __supabase_operator_key: config.supabaseOperatorKey,
        __supabase_master_pw: config.supabaseMasterPassword,
      }, r));

      if (SUPA) {
        await SUPA.init(config.supabaseOperatorKey, config.supabaseMasterPassword, deviceName.trim());
        const cloudProfiles = await SUPA.pullProfiles();
        let localProfiles = [];
        for (const cp of cloudProfiles) {
          const profile = {
            username: cp.username, password: cp.password,
            securityQuestions: {},
            autoLogin: cp.autoLogin, autoDashboard: cp.autoDashboard,
            autoSelect: cp.autoSelect, autoSubmit: cp.autoSubmit,
            captchaMode: cp.captchaMode,
            startDate: cp.startDate || "", endDate: cp.endDate || "",
            locations: cp.locations || [], visaType: cp.visaType || "",
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
        statusEl.style.color = "#81c784";

        // Update UI
        updateCloudUI();
        startCloudPolling();
        refresh();
      } else {
        statusEl.textContent = "SupabaseSync not loaded!";
        statusEl.style.color = "#ef5350";
      }
    } catch (e) {
      statusEl.textContent = "Import failed: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  // Auto-connect on dashboard load if already configured
  if (SUPA) {
    SUPA.initFromStorage().then(connected => {
      if (connected) {
        updateCloudUI();
        startCloudPolling();
      }
    }).catch(() => {});
  }

  refresh();
  setInterval(refresh, REFRESH_INTERVAL);
})();
