(function () {
  "use strict";

  const REFRESH_INTERVAL = 2000;
  const SUPABASE_POLL_INTERVAL = 30000;
  const STALE_DEVICE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Supabase-sourced profiles + device map (shared across all Chromes)
  let cloudProfiles = [];
  let cloudDevices = {};  // deviceId → { device_name, last_seen }

  // Team mode (#52) — off by default, so the dashboard looks exactly as it
  // always has until the owner switches it on in Cloud Sync.
  let teamMode = false;
  let staffMode = false;   // #53 — connected with a staff key, not the owner key
  let staffList = [];                 // [{ id, name, email, staffKey, active }]
  let staffById = {};                 // id → staff
  const bulkSelected = new Set();     // usernames ticked for bulk assign

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

  // ─── CARD RECONCILIATION (issue #59) ───────────────────────────────
  // The grid used to be rebuilt wholesale every 2s, which threw away hover,
  // focus, text selection and any running transition on all 40-odd cards.
  // Now each card's markup is hashed and only cards whose content actually
  // changed touch the DOM. Idle clients stop being redrawn entirely.
  //
  // Kill switch: RECONCILE_CARDS = false restores the old innerHTML rebuild.

  const RECONCILE_CARDS = !window.__SH_NO_RECONCILE;

  const CARD_ICON = {
    warn: '<svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 4.5L21 20H3z"/><path d="M12 10v4M12 17v.1"/></svg>',
    block: '<svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
    device: '<svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M8 20h8"/></svg>',
  };

  // Event type → severity, so the log reads as one ramp instead of ten hues.
  const LOG_SEVERITY = {
    slot_found: "found",
    booking: "ok", confirmed: "ok", captcha: "ok", security: "ok",
    error: "err",
    login: "live", dashboard: "live", cycling: "live",
    queue: "info", session: "info",
  };

  // djb2 — fast, ample for change detection. Not a security hash.
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // True while the user is mid-interaction inside this card. Replacing it
  // now would close an open dropdown or drop a half-typed value.
  function cardIsBusy(el) {
    const a = document.activeElement;
    if (!a || a === document.body || !el.contains(a)) return false;
    return a.tagName === "SELECT" || a.tagName === "INPUT" || a.tagName === "TEXTAREA";
  }

  function reconcileCards(container, items) {
    if (!RECONCILE_CARDS) {
      container.innerHTML = items.map((i) => i.html).join("");
      return;
    }

    // Anything without a data-username (the "no users match" placeholder,
    // or leftovers from the fallback path) is not ours to keep.
    const existing = new Map();
    for (const el of Array.from(container.children)) {
      const u = el.dataset ? el.dataset.username : null;
      if (u && !existing.has(u)) existing.set(u, el);
      else el.remove();
    }

    let prev = null;
    for (const item of items) {
      const hash = hashString(item.html);
      let el = existing.get(item.user);

      if (el) existing.delete(item.user);

      if (!el || (el.dataset.hash !== hash && !cardIsBusy(el))) {
        const holder = document.createElement("div");
        holder.innerHTML = item.html.trim();
        const fresh = holder.firstElementChild;
        if (fresh) {
          fresh.dataset.hash = hash;
          if (el) el.replaceWith(fresh);
          el = fresh;
        }
      }
      if (!el) continue;

      // Put it in the right slot only when it is not already there, so a
      // stable list performs zero DOM moves.
      const expected = prev ? prev.nextElementSibling : container.firstElementChild;
      if (expected !== el) {
        if (prev) prev.after(el);
        else container.prepend(el);
      }
      prev = el;
    }

    existing.forEach((el) => el.remove());
  }

  function renderUserCards(profiles, statuses, slotHistory) {
    const container = document.getElementById("user-cards");

    const filterStatus = document.getElementById("filter-status").value;
    const filterVisa = document.getElementById("filter-visa")?.value || "all";
    const filterMonth = document.getElementById("filter-month")?.value || "all";
    const searchTerm = (document.getElementById("profile-search")?.value || "").trim().toLowerCase();

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
      // Search by name / username
      if (searchTerm) {
        // #59 Locations included so a consulate name finds every client
        // hunting there — this is what the consulate rail clicks through to.
        const hay = (
          deriveProfileName(p.username) + " " +
          p.username + " " +
          (p.name || "") + " " +
          (p.locations || []).join(" ")
        ).toLowerCase();
        if (!hay.includes(searchTerm)) return false;
      }
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
      cloudStatusMap[cp.username] = { status: cp.status, activeDeviceId: cp.activeDeviceId, isActive: cp.isActive, rateLimitedAt: cp.rateLimitedAt, assignedStaffId: cp.assignedStaffId };
    });

    const myDeviceId = SUPA ? SUPA.getDeviceId() : null;

    // #47 Pin active clients to the top: active on THIS device first, then active on
    // other dashboards, then idle (A-Z). Display order only — doesn't change behavior.
    const ACTIVE_STATES_SORT = ["cycling", "logging_in", "security_questions", "on_dashboard", "slot_found"];
    const activeRank = (profile) => {
      const st = statuses[profile.username] || {};
      const cl = cloudStatusMap[profile.username] || {};
      const localSt = st.status || "";
      const cloudSt = cl.status || "";
      const userStatus = ACTIVE_STATES_SORT.includes(localSt) ? localSt : (ACTIVE_STATES_SORT.includes(cloudSt) ? cloudSt : (localSt || cloudSt || "idle"));
      const isActive = ["cycling", "logging_in", "security_questions", "on_dashboard"].includes(userStatus);
      const cloudIsRunning = cl.isActive || ACTIVE_STATES_SORT.includes(cl.status);
      const activeOnOtherDevice = cloudIsRunning && cl.activeDeviceId && cl.activeDeviceId !== myDeviceId;
      if (activeOnOtherDevice) return 1;       // active on another dashboard
      if (isActive || cloudIsRunning) return 0; // active on THIS dashboard
      return 2;                                 // idle / other
    };
    filtered.sort((a, b) => {
      const ra = activeRank(a), rb = activeRank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 2) {
        const na = (a.name || deriveProfileName(a.username) || a.username).toLowerCase();
        const nb = (b.name || deriveProfileName(b.username) || b.username).toLowerCase();
        return na.localeCompare(nb);
      }
      return 0; // active groups: keep stable order
    });

    const cards = filtered.map((profile) => {
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

      // Check rate limit — purely time-based (24h from the timestamp). A stale
      // "rate_limited" status without a fresh timestamp must NOT block forever.
      const rateLimitedAt = cloud.rateLimitedAt;
      const rlMs = rateLimitedAt ? new Date(rateLimitedAt).getTime() : 0;
      const isRateLimited = rlMs > 0 && (Date.now() - rlMs < 24 * 60 * 60 * 1000);
      const rateLimitHoursLeft = isRateLimited ? Math.max(0, Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - rlMs)) / 3600000)) : 0;

      // Auto-clear once expired, or a stuck rate_limited status with no fresh timestamp
      if ((userStatus === "rate_limited" || rateLimitedAt) && !isRateLimited && SUPA && SUPA.isReady()) {
        SUPA.clearRateLimitedAt(profile.username);
      }

      let cardClass = "user-card";
      if (isActive) cardClass += " active";
      else if (userStatus === "confirmed") cardClass += " confirmed";
      else if (userStatus === "slot_found") cardClass += " slot-found";
      else if (isRateLimited || ["session_expired", "error"].includes(userStatus)) cardClass += " error";

      const locs = (profile.locations || []).map((l) => `<span class="loc-tag">${esc(l)}</span>`).join("");
      const safeUser = esc(profile.username);

      const html = `
        <div class="${cardClass}" data-username="${safeUser}">
          <div class="card-header">
            <div class="card-ident">
              ${teamMode ? `<input type="checkbox" class="bulk-tick" data-user="${safeUser}" ${bulkSelected.has(profile.username) ? "checked" : ""} title="Select for bulk assign">` : ""}
              <div class="card-ident-text">
                <div class="card-name">${name}</div>
                <div class="card-username">${safeUser}</div>
              </div>
            </div>
            <span class="status-badge status-${userStatus}">${statusLabel(userStatus)}</span>
          </div>
          ${teamMode ? `<div class="card-assign">
            <span>Assigned to</span>
            <select class="assign-select" data-user="${safeUser}">
              ${staffOptionsHtml(cloud.assignedStaffId)}
            </select>
          </div>` : ""}
          ${activeOnOtherDevice ? `<div class="card-note note-warn">${CARD_ICON.warn}<span>Active on <b>${esc(activeDeviceName || "another device")}</b>${deviceLastSeen ? ` (${deviceLastSeen})` : ""}${isStaleDevice ? ` <span class="note-stale">— stale</span>` : ""}</span></div>` : ""}
          ${isActive && activeDeviceName && !activeOnOtherDevice ? `<div class="card-note note-live">${CARD_ICON.device}<span>Running on <b>${esc(activeDeviceName)}</b>${deviceLastSeen ? ` (${deviceLastSeen})` : ""}</span></div>` : ""}
          ${isRateLimited ? `<div class="card-note note-block">${CARD_ICON.block}<span><b>Rate limited</b> — blocked ~${rateLimitHoursLeft}h. Do not log in from any profile.</span></div>` : ""}
          <div class="card-details">
            <div class="card-detail">
              <span class="detail-label">DATES</span>
              <span class="detail-value">${formatDate(profile.startDate)} — ${formatDate(profile.endDate)}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">VISA</span>
              <span class="detail-value">${esc(profile.visaType) || "—"}</span>
            </div>
            <div class="card-detail">
              <span class="detail-label">APPL</span>
              <span class="detail-value">${profile.applicantCount || 1}</span>
            </div>
            ${staffMode ? "" : `<div class="card-detail">
              <span class="detail-label">PRICE</span>
              <span class="detail-value">${profile.agreedPrice ? "₹" + Number(profile.agreedPrice).toLocaleString() + (profile.applicantCount > 1 ? " (" + (profile.pricePerPerson || profile.agreedPrice) + "/pp)" : "") : "—"}</span>
            </div>`}
            <div class="card-detail">
              <span class="detail-label">CAPTCHA</span>
              <span class="detail-value">${esc(profile.captchaMode) || "manual"}</span>
            </div>
          </div>
          ${locs ? `<div class="card-locations">${locs}</div>` : ""}

          ${(() => {
            const st = slotStats[profile.username];
            if (!st) return `<div class="card-slots-summary is-empty">No slot history yet</div>`;
            const lastInfo = st.lastFoundAt
              ? `Last: <b>${esc(st.lastLocation)}</b> ${esc(st.lastDate)} · ${timeAgo(st.lastFoundAt)}`
              : "";
            return `
              <div class="card-slots-summary">
                <span class="ss"><b>${st.total}</b> seen</span>
                <span class="ss ss-in"><b>${st.inRange}</b> in range</span>
                <span class="ss ss-out"><b>${st.outRange}</b> out</span>
                ${st.confirmed > 0 ? `<span class="ss ss-ok"><b>${st.confirmed}</b> confirmed</span>` : ""}
                ${st.submitted > 0 && st.confirmed === 0 ? `<span class="ss ss-pending"><b>${st.submitted}</b> submitted</span>` : ""}
                ${lastInfo ? `<div class="ss-last">${lastInfo}</div>` : ""}
              </div>`;
          })()}

          ${(() => {
            const r = status.roundCount || 0;
            const e = status.errorCount || 0;
            const inR = status.slotsInRangeFound || 0;
            const outR = status.slotsOutOfRangeFound || 0;
            const last429 = status.last429At ? `<span class="ct ct-warn">429 ${timeAgo(status.last429At)}</span>` : "";
            const last401 = status.last401At ? `<span class="ct ct-err">401 ${timeAgo(status.last401At)}</span>` : "";
            // Hide only if user never started cycling AND no errors AND no slots
            const hasAnyData = r > 0 || e > 0 || inR > 0 || outR > 0 || status.cycleStartedAt || isActive;
            if (!hasAnyData) return "";
            return `
              <div class="card-counters">
                <span class="ct">Round <b>${r}</b></span>
                <span class="ct${e > 0 ? " ct-err" : ""}"><b>${e}</b> errors</span>
                <span class="ct ct-ok"><b>${inR}</b> in</span>
                <span class="ct"><b>${outR}</b> out</span>
                ${last429}${last401}
              </div>`;
          })()}

          <div class="card-actions">
            ${activeOnOtherDevice
              ? `<span class="card-elsewhere">Running on ${esc(activeDeviceName || "other device")}</span>
                 <button class="btn btn-small btn-force-start" data-user="${safeUser}" data-device="${esc(activeDeviceName || "other device")}" title="Hold Shift+Click to force start">Force start</button>`
              : isActive
                ? `<button class="btn btn-small btn-red btn-stop" data-user="${safeUser}">Stop</button>
                   <button class="btn btn-small btn-orange btn-logout" data-user="${safeUser}">Logout</button>`
                : isRateLimited
                  ? `<button class="btn btn-small btn-red btn-force-rate-limit" data-user="${safeUser}" title="Shift+Click to force login despite rate limit">Blocked ~${rateLimitHoursLeft}h</button>`
                  : `<button class="btn btn-small btn-green btn-start" data-user="${safeUser}">Start now</button>`}
            <span class="card-actions-rest">
              <button class="btn btn-small btn-edit" data-user="${safeUser}">Edit</button>
              <button class="btn btn-small btn-history" data-user="${safeUser}">History</button>
            </span>
          </div>

          <div class="card-footer">
            ${status.updatedAt ? "Updated " + timeAgo(status.updatedAt) : "No activity yet"}
            ${status.cycleStartedAt ? " · Started " + timeAgo(status.cycleStartedAt) : ""}
            ${status.foundAt ? " · Slot found " + timeAgo(status.foundAt) : ""}
            ${status.confirmedAt ? " · Confirmed " + timeAgo(status.confirmedAt) : ""}
          </div>
        </div>
      `;
      return { user: profile.username, html };
    });

    reconcileCards(container, cards);
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
      if (container.dataset.hash !== "empty") {
        container.dataset.hash = "empty";
        container.innerHTML = '<div class="log-empty">No events to display</div>';
      }
      return;
    }

    const esc2 = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const html = displayEvents.map((e) => `
      <div class="log-entry sev-${LOG_SEVERITY[e.type] || "info"}">
        <span class="log-time">${formatTime(e.timestamp)}</span>
        <span class="log-spine"><i></i></span>
        <span class="log-type log-type-${esc2(e.type)}">${esc2(e.type)}</span>
        <span class="log-user">${esc2(deriveProfileName(e.username))}</span>
        <span class="log-message">${esc2(e.message)}</span>
      </div>`).join("");

    // Same reason as the cards: this list is rebuilt on the same 2s tick and
    // wholesale replacement was killing hover and the scroll position. A
    // single hash comparison skips the write when nothing changed.
    const hash = hashString(html);
    if (container.dataset.hash === hash) return;
    container.dataset.hash = hash;

    const keepScroll = container.scrollTop;
    container.innerHTML = html;
    container.scrollTop = keepScroll;
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

  let statsSignature = "";

  function renderStats(dailyStats, storageStats, slotHistory, profiles, statuses) {
    const container = document.getElementById("stats-pane");
    if (!container) return;

    // This pane sits behind a tab and is rebuilt on the same 2s loop as
    // everything else. Skip the work entirely while it is hidden.
    if (container.style.display === "none") return;

    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = istDayKeyFromDate(d);
      const s = dailyStats[key] || null;
      days.push({ key, label: i === 0 ? "Today" : i === 1 ? "Yesterday" : key, stats: s });
    }

    const last7 = days.slice(0, 7).map((d) => d.stats).filter(Boolean);
    const weekTotal = { slotsFound: 0, slotsInRange: 0, booked: 0, missed: 0, errors: 0 };
    last7.forEach((s) => {
      weekTotal.slotsFound += s.slotsFound || 0;
      weekTotal.slotsInRange += s.slotsInRange || 0;
      weekTotal.booked += s.booked || 0;
      weekTotal.missed += s.missed || 0;
      weekTotal.errors += s.errors || 0;
    });

    const insights = buildSlotInsights(slotHistory);
    const health = buildHealth(profiles || [], statuses || {});
    const pipeline = staffMode ? null : buildPipeline(profiles || [], statuses || {});

    // ── 02 release heatmap: consulate x hour of day, IST ──────────────
    const heatCells = CONSULATES.map((c) => {
      const row = insights.grid[c];
      const cells = row.map((v, h) => {
        const t = insights.gridMax ? v / insights.gridMax : 0;
        const bg = v === 0 ? "var(--surface-3)" : `rgba(229,169,78,${(0.16 + t * 0.84).toFixed(2)})`;
        return `<div class="heat-cell" style="background:${bg}" title="${esc(c)} · ${String(h).padStart(2, "0")}:00 IST — ${v} slot${v === 1 ? "" : "s"} seen"></div>`;
      }).join("");
      return `<div class="heat-row-label">${esc(c)}</div>${cells}`;
    }).join("");

    const hourLabels = Array.from({ length: 24 }, (_, h) =>
      `<div class="heat-hour">${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>`).join("");

    const legend = [0, 0.25, 0.5, 0.75, 1].map((t) =>
      `<i style="background:${t === 0 ? "var(--surface-3)" : `rgba(229,169,78,${(0.16 + t * 0.84).toFixed(2)})`}"></i>`).join("");

    const rangePicker = HEAT_RANGES.map((r) =>
      `<button type="button" class="heat-range${r.days === insights.rangeDays ? " on" : ""}" data-days="${r.days}">${r.label}</button>`).join("");

    // Say exactly what period is on screen. Without this the grid looks like a
    // stable long-run pattern when it may only be the last few days.
    const spanNote = insights.totalStored === 0 ? "" :
      insights.rangeDays > 0
        ? `last ${insights.rangeDays} days · ${insights.totalUsed} of ${insights.totalStored} stored slots`
        : `${shortDate(insights.oldest)} → ${shortDate(insights.newest)} · all ${insights.totalStored} stored slots`;

    const capNote = insights.atCap
      ? `<div class="heat-cap">Slot history is at its storage cap, so older records have been pruned. "All" means the surviving window above, not the whole history.</div>`
      : "";

    const heatPanel = insights.totalStored === 0
      ? `<div class="ins-empty">No slot history recorded yet. Once clients start finding slots this fills in — it needs nothing but time.</div>`
      : insights.totalUsed === 0
        ? `<div class="ins-empty">No slots recorded in the last ${insights.rangeDays} days. Widen the range above.</div>`
        : `
        <div class="heat-grid">
          <div></div>${hourLabels}
          ${heatCells}
        </div>
        <div class="heat-legend"><span>fewer</span><span class="heat-swatch">${legend}</span><span>more slots seen</span></div>
        ${insights.bestSum > 0 ? `<div class="heat-peak">Densest 3-hour window across all consulates: <b>${String(insights.bestStart).padStart(2, "0")}:00–${String((insights.bestStart + 3) % 24).padStart(2, "0")}:00 IST</b> — that is when it is worth having clients running, and when a page-view is worth spending.</div>` : ""}
        ${capNote}`;

    // ── 04 client health: error rate per client, worst first ──────────
    const healthPanel = health.length === 0
      ? `<div class="ins-empty">No client has enough completed rounds yet to judge.</div>`
      : health.slice(0, 8).map((h) => {
        const C = 2 * Math.PI * 19;
        const off = (C * h.rate).toFixed(1);
        const tone = h.rate > 0.15 ? "var(--danger)" : h.rate > 0.07 ? "var(--accent)" : "var(--ok)";
        return `
          <div class="health-row">
            <svg class="health-ring" viewBox="0 0 46 46" aria-hidden="true">
              <circle class="hr-track" cx="23" cy="23" r="19" fill="none" stroke-width="4"/>
              <circle cx="23" cy="23" r="19" fill="none" stroke="${tone}" stroke-width="4"
                      stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off}"/>
            </svg>
            <div class="health-text">
              <div class="health-who">${esc(h.name)}</div>
              <div class="health-pct${h.rate > 0.15 ? " bad" : ""}">${(h.rate * 100).toFixed(1)}% errors · ${h.errs}/${h.rounds} rounds</div>
            </div>
          </div>`;
      }).join("");

    // ── 03 pipeline value + staff board (owner only) ──────────────────
    let pipelinePanel = "";
    if (pipeline) {
      const totalVal = pipeline.bookedValue + pipeline.flightValue + pipeline.riskValue || 1;
      const staffRows = Object.entries(pipeline.byStaff)
        .sort((a, b) => b[1].value - a[1].value)
        .slice(0, 6)
        .map(([sid, v]) => {
          const maxV = Math.max(...Object.values(pipeline.byStaff).map((x) => x.value), 1);
          const who = sid === "__me" ? "Unassigned / me" : (staffById[sid] ? staffById[sid].name : "Unknown");
          return `
            <div class="staff-row">
              <span class="staff-who">${esc(who)}</span>
              <span class="staff-bar"><i style="width:${Math.round((v.value / maxV) * 100)}%"></i></span>
              <span class="staff-val">${v.count} · ${rupees(v.value)}</span>
            </div>`;
        }).join("");

      pipelinePanel = `
        <div class="ins-panel">
          <div class="ins-head">PIPELINE · owner only</div>
          <div class="pipe-grid">
            <div class="pipe-money">
              <div class="pipe-row booked">
                <div class="k">CONFIRMED THIS MONTH</div>
                <div class="v">${rupees(pipeline.bookedValue)}</div>
                <div class="n">${pipeline.bookedCount} client${pipeline.bookedCount === 1 ? "" : "s"} · ${pipeline.bookedApplicants} applicant${pipeline.bookedApplicants === 1 ? "" : "s"}</div>
              </div>
              <div class="pipe-row flight">
                <div class="k">IN FLIGHT</div>
                <div class="v">${rupees(pipeline.flightValue)}</div>
                <div class="n">${pipeline.flightCount} still hunting</div>
                <div class="pipe-bar">
                  <i style="width:${(pipeline.bookedValue / totalVal * 100).toFixed(1)}%;background:var(--ok)"></i>
                  <i style="width:${(pipeline.flightValue / totalVal * 100).toFixed(1)}%;background:var(--live)"></i>
                  <i style="width:${(pipeline.riskValue / totalVal * 100).toFixed(1)}%;background:var(--danger)"></i>
                </div>
              </div>
              <div class="pipe-row risk">
                <div class="k">BLOCKED / AT RISK</div>
                <div class="v">${rupees(pipeline.riskValue)}</div>
                <div class="n">${pipeline.riskCount} rate-limited or errored</div>
              </div>
            </div>
            <div>
              <div class="ins-sub">CONFIRMED BY STAFF</div>
              <div class="staff-board">${staffRows || '<div class="ins-empty">Nothing confirmed yet.</div>'}</div>
            </div>
          </div>
        </div>`;
    }

    const maxDay = Math.max(...days.map((x) => x.stats?.slotsFound || 0), 1);
    const dayBars = days.slice(0, 14).reverse().map((d) => {
      const total = d.stats?.slotsFound || 0;
      const inR = d.stats?.slotsInRange || 0;
      const h = (total / maxDay) * 74;
      const inH = (inR / maxDay) * 74;
      return `
        <div class="day-col" title="${esc(d.label)} — ${total} seen, ${inR} in range">
          <div class="day-stack">
            <div class="day-out" style="height:${Math.max(h - inH, 0)}px"></div>
            <div class="day-in" style="height:${inH}px"></div>
          </div>
          <div class="day-lab">${esc(d.label.substring(5) || d.label.substring(0, 3))}</div>
          <div class="day-num">${total}</div>
        </div>`;
    }).join("");

    const storageBar = storageStats ? `
      <div class="ins-panel">
        <div class="ins-head">STORAGE</div>
        <div class="store-line">${storageStats.mb} MB of 10 MB</div>
        <div class="store-bar"><i style="width:${Math.min((storageStats.mb / 10) * 100, 100)}%;background:${storageStats.mb > 8 ? "var(--danger)" : storageStats.mb > 6 ? "var(--accent)" : "var(--ok)"}"></i></div>
        ${storageStats.lastPrune ? `<div class="store-note">Last prune ${timeAgo(storageStats.lastPrune.at)} — ${esc(storageStats.lastPrune.pruned.join(", "))}</div>` : ""}
      </div>` : "";

    const html = `
      <div class="ins-wrap">
        <div class="ins-totals">
          <div class="ins-tile"><div class="n">${weekTotal.slotsFound}</div><div class="l">SEEN 7D</div></div>
          <div class="ins-tile ok"><div class="n">${weekTotal.slotsInRange}</div><div class="l">IN RANGE</div></div>
          <div class="ins-tile ok"><div class="n">${weekTotal.booked}</div><div class="l">BOOKED</div></div>
          <div class="ins-tile warn"><div class="n">${weekTotal.missed}</div><div class="l">MISSED</div></div>
          <div class="ins-tile bad"><div class="n">${weekTotal.errors}</div><div class="l">ERRORS</div></div>
        </div>

        <div class="ins-panel">
          <div class="ins-head heat-head">
            <span>RELEASE HEATMAP · consulate × hour, IST</span>
            <span class="heat-range-picker">${rangePicker}</span>
          </div>
          ${spanNote ? `<div class="heat-span">${esc(spanNote)}</div>` : ""}
          ${heatPanel}
        </div>

        ${pipelinePanel}

        <div class="ins-panel">
          <div class="ins-head">CLIENT HEALTH · worst error rate first</div>
          <div class="health-list">${healthPanel}</div>
        </div>

        <div class="ins-panel">
          <div class="ins-head">LAST 14 DAYS</div>
          <div class="day-bars">${dayBars}</div>
          <div class="day-key"><span class="sw-in"></span>in range<span class="sw-out"></span>out of range</div>
        </div>

        ${storageBar}
      </div>`;

    const sig = hashString(html);
    if (statsSignature === sig) return;
    statsSignature = sig;
    container.innerHTML = html;
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

    // #59 Must emit the same five grid children as the activity log — the
    // shared .log-entry grid would otherwise shunt every column across.
    // in-range is carried by the spine dot instead of an emoji.
    container.innerHTML = display.map((e) => `
      <div class="log-entry sev-${e.inRange ? "found" : "info"}">
        <span class="log-time">${formatTime(e.foundAt)}</span>
        <span class="log-spine"><i></i></span>
        <span class="log-type log-slot-${esc(e.action)}">${esc(e.action)}</span>
        <span class="log-user">${esc(deriveProfileName(e.username))}</span>
        <span class="log-message">${esc(e.location)} → <b>${esc(e.date)}</b>${e.inRange ? '<span class="in-range">in range</span>' : ""}</span>
      </div>`).join("");
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

  // #59 Clearing the log is destructive and had no confirmation at all — one
  // stray click wiped every event. With the shell UI on it becomes a press-
  // and-hold. With the shell off it keeps the original one-click behaviour,
  // so the kill switch really does restore what shipped before.
  function clearEventLog() {
    chrome.storage.local.set({ eventLog: [] }, refresh);
  }

  {
    const clearLogBtn = document.getElementById("clear-log-btn");
    if (window.SHUI && !window.__SH_UI_KIT_OFF) {
      clearLogBtn.textContent = "Hold to clear";
      clearLogBtn.title = "Press and hold to clear the activity log";
      window.SHUI.bindHold(clearLogBtn, clearEventLog);
    } else {
      clearLogBtn.addEventListener("click", clearEventLog);
    }
  }

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
      await SheetsSync.fullSync(profiles, await buildAssigneeMap());
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
      // #59 State lives on a class so the header stylesheet stays in charge;
      // an inline background here would override every token below it.
      btn.classList.toggle("is-on", connected);
      if (connected) {
        btn.textContent = "Sync sheets";
        // #57b Keep the URL box available for the owner even when connected, so a
        // different sheet can be linked by pasting its URL. Hiding it here was
        // why a pasted URL never reached connect(). Staff never see it.
        urlInput.style.display = staffMode ? "none" : "inline-block";
        urlInput.placeholder = "Paste a URL here to switch sheets";
        const sheetId = await SheetsSync.getSpreadsheetId();
        if (sheetId) {
          link.href = SheetsSync.getSheetUrl(sheetId);
          link.style.display = "inline";
        }
      } else {
        btn.textContent = "Sheets";
        link.style.display = "none";
        urlInput.style.display = staffMode ? "none" : "inline-block";
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
      // #57b Guard against silently making a DUPLICATE. If nothing is linked and
      // no URL was pasted, ask first — the usual cause is a lost link (e.g.
      // switching extensions), and the fix is to paste the existing sheet URL.
      if (!sheetUrl) {
        const existing = await SheetsSync.getSpreadsheetId();
        if (!existing) {
          if (!confirm("No Google Sheet is linked yet.\n\nOK = create a NEW sheet.\nCancel = paste your existing sheet's URL in the box to reuse it.")) {
            btn.textContent = origText; btn.disabled = false; return;
          }
        }
      }
      await SheetsSync.connect(sheetUrl);
      const profiles = await freshProfiles();
      btn.textContent = "Syncing...";
      const sheetId = await SheetsSync.fullSync(profiles, await buildAssigneeMap());
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
    } else if (btn.classList.contains("btn-force-rate-limit")) {
      if (!e.shiftKey) {
        alert(`"${username}" is rate-limited (~24h block).\n\nHold Shift + Click to force login anyway.`);
        return;
      }
      if (!confirm(`Force login "${username}" despite rate limit?\n\nThis user may still be blocked by the site.`)) return;
      // Clear rate limit in Supabase
      if (SUPA && SUPA.isReady()) {
        SUPA.clearRateLimitedAt(username);
      }
      startUser(username);
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

  // ─── INSIGHTS (issue #59) ──────────────────────────────────────────
  // Consulate rail, release heatmap, pipeline value, client health.
  // All derived from data the extension already stores — slotHistory,
  // userStatuses and the profiles themselves. No new collection, no new
  // permission, no network call.

  const CONSULATES = ["Mumbai", "New Delhi", "Chennai", "Kolkata", "Hyderabad"];
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  // slotHistory stores whatever the site calls the place — "CHENNAI VAC",
  // "NEW DELHI VAC", "MUMBAI OFC" and so on (auto-booking.js writes
  // `location: loc.name` verbatim). Match on the city token so every
  // spelling folds onto one consulate.
  const CONSULATE_TOKENS = [
    ["Mumbai", "MUMBAI"],
    ["New Delhi", "DELHI"],
    ["Chennai", "CHENNAI"],
    ["Kolkata", "KOLKATA"],
    ["Hyderabad", "HYDERABAD"],
  ];

  function normaliseConsulate(raw) {
    if (!raw) return null;
    const up = String(raw).toUpperCase();
    for (const [canonical, token] of CONSULATE_TOKENS) {
      if (up.indexOf(token) !== -1) return canonical;
    }
    return null;
  }

  // Slot records are written with `foundAt`; rows pulled back from Supabase
  // may carry `detectedAt` or `timestamp` instead.
  function slotTime(s) {
    const raw = s.foundAt || s.timestamp || s.detectedAt || null;
    if (!raw) return 0;
    const t = new Date(raw).getTime();
    return isNaN(t) ? 0 : t;
  }

  // Hour-of-day in IST, which is the only timezone these consulates release in.
  function istHour(ts) {
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (!t || isNaN(t)) return null;
    return new Date(t + IST_OFFSET_MS).getUTCHours();
  }

  function istDayKey(ts) {
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (!t || isNaN(t)) return null;
    return new Date(t + IST_OFFSET_MS).toISOString().substring(0, 10);
  }

  // How far back the heatmap looks. 0 = every record still in storage.
  // slotHistory is capped (1500 by the writer, pruned to 1000 by the service
  // worker at 8 MB), so "all" is not "forever" — it is however far back the
  // surviving records reach. renderStats reports the real span either way.
  const HEAT_RANGES = [
    { days: 7, label: "7d" },
    { days: 30, label: "30d" },
    { days: 0, label: "All" },
  ];
  let heatRangeDays = 30;

  // One pass over slotHistory feeds the rail and the heatmap.
  // sinceMs limits the heatmap grid only — the rail always reports today.
  function buildSlotInsights(slotHistory, rangeDays) {
    const days = rangeDays === undefined ? heatRangeDays : rangeDays;
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
    const today = istDayKey(Date.now());
    const perCity = {};
    const grid = {};            // city → 24 hour buckets
    let gridMax = 0;
    let totalUsed = 0;
    let oldest = 0, newest = 0, totalStored = 0;

    CONSULATES.forEach((c) => {
      perCity[c] = { todayInRange: 0, todayTotal: 0, lastAt: 0, lastDate: null, allTime: 0 };
      grid[c] = new Array(24).fill(0);
    });

    (slotHistory || []).forEach((s) => {
      const city = normaliseConsulate(s.location);
      if (!city) return;                            // a place we don't chart
      const t = slotTime(s);
      if (!t) return;

      totalStored++;
      if (!oldest || t < oldest) oldest = t;
      if (t > newest) newest = t;

      // The rail is always "today", regardless of the heatmap range.
      perCity[city].allTime++;
      if (t > perCity[city].lastAt) {
        perCity[city].lastAt = t;
        perCity[city].lastDate = s.date || null;
      }
      if (istDayKey(t) === today) {
        perCity[city].todayTotal++;
        if (s.inRange) perCity[city].todayInRange++;
      }

      if (cutoff && t < cutoff) return;             // outside the heatmap window
      totalUsed++;

      const h = istHour(t);
      if (h !== null) {
        grid[city][h]++;
        if (grid[city][h] > gridMax) gridMax = grid[city][h];
      }
    });

    // Densest 3-hour window across all consulates — the actionable number.
    const colTotals = new Array(24).fill(0);
    CONSULATES.forEach((c) => grid[c].forEach((v, h) => { colTotals[h] += v; }));
    let bestStart = 0, bestSum = -1;
    for (let h = 0; h < 24; h++) {
      const sum = colTotals[h] + colTotals[(h + 1) % 24] + colTotals[(h + 2) % 24];
      if (sum > bestSum) { bestSum = sum; bestStart = h; }
    }

    return {
      perCity, grid, gridMax, colTotals, bestStart, bestSum, totalUsed, today,
      rangeDays: days, oldest, newest, totalStored,
      // The writer caps at 1500 and the service worker prunes to 1000, so a
      // full-looking history is really a moving window. Say so when at the cap.
      atCap: totalStored >= 995,
    };
  }

  function shortDate(ms) {
    if (!ms) return "—";
    return new Date(ms + IST_OFFSET_MS).toISOString().substring(0, 10);
  }

  function shortAgo(ms) {
    if (!ms) return "never";
    const d = Date.now() - ms;
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + "s ago";
    if (d < 3600000) return Math.round(d / 60000) + "m ago";
    if (d < 86400000) return Math.round(d / 3600000) + "h ago";
    return Math.round(d / 86400000) + "d ago";
  }

  let railSignature = "";

  // 01 — Consulate rail. Which city is actually releasing, and how stale.
  function renderConsulateRail(insights) {
    const wrap = document.getElementById("consulate-rail-wrap");
    const rail = document.getElementById("consulate-rail");
    const hint = document.getElementById("rail-hint");
    if (!wrap || !rail) return;

    if (!insights.totalUsed) {          // nothing recorded yet — stay out of the way
      wrap.hidden = true;
      railSignature = "";
      return;
    }
    wrap.hidden = false;

    const rows = CONSULATES.map((c) => {
      const d = insights.perCity[c];
      const mins = d.lastAt ? (Date.now() - d.lastAt) / 60000 : Infinity;
      const heat = d.todayInRange > 0 ? "hot" : mins < 120 ? "warm" : "cold";
      return { c, d, heat };
    });

    const signature = rows.map((r) => `${r.c}:${r.d.todayInRange}:${r.d.todayTotal}:${Math.floor(r.d.lastAt / 60000)}`).join("~");
    if (signature === railSignature) return;
    railSignature = signature;

    if (hint) {
      hint.textContent = insights.bestSum > 0
        ? `busiest ${String(insights.bestStart).padStart(2, "0")}:00–${String((insights.bestStart + 3) % 24).padStart(2, "0")}:00 IST`
        : "";
    }

    rail.innerHTML = rows.map(({ c, d, heat }) => `
      <div class="city ${heat}" data-city="${esc(c)}">
        <span class="freshdot"></span>
        <div class="city-name">${esc(c.toUpperCase())}</div>
        <div class="city-big">${d.todayInRange}</div>
        <div class="city-sub">in range today<br>${d.todayTotal} seen · last ${shortAgo(d.lastAt)}</div>
      </div>`).join("");
  }

  // 04 — Client health. errorCount ÷ roundCount, worst first.
  function buildHealth(profiles, statuses) {
    const out = [];
    for (const p of profiles) {
      const st = statuses[p.username] || {};
      const rounds = st.roundCount || 0;
      const errs = st.errorCount || 0;
      if (rounds < 10) continue;               // too little data to judge
      out.push({
        username: p.username,
        name: p.name || deriveProfileName(p.username),
        rounds, errs,
        rate: errs / rounds,
      });
    }
    out.sort((a, b) => b.rate - a.rate);
    return out;
  }

  // 03 — Pipeline value. Owner-only: prices are hidden from staff by the
  // same rule that hides the price column on the card.
  function buildPipeline(profiles, statuses) {
    const cloudMap = {};
    cloudProfiles.forEach((cp) => { cloudMap[cp.username] = cp; });

    const monthKey = istDayKey(Date.now()).substring(0, 7);
    const p = {
      bookedValue: 0, bookedCount: 0, bookedApplicants: 0,
      flightValue: 0, flightCount: 0,
      riskValue: 0, riskCount: 0,
      byStaff: {},
    };

    for (const prof of profiles) {
      const a = resolveAttention(prof, statuses, cloudMap);
      const price = Number(prof.agreedPrice) || 0;
      const st = statuses[prof.username] || {};
      const cloud = cloudMap[prof.username] || {};

      if (a.status === "confirmed") {
        const when = st.confirmedAt || cloud.confirmedAt;
        if (when && istDayKey(when) && istDayKey(when).substring(0, 7) === monthKey) {
          p.bookedValue += price;
          p.bookedCount++;
          p.bookedApplicants += Number(prof.applicantCount) || 1;
        }
        const sid = cloud.assignedStaffId || "__me";
        if (!p.byStaff[sid]) p.byStaff[sid] = { count: 0, value: 0 };
        p.byStaff[sid].count++;
        p.byStaff[sid].value += price;
      // "at risk" is a money bucket, not the strict 24h rate-limit gate, so a
      // local rate_limited status counts even without a cloud timestamp.
      } else if (a.rateLimited || ["error", "session_expired", "rate_limited"].includes(a.status)) {
        p.riskValue += price;
        p.riskCount++;
      } else {
        p.flightValue += price;
        p.flightCount++;
      }
    }
    return p;
  }

  function rupees(n) {
    return "₹" + Math.round(n || 0).toLocaleString("en-IN");
  }

  // 05 — Wall mode. A read-only overlay for a second monitor. Purely a
  // different view of numbers already on screen; it starts nothing and
  // stops nothing, so it cannot affect a running client.
  let wallOn = false;
  let wallSignature = "";
  let lastRefresh = null;      // last payload, so wall mode can paint at once

  function toggleWallMode(on) {
    wallOn = on === undefined ? !wallOn : !!on;
    const el = document.getElementById("wall-mode");
    if (!el) return;
    el.hidden = !wallOn;
    document.body.classList.toggle("wall-open", wallOn);
    const btn = document.getElementById("wall-mode-btn");
    if (btn) btn.setAttribute("aria-pressed", wallOn ? "true" : "false");

    if (!wallOn) return;
    wallSignature = "";
    // Paint from the cached payload immediately — refresh() is async and
    // waiting on it would show a blank black screen for up to 2 seconds.
    if (lastRefresh) {
      renderWallMode(lastRefresh.profiles, lastRefresh.statuses,
                     buildSlotInsights(lastRefresh.slotHistory), lastRefresh.events);
    }
    refresh();
  }

  function renderWallMode(profiles, statuses, insights, events) {
    if (!wallOn) return;
    const el = document.getElementById("wall-mode");
    if (!el) return;

    const cloudMap = {};
    cloudProfiles.forEach((cp) => { cloudMap[cp.username] = cp; });

    let cycling = 0, found = 0, confirmed = 0, blocked = 0;
    for (const p of profiles) {
      const a = resolveAttention(p, statuses, cloudMap);
      if (["cycling", "logging_in", "security_questions", "on_dashboard"].includes(a.status)) cycling++;
      if (a.status === "slot_found") found++;
      if (a.status === "confirmed") confirmed++;
      if (a.rateLimited) blocked++;
    }

    const todaySeen = CONSULATES.reduce((s, c) => s + insights.perCity[c].todayTotal, 0);
    const cityLine = CONSULATES
      .map((c) => ({ c, d: insights.perCity[c] }))
      .sort((a, b) => b.d.todayInRange - a.d.todayInRange || b.d.todayTotal - a.d.todayTotal)
      .map(({ c, d }) => `<span class="wall-city${d.todayInRange > 0 ? " hot" : ""}">${esc(c)} <b>${d.todayInRange}</b></span>`)
      .join("");

    const feed = (events || []).slice(0, 6).map((e) => `
      <div class="wall-ev${e.type === "slot_found" ? " found" : e.type === "error" ? " err" : ""}">
        <span class="t">${formatTime(e.timestamp)}</span>
        <span>${esc(deriveProfileName(e.username))} — ${esc(e.message)}</span>
      </div>`).join("");

    const html = `
      <div class="wall-top">
        <span class="wall-brand">SLOTHUNTER · OPS</span>
        <span class="wall-clock">${new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })} IST</span>
      </div>
      <div class="wall-stats">
        <div class="wall-stat a"><div class="k">CYCLING</div><div class="v">${cycling}</div></div>
        <div class="wall-stat b"><div class="k">SLOTS TODAY</div><div class="v">${todaySeen}</div></div>
        <div class="wall-stat c"><div class="k">CONFIRMED</div><div class="v">${confirmed}</div></div>
        <div class="wall-stat d"><div class="k">BLOCKED</div><div class="v">${blocked}</div></div>
      </div>
      <div class="wall-cities">${cityLine}</div>
      <div class="wall-feed">${feed}</div>
      <div class="wall-exit">Esc to exit</div>`;

    const sig = hashString(html.replace(/\d{2}:\d{2}:\d{2}/, ""));  // ignore the ticking clock
    if (sig !== wallSignature) {
      wallSignature = sig;
      el.innerHTML = html;
    } else {
      const clock = el.querySelector(".wall-clock");
      if (clock) clock.textContent = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }) + " IST";
    }
  }

  // ─── SHELL UI (issue #59, Phase 1) ─────────────────────────────────
  // Attention lane, header sync dots, overflow menu, command palette and
  // the background-tab badge. Everything here is additive: if ui-kit.js
  // fails to load, or __SH_UI_KIT_OFF is set, UI_SHELL goes false and
  // every hook below turns into a no-op. Nothing existing depends on it.

  const UI_SHELL = !window.__SH_UI_KIT_OFF && !!window.SHUI;

  const ATTENTION_ACTIVE_STATES = ["cycling", "logging_in", "security_questions", "on_dashboard", "slot_found"];
  let laneSignature = "";          // skips the DOM write when nothing changed
  const announcedSlots = new Set(); // usernames already counted in the tab badge

  const LANE_ICONS = {
    found: '<path d="M12 2.6l2.7 5.9 6.4.8-4.7 4.4 1.2 6.3L12 16.9 6.4 20l1.2-6.3L2.9 9.3l6.4-.8z"/>',
    blocked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  };

  // Same precedence rules renderUserCards uses, kept in one place so the
  // lane can never disagree with the card it points at.
  function resolveAttention(profile, statuses, cloudMap) {
    const cloud = cloudMap[profile.username] || {};
    const local = statuses[profile.username] || {};
    const localSt = local.status || "";
    const cloudSt = cloud.status || "";
    const status = ATTENTION_ACTIVE_STATES.includes(localSt)
      ? localSt
      : (ATTENTION_ACTIVE_STATES.includes(cloudSt) ? cloudSt : (localSt || cloudSt || "idle"));

    const rlMs = cloud.rateLimitedAt ? new Date(cloud.rateLimitedAt).getTime() : 0;
    const rateLimited = rlMs > 0 && (Date.now() - rlMs < 24 * 60 * 60 * 1000);
    const hoursLeft = rateLimited
      ? Math.max(0, Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - rlMs)) / 3600000))
      : 0;

    return { status, rateLimited, hoursLeft, local, cloud };
  }

  function collectAttention(profiles, statuses) {
    const cloudMap = {};
    cloudProfiles.forEach((cp) => { cloudMap[cp.username] = cp; });

    const items = [];
    for (const p of profiles) {
      const a = resolveAttention(p, statuses, cloudMap);
      const name = p.name || deriveProfileName(p.username);

      if (a.status === "slot_found") {
        const st = a.local.foundAt || a.cloud.foundAt || null;
        items.push({
          kind: "found",
          username: p.username,
          title: `Slot in range — ${name}`,
          detail: st ? `Found ${timeAgo(st)} · waiting on you` : "Waiting on you",
        });
      } else if (a.rateLimited) {
        items.push({
          kind: "blocked",
          username: p.username,
          title: `Rate limited — ${name}`,
          detail: `Blocked ~${a.hoursLeft}h more · do not log in from any device`,
        });
      }
    }
    // Found first: it is time-critical, a block is not.
    items.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "found" ? -1 : 1));
    return items;
  }

  function renderAttentionLane(profiles, statuses) {
    if (!UI_SHELL) return;
    const lane = document.getElementById("attention-lane");
    const grid = document.getElementById("lane-grid");
    const count = document.getElementById("lane-count");
    if (!lane || !grid || !count) return;

    const items = collectAttention(profiles, statuses);

    // The lane redraws on the same 2s tick as everything else. Hashing the
    // rendered content means an unchanged lane never touches the DOM, so
    // hover and the breathing animation survive.
    const signature = items.map((i) => `${i.kind}|${i.username}|${i.detail}`).join("~");
    if (signature === laneSignature) return;
    laneSignature = signature;

    if (!items.length) {
      lane.hidden = true;
      grid.innerHTML = "";
      count.textContent = "0";
      return;
    }

    lane.hidden = false;
    count.textContent = String(items.length);
    grid.innerHTML = items.map((i) => `
      <div class="lane-item lane-${i.kind}">
        <svg class="lane-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LANE_ICONS[i.kind]}</svg>
        <div class="lane-body">
          <h4>${SHUI.esc(i.title)}</h4>
          <p>${SHUI.esc(i.detail)}</p>
        </div>
        <button type="button" class="btn btn-small lane-goto" data-user="${SHUI.esc(i.username)}">Show</button>
      </div>`).join("");
  }

  // A slot going from not-found to found is the one event worth stealing
  // the operator's attention for, so it drives both the toast and the badge.
  function announceNewSlots(profiles, statuses) {
    if (!UI_SHELL) return;
    const cloudMap = {};
    cloudProfiles.forEach((cp) => { cloudMap[cp.username] = cp; });

    const stillFound = new Set();
    for (const p of profiles) {
      const a = resolveAttention(p, statuses, cloudMap);
      if (a.status !== "slot_found") continue;
      stillFound.add(p.username);
      if (announcedSlots.has(p.username)) continue;
      announcedSlots.add(p.username);

      const name = p.name || deriveProfileName(p.username);
      SHUI.bumpBadge("Slot found");
      SHUI.toast({
        kind: "found",
        title: `Slot in range — ${name}`,
        body: "Open the client to submit.",
        actionLabel: "Show",
        onAction: () => focusProfileCard(p.username),
      });
    }
    // Let a client re-announce if it drops out of slot_found and returns.
    announcedSlots.forEach((u) => { if (!stillFound.has(u)) announcedSlots.delete(u); });
  }

  function focusProfileCard(username) {
    const card = document.querySelector(`#user-cards .user-card[data-username="${CSS.escape(username)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: SHUI.reduceMotion ? "auto" : "smooth" });
    card.classList.add("sh-flash");
    setTimeout(() => card.classList.remove("sh-flash"), 1200);
  }

  // Connection dots on the header sync cluster.
  function updateSyncDots() {
    if (!UI_SHELL) return;
    const cloudOn = !!(typeof SUPA !== "undefined" && SUPA && SUPA.isReady && SUPA.isReady());
    document.getElementById("cloud-btn")?.classList.toggle("is-on", cloudOn);

    // The sheets dot is owned by updateSheetsUI(), which is the only place
    // that knows the real connection state. Touching it here too would make
    // the two fight over the class on every 2s tick.

    chrome.storage.local.get(["telegramBotToken", "telegramChatId"], (d) => {
      const on = !!(d.telegramBotToken && d.telegramChatId);
      document.getElementById("telegram-btn")?.classList.toggle("is-on", on);
    });
  }

  async function refresh() {
    const data = await loadData();
    lastRefresh = data;
    updateStats(data.profiles, data.statuses, data.events);
    renderAttentionLane(data.profiles, data.statuses);
    announceNewSlots(data.profiles, data.statuses);
    updateSyncDots();
    renderUserCards(data.profiles, data.statuses, data.slotHistory);
    renderActivityLog(data.events);
    renderSlotHistory(data.slotHistory, data.profiles);
    renderStats(data.dailyStats, data.storageStats, data.slotHistory, data.profiles, data.statuses);
    updateLogUserFilter(data.profiles);

    // #59 Insights — one slotHistory pass shared by the rail and wall mode.
    const insights = buildSlotInsights(data.slotHistory);
    renderConsulateRail(insights);
    renderWallMode(data.profiles, data.statuses, insights, data.events);

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
  document.getElementById("profile-search")?.addEventListener("input", refresh);
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
      // renderStats skips itself while the pane is hidden, so on first reveal
      // paint straight from the cached payload — otherwise the tab sits empty
      // until the next 2s tick.
      if (lastRefresh) {
        renderStats(lastRefresh.dailyStats, lastRefresh.storageStats,
                    lastRefresh.slotHistory, lastRefresh.profiles, lastRefresh.statuses);
      }
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

      // #63 CAPTCHA row removed from the form — nothing to populate.

      document.getElementById("edit-delete-btn").style.display = "inline-block";
      applyStaffModeToEditModal();
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

    // #63 CAPTCHA selector removed from the form — always auto (OCR).
    const captchaMode = "auto";

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
        if (staffMode) {
          // Staff may only change the date range and the cities. Sending just
          // those fields keeps the credentials untouched — a whole-profile push
          // would re-encrypt the password and be rejected by the database.
          try {
            await SUPA.updateProfileFields(originalUsername, {
              startDate: updated.startDate,
              endDate: updated.endDate,
              locations: updated.locations,
            });
          } catch (e) {
            window.alert("Could not save: " + e.message);
            return;
          }
        } else {
          try { await SUPA.pushProfile(saved); } catch (e) { console.warn("Supabase push failed:", e.message); }
        }
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
    document.getElementById("edit-auto-submit").checked = true;   // #63 auto-submit on by default
    // #63 CAPTCHA selector removed from the form — captchaMode is always "auto".
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

      // Cloud is the source of truth for the SET of profiles — drop locals deleted on
      // another dashboard (the merge above only adds/updates, never removes). #42
      const cloudUsers = new Set(cloudProfiles.map((cp) => cp.username));
      localProfiles = localProfiles.filter((p) => cloudUsers.has(p.username));

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
    syncStaffMode();   // #53 — the view follows whichever key is connected
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
      if (exportBtn) exportBtn.style.display = staffMode ? "none" : "inline-block";
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
      if (!/^TEST-/i.test(deviceName)) deviceName = "TEST-" + deviceName;  // TEST build tag
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

    let deviceName = prompt("Name this Chrome profile (e.g. Ravi-Laptop, Arun-Main):");
    if (!deviceName || !deviceName.trim()) {
      statusEl.textContent = "Device name required!";
      statusEl.style.color = "#ef5350";
      return;
    }
    deviceName = deviceName.trim();
    if (!/^TEST-/i.test(deviceName)) deviceName = "TEST-" + deviceName;  // TEST build tag

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
        updateCloudUI();      // calls syncStaffMode()
        startCloudPolling();
      }
    }).catch(() => {});
  }

  // #57b Pull the latest profiles right before a sheet write, so edits made
  // seconds earlier are included (the cached cloudProfiles only refreshes on the
  // 30s poll). Also updates the global cache so the dashboard reflects them.
  async function freshProfiles() {
    if (SUPA && SUPA.isReady()) {
      try {
        const p = await SUPA.pullProfiles();
        if (Array.isArray(p)) { cloudProfiles = p; return p; }
      } catch (e) {
        console.warn("[Dashboard] freshProfiles pull failed:", e.message);
      }
    }
    return cloudProfiles;
  }

  // #57 username -> assigned staff name, for the owner's master sheet. Sourced
  // from cloud data (the local profile list may not carry the assignment).
  async function buildAssigneeMap() {
    const map = {};
    try {
      if (!SUPA || !SUPA.isReady() || (SUPA.isStaffMode && SUPA.isStaffMode())) return map;
      const staff = await SUPA.listStaff();
      const nameById = {};
      staff.forEach((st) => { nameById[st.id] = st.name; });
      cloudProfiles.forEach((cp) => {
        if (cp.assignedStaffId && nameById[cp.assignedStaffId]) map[cp.username] = nameById[cp.assignedStaffId];
      });
    } catch (e) {
      console.warn("[Dashboard] buildAssigneeMap failed:", e.message);
    }
    return map;
  }

  // ─── STAFF VIEW (#53) ──────────────────────────────────────────────
  // What a staff member is allowed to do is decided by the database, not by
  // this file. Hiding controls here is about not showing someone buttons that
  // would only fail — it is presentation, not security.

  // Owner-only controls. Anything that would carry credentials or pricing off
  // the machine (export/import/sheets) is included deliberately.
  const OWNER_ONLY_IDS = [
    "add-user-btn",
    "export-btn", "export-csv-btn", "import-btn",
    "sheets-sync-btn", "sheets-url-input", "sheets-link",
    "cloud-export-btn",
    "team-mode-section",
    "staff-btn",
  ];

  function applyStaffModeUI() {
    OWNER_ONLY_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = staffMode ? "none" : "";
    });

    const badge = document.getElementById("staff-mode-badge");
    if (badge) badge.style.display = staffMode ? "" : "none";
    const banner = document.getElementById("staff-mode-banner");
    if (banner) banner.style.display = staffMode ? "" : "none";

    // A staff member has no team of their own to manage.
    if (staffMode) {
      teamMode = false;
      const bar = document.getElementById("bulk-assign-bar");
      if (bar) bar.style.display = "none";
    }

    const keyLabel = document.getElementById("cloud-api-key-label");
    if (keyLabel) keyLabel.textContent = staffMode ? "Your Access Key" : "Operator API Key";
  }

  // Called whenever the connection changes, so the view follows the key in use.
  function syncStaffMode() {
    const now = !!(SUPA && SUPA.isStaffMode && SUPA.isStaffMode());
    if (now === staffMode) return;
    staffMode = now;
    applyStaffModeUI();
    refresh();
  }

  // Trim the edit form down to what a staff member may actually change:
  // the date range and the cities. Everything else is hidden rather than
  // shown-and-rejected.
  function applyStaffModeToEditModal() {
    const modal = document.getElementById("edit-modal");
    if (!modal) return;
    const hide = (sel, on) => modal.querySelectorAll(sel).forEach((el) => {
      el.style.display = on ? "none" : "";
    });
    // form-row order: 0 username, 1 password ... price row is matched by its input
    const pwRow = document.getElementById("edit-password")?.closest(".form-row");
    if (pwRow) pwRow.style.display = staffMode ? "none" : "";
    const priceRow = document.getElementById("edit-price")?.closest(".form-row");
    if (priceRow) priceRow.style.display = staffMode ? "none" : "";
    const visaRow = document.getElementById("edit-visa-type")?.closest(".form-row");
    if (visaRow) visaRow.style.display = staffMode ? "none" : "";
    document.querySelectorAll(".edit-q-select").forEach((el) => {
      const row = el.closest(".form-row");
      if (row) row.style.display = staffMode ? "none" : "";
    });
    const pasteSection = document.getElementById("paste-section");
    if (pasteSection) pasteSection.style.display = staffMode ? "none" : "";
    const delBtn = document.getElementById("edit-delete-btn");
    if (delBtn) delBtn.style.display = staffMode ? "none" : "";
    const userRow = document.getElementById("edit-username")?.closest(".form-row");
    if (userRow && staffMode) document.getElementById("edit-username").readOnly = true;
    // hide the "Security Questions" / "Booking Preferences" style headings that
    // now have nothing under them
    modal.querySelectorAll(".form-section").forEach((h) => {
      const t = (h.textContent || "").trim().toLowerCase();
      if (t === "security questions" || t === "automation") {
        h.style.display = staffMode ? "none" : "";
      }
    });
    hide(".edit-checks", staffMode);
    const captchaRow = document.querySelector('input[name="edit-captcha"]')?.closest(".form-row");
    if (captchaRow) captchaRow.style.display = staffMode ? "none" : "";
  }

  // ─── TEAM MODE / STAFF (#52) ───────────────────────────────────────
  // Owner-side only. Everything here is inert while teamMode is false, so an
  // owner who never switches it on sees the dashboard exactly as before.

  function staffOptionsHtml(selectedId) {
    const opts = [`<option value=""${!selectedId ? " selected" : ""}>— me (unassigned) —</option>`];
    staffList.forEach((st) => {
      if (!st.active && st.id !== selectedId) return; // hide retired people, unless still shown on a card
      const sel = st.id === selectedId ? " selected" : "";
      opts.push(`<option value="${esc(st.id)}"${sel}>${esc(st.name)}${st.active ? "" : " (inactive)"}</option>`);
    });
    return opts.join("");
  }

  function applyTeamModeUI() {
    const btn = document.getElementById("staff-btn");
    const bar = document.getElementById("bulk-assign-bar");
    // #53 — a staff member never manages a team, whatever is saved locally.
    const on = teamMode && !staffMode;
    if (btn) btn.style.display = on ? "" : "none";
    if (bar) bar.style.display = on ? "flex" : "none";
    if (!teamMode) bulkSelected.clear();
    updateBulkCount();
  }

  function updateBulkCount() {
    const el = document.getElementById("bulk-count");
    if (el) el.textContent = `${bulkSelected.size} selected`;
  }

  async function refreshStaff() {
    if (!teamMode || !SUPA || !SUPA.isReady()) return;
    try {
      staffList = await SUPA.listStaff();
    } catch (e) {
      staffList = [];
      console.warn("[Dashboard] listStaff failed:", e.message);
    }
    staffById = {};
    staffList.forEach((st) => { staffById[st.id] = st; });
    renderStaffList();
    const bulkSel = document.getElementById("bulk-staff-select");
    if (bulkSel) bulkSel.innerHTML = staffOptionsHtml(bulkSel.value || null);
  }

  function renderStaffList() {
    const box = document.getElementById("staff-list");
    if (!box) return;
    if (staffList.length === 0) {
      box.innerHTML = '<div class="log-empty">Nobody added yet</div>';
      return;
    }
    const counts = {};
    cloudProfiles.forEach((cp) => {
      if (cp.assignedStaffId) counts[cp.assignedStaffId] = (counts[cp.assignedStaffId] || 0) + 1;
    });
    box.innerHTML = staffList.map((st) => `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 8px;margin-bottom:6px;background:#0f1923;border:1px solid #2d3e50;border-radius:5px;${st.active ? "" : "opacity:0.55;"}">
        <div style="flex:1;min-width:140px;">
          <div style="color:#e0e0e0;font-weight:bold;">${esc(st.name)}${st.active ? "" : ' <span style="color:#e67e22;font-weight:normal;">(inactive)</span>'}</div>
          <div style="font-size:11px;color:#78909c;">${esc(st.email) || "no email"} · ${counts[st.id] || 0} client(s)</div>
        </div>
        <button class="btn btn-small btn-gray staff-copy-key" data-id="${esc(st.id)}" title="Copy this person's key">Copy key</button>
        <button class="btn btn-small staff-rename" data-id="${esc(st.id)}" style="background:#34495e;color:#fff;">Rename</button>
        <button class="btn btn-small staff-newkey" data-id="${esc(st.id)}" style="background:#d35400;color:#fff;" title="Issue a new key — the old one stops working immediately">New key</button>
        <button class="btn btn-small staff-sheet" data-id="${esc(st.id)}" style="background:#0f9d58;color:#fff;" title="Create a Google Sheet of this person\u0027s clients and get a link to send them">Staff Google Sheet</button>
        <button class="btn btn-small staff-sheet-sync" data-id="${esc(st.id)}" style="background:#4285f4;color:#fff;" title="Refresh this person\u0027s sheet with the latest assigned clients">Sync Sheet</button>
        <button class="btn btn-small ${st.active ? "btn-red" : "btn-green"} staff-toggle" data-id="${esc(st.id)}" data-active="${st.active}">${st.active ? "Deactivate" : "Reactivate"}</button>
      </div>`).join("");
  }

  async function setTeamMode(on) {
    if (staffMode) return;   // #53 — not a staff member's control
    const statusEl = document.getElementById("team-mode-status");
    const setStatus = (msg, colour) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.style.color = colour || "#78909c";
    };

    if (on) {
      if (!SUPA || !SUPA.isReady()) {
        setStatus("Connect Cloud Sync first — team mode needs the database.", "#ef5350");
        document.getElementById("team-mode-toggle").checked = false;
        return;
      }
      // Refuse to switch on against a database that hasn't had the staff tables
      // added yet — better a clear message now than a half-working screen later.
      const ready = await SUPA.staffTablesReady();
      if (!ready) {
        setStatus("This database isn't set up for team mode yet — run sql/01, 02 and 03 first.", "#ef5350");
        document.getElementById("team-mode-toggle").checked = false;
        return;
      }
      setStatus("Team mode on.", "#3ecf8e");
    } else {
      setStatus("Team mode off — dashboard back to normal.", "#78909c");
    }

    teamMode = on;
    await chrome.storage.local.set({ __team_mode: on });
    applyTeamModeUI();
    await refreshStaff();
    refresh();
  }

  // ── wiring ──────────────────────────────────────────────────────────

  document.getElementById("team-mode-toggle")?.addEventListener("change", (e) => {
    setTeamMode(e.target.checked);
  });

  document.getElementById("staff-btn")?.addEventListener("click", async () => {
    document.getElementById("staff-modal").style.display = "flex";
    await refreshStaff();
  });

  document.getElementById("staff-close-btn")?.addEventListener("click", () => {
    document.getElementById("staff-modal").style.display = "none";
  });

  document.getElementById("staff-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "staff-modal") e.target.style.display = "none";
  });

  document.getElementById("staff-add-btn")?.addEventListener("click", async () => {
    const nameEl = document.getElementById("staff-new-name");
    const emailEl = document.getElementById("staff-new-email");
    const statusEl = document.getElementById("staff-add-status");
    const name = nameEl.value.trim();
    if (!name) {
      statusEl.textContent = "Name is required.";
      statusEl.style.color = "#ef5350";
      return;
    }
    try {
      const row = await SUPA.createStaff(name, emailEl.value.trim());
      nameEl.value = "";
      emailEl.value = "";
      await refreshStaff();
      // Show the key once, right after creating, so it can be copied and sent.
      statusEl.innerHTML = `Added <b>${esc(name)}</b>. Their key: <code style="color:#3ecf8e;">${esc(row.staff_key)}</code> — use "Copy key" to send it.`;
      statusEl.style.color = "#3ecf8e";
    } catch (e) {
      statusEl.textContent = "Could not add: " + e.message;
      statusEl.style.color = "#ef5350";
    }
  });

  document.getElementById("staff-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    const staff = staffById[id];
    if (!staff) return;

    if (btn.classList.contains("staff-copy-key")) {
      try {
        await navigator.clipboard.writeText(staff.staffKey);
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy key"; }, 1500);
      } catch {
        window.prompt("Copy this key and send it to " + staff.name + ":", staff.staffKey);
      }
      return;
    }

    if (btn.classList.contains("staff-rename")) {
      const name = window.prompt("Name:", staff.name);
      if (name === null) return;
      if (!name.trim()) return;
      const email = window.prompt("Email (leave blank for none):", staff.email || "");
      if (email === null) return;
      await SUPA.updateStaff(id, { name: name.trim(), email: email.trim() });
      await refreshStaff();
      return;
    }

    if (btn.classList.contains("staff-newkey")) {
      if (!window.confirm(`Issue a NEW key for ${staff.name}?\n\nTheir current key stops working straight away and they will have to enter the new one.`)) return;
      const row = await SUPA.regenerateStaffKey(id);
      await refreshStaff();
      window.prompt("New key for " + staff.name + " — copy and send it:", row.staff_key);
      return;
    }

    // #57 Staff Google Sheet — create the sheet + hand back a link to forward.
    if (btn.classList.contains("staff-sheet")) {
      if (typeof SheetsSync === "undefined") { window.alert("Google Sheets is not available."); return; }
      const orig = btn.textContent;
      btn.textContent = "Creating..."; btn.disabled = true;
      try {
        const fresh = await freshProfiles();
        const clients = fresh.filter((cp) => cp.assignedStaffId === id);
        if (clients.length === 0) { btn.textContent = orig; btn.disabled = false; window.alert(staff.name + " has no clients assigned yet - assign some first."); return; }
        const res = await SheetsSync.exportStaffBackup(id, staff.name, clients);
        btn.textContent = orig; btn.disabled = false;
        window.prompt("Google Sheet ready - " + res.count + " client(s) for " + staff.name + ".\n\nSend THIS link to " + staff.name + " (only their clients, no pricing):", res.url);
      } catch (e) {
        btn.textContent = orig; btn.disabled = false;
        window.alert("Could not create the sheet: " + e.message);
      }
      return;
    }

    // #57 Sync Sheet — push the latest assigned clients into the same sheet.
    if (btn.classList.contains("staff-sheet-sync")) {
      if (typeof SheetsSync === "undefined") { window.alert("Google Sheets is not available."); return; }
      const orig = btn.textContent;
      btn.textContent = "Syncing..."; btn.disabled = true;
      try {
        const fresh = await freshProfiles();
        const clients = fresh.filter((cp) => cp.assignedStaffId === id);
        const res = await SheetsSync.exportStaffBackup(id, staff.name, clients);
        btn.textContent = orig; btn.disabled = false;
        window.prompt("Synced - " + res.count + " client(s) now in " + staff.name + "'s sheet (same link):", res.url);
      } catch (e) {
        btn.textContent = orig; btn.disabled = false;
        window.alert("Sync failed: " + e.message);
      }
      return;
    }

    if (btn.classList.contains("staff-toggle")) {
      const nowActive = btn.dataset.active === "true";
      if (nowActive) {
        const held = cloudProfiles.filter((cp) => cp.assignedStaffId === id).length;
        if (!window.confirm(`Deactivate ${staff.name}?\n\nTheir access stops immediately and their ${held} client(s) come back to you.`)) return;
      }
      await SUPA.updateStaff(id, { active: !nowActive });
      await pullCloudProfiles();   // assignments changed underneath us
      await refreshStaff();
      refresh();
    }
  });

  // Per-card assignment
  document.getElementById("user-cards")?.addEventListener("change", async (e) => {
    const sel = e.target.closest(".assign-select");
    if (sel) {
      const username = sel.dataset.user;
      try {
        await SUPA.assignClient(username, sel.value || null);
        const cp = cloudProfiles.find((c) => c.username === username);
        if (cp) cp.assignedStaffId = sel.value || null;
        await refreshStaff();
      } catch (err) {
        window.alert("Could not assign: " + err.message);
      }
      return;
    }
    const tick = e.target.closest(".bulk-tick");
    if (tick) {
      if (tick.checked) bulkSelected.add(tick.dataset.user);
      else bulkSelected.delete(tick.dataset.user);
      updateBulkCount();
    }
  });

  // Bulk assign
  document.getElementById("bulk-select-all")?.addEventListener("change", (e) => {
    document.querySelectorAll("#user-cards .bulk-tick").forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) bulkSelected.add(cb.dataset.user);
      else bulkSelected.delete(cb.dataset.user);
    });
    updateBulkCount();
  });

  document.getElementById("bulk-assign-btn")?.addEventListener("click", async () => {
    const statusEl = document.getElementById("bulk-status");
    const target = document.getElementById("bulk-staff-select").value || null;
    const names = Array.from(bulkSelected);
    if (names.length === 0) {
      statusEl.textContent = "Nothing selected.";
      statusEl.style.color = "#e67e22";
      return;
    }
    const who = target ? (staffById[target]?.name || "that person") : "you (unassigned)";
    if (!window.confirm(`Assign ${names.length} client(s) to ${who}?`)) return;

    statusEl.textContent = `Assigning ${names.length}…`;
    statusEl.style.color = "#78909c";
    const { ok, failed } = await SUPA.assignClients(names, target);
    if (failed.length) {
      statusEl.textContent = `${ok} assigned, ${failed.length} failed (${failed[0].error})`;
      statusEl.style.color = "#ef5350";
    } else {
      statusEl.textContent = `${ok} assigned to ${who}.`;
      statusEl.style.color = "#3ecf8e";
    }
    bulkSelected.clear();
    document.getElementById("bulk-select-all").checked = false;
    updateBulkCount();
    await pullCloudProfiles();
    await refreshStaff();
    refresh();
  });

  // Restore the switch on load
  chrome.storage.local.get(["__team_mode"], (d) => {
    teamMode = !!d.__team_mode && !staffMode;
    const toggle = document.getElementById("team-mode-toggle");
    if (toggle) toggle.checked = teamMode;
    applyTeamModeUI();
    if (teamMode) {
      refresh();                          // first paint happened before this read
      setTimeout(refreshStaff, 1500);     // let cloud sync connect first
    }
  });

  // ─── SHELL UI WIRING (issue #59, Phase 1) ──────────────────────────
  // Every action below re-uses an existing control by clicking it, so the
  // palette and the overflow menu cannot drift from the buttons they
  // stand in for, and no logic is duplicated.

  if (UI_SHELL) {
    // Attention lane → jump to the card.
    document.getElementById("lane-grid")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".lane-goto");
      if (btn) focusProfileCard(btn.dataset.user);
    });

    // Consulate rail → filter the grid to that city's clients.
    document.getElementById("consulate-rail")?.addEventListener("click", (e) => {
      const tile = e.target.closest(".city");
      if (!tile) return;
      const search = document.getElementById("profile-search");
      if (!search) return;
      const city = tile.dataset.city || "";
      search.value = search.value.trim().toLowerCase() === city.toLowerCase() ? "" : city;
      refresh();
    });

    // Wall mode.
    document.getElementById("wall-mode-btn")?.addEventListener("click", () => toggleWallMode());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && wallOn) { e.preventDefault(); toggleWallMode(false); }
    });

    // Header overflow menu.
    const moreBtn = document.getElementById("hdr-more-btn");
    const morePanel = document.getElementById("hdr-more-panel");
    if (moreBtn && morePanel) {
      const setMenu = (open) => {
        morePanel.setAttribute("data-open", open ? "1" : "0");
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      };
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setMenu(morePanel.getAttribute("data-open") !== "1");
      });
      // Import opens a file dialog, so the menu must not eat the click.
      morePanel.addEventListener("click", (e) => {
        if (e.target.closest("input")) return;
        if (e.target.closest("button, a")) setMenu(false);
      });
      document.addEventListener("click", (e) => {
        if (!e.target.closest(".hdr-more")) setMenu(false);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") setMenu(false);
      });
    }

    const clickById = (id) => document.getElementById(id)?.click();

    SHUI.setPaletteProvider(() => {
      const items = [];

      document.querySelectorAll("#user-cards .user-card").forEach((card) => {
        const username = card.dataset.username;
        if (!username) return;
        const badge = card.querySelector(".status-badge");
        const statusText = badge ? badge.textContent.trim() : "";
        const tone = card.classList.contains("slot-found") ? "found"
          : card.classList.contains("error") ? "error"
          : card.classList.contains("active") ? "live"
          : card.classList.contains("confirmed") ? "ok" : "idle";
        items.push({
          group: "Clients",
          label: card.querySelector(".card-name")?.textContent.trim() || username,
          meta: statusText,
          tone,
          run: () => focusProfileCard(username),
        });
      });

      const cmd = (label, id) => {
        const el = document.getElementById(id);
        // Skip anything hidden — staff mode hides owner-only controls, and
        // the palette must not offer what the page will not honour.
        if (!el || el.style.display === "none") return;
        items.push({ group: "Commands", label, tone: "cmd", run: () => clickById(id) });
      };

      cmd("Add client", "add-user-btn");
      cmd("Open Cloud Sync", "cloud-btn");
      cmd("Open Telegram settings", "telegram-btn");
      cmd("Open Google Sheets sync", "sheets-sync-btn");
      cmd("Open Staff", "staff-btn");
      cmd("Export JSON", "export-btn");
      cmd("Export CSV", "export-csv-btn");
      cmd("Import JSON", "import-btn");
      cmd("Toggle activity log panel", "toggle-logs-btn");

      return items;
    });
  }

  refresh();
  setInterval(refresh, REFRESH_INTERVAL);
})();
