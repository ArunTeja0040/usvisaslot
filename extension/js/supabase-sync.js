// ─── SUPABASE SYNC MODULE ──────────────────────────────────────────────
// Handles all communication between extension and Supabase cloud database.
// Uses PostgREST API directly (no SDK needed).
// ────────────────────────────────────────────────────────────────────────

const SupabaseSync = (() => {
  const SUPABASE_URL = "https://sbuaojiamicreyysvnqj.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_OrTLSVqVljSOoIeUZIoIcw_O0udxgyq";
  const REST_URL = `${SUPABASE_URL}/rest/v1`;

  const EVENT_BUFFER_MAX = 50;
  const EVENT_FLUSH_INTERVAL_MS = 30000;
  const DEVICE_HEARTBEAT_MS = 2 * 60 * 1000;

  let operatorKey = null;
  let operatorId = null;
  let deviceId = null;
  let masterKey = null; // CryptoKey for encryption
  let eventBuffer = [];
  let flushTimer = null;
  let heartbeatTimer = null;
  let initialized = false;

  // ─── HTTP HELPERS ─────────────────────────────────────────────────

  function headers() {
    const h = {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    };
    if (operatorKey) h["x-operator-key"] = operatorKey;
    return h;
  }

  async function query(table, params = "") {
    const res = await fetch(`${REST_URL}/${table}?${params}`, { headers: headers() });
    if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function insert(table, data) {
    const res = await fetch(`${REST_URL}/${table}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`INSERT ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function upsert(table, data, onConflict) {
    const h = { ...headers(), "Prefer": "return=representation,resolution=merge-duplicates" };
    const url = onConflict ? `${REST_URL}/${table}?on_conflict=${onConflict}` : `${REST_URL}/${table}`;
    const res = await fetch(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`UPSERT ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function update(table, match, data) {
    const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join("&");
    const res = await fetch(`${REST_URL}/${table}?${params}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`UPDATE ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function remove(table, match) {
    const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join("&");
    const res = await fetch(`${REST_URL}/${table}?${params}`, {
      method: "DELETE",
      headers: headers(),
    });
    if (!res.ok) throw new Error(`DELETE ${table}: ${res.status} ${await res.text()}`);
  }

  // ─── ENCRYPTION (AES-256-GCM) ────────────────────────────────────

  async function deriveKey(masterPassword, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(masterPassword), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encrypt(plaintext) {
    if (!masterKey) return plaintext;
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      masterKey,
      enc.encode(plaintext)
    );
    const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async function decrypt(encoded) {
    if (!masterKey || !encoded) return encoded;
    try {
      const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const iv = raw.slice(0, 12);
      const ciphertext = raw.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        masterKey,
        ciphertext
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return encoded;
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────

  async function init(opKey, masterPassword, deviceName) {
    operatorKey = opKey;

    // Get operator ID
    const ops = await query("operators", "select=id");
    if (!ops || ops.length === 0) throw new Error("Invalid operator key");
    operatorId = ops[0].id;

    // Derive encryption key
    if (masterPassword) {
      masterKey = await deriveKey(masterPassword, operatorId);
    }

    // Get or create device ID
    const stored = await chrome.storage.local.get(["__supabase_device_id"]);
    if (stored.__supabase_device_id) {
      deviceId = stored.__supabase_device_id;
      // Update last_seen
      try {
        await update("devices", { id: deviceId }, { last_seen: new Date().toISOString() });
      } catch {
        // Device might have been deleted, re-register
        deviceId = null;
      }
    }

    if (!deviceId) {
      const name = deviceName || `Device-${Date.now().toString(36)}`;
      const [device] = await insert("devices", {
        operator_id: operatorId,
        device_name: name,
        chrome_profile: "",
        last_seen: new Date().toISOString(),
      });
      deviceId = device.id;
      await chrome.storage.local.set({ __supabase_device_id: deviceId, __supabase_device_name: name });
    }

    // Save config locally (including master password for auto-reconnect decryption)
    await chrome.storage.local.set({
      __supabase_operator_key: opKey,
      __supabase_operator_id: operatorId,
      __supabase_master_pw: masterPassword || "",
    });

    // Start event flush timer
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => flushEvents(), EVENT_FLUSH_INTERVAL_MS);

    // Start device heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => heartbeat(), DEVICE_HEARTBEAT_MS);

    initialized = true;
    console.log("[SupabaseSync] Initialized — operator:", operatorId, "device:", deviceId);
    return { operatorId, deviceId };
  }

  async function initFromStorage() {
    const stored = await chrome.storage.local.get([
      "__supabase_operator_key",
      "__supabase_operator_id",
      "__supabase_device_id",
      "__supabase_master_pw",
    ]);
    if (stored.__supabase_operator_key) {
      operatorKey = stored.__supabase_operator_key;
      operatorId = stored.__supabase_operator_id;
      deviceId = stored.__supabase_device_id;

      // Restore encryption key from saved master password
      if (stored.__supabase_master_pw && operatorId) {
        masterKey = await deriveKey(stored.__supabase_master_pw, operatorId);
      }

      if (flushTimer) clearInterval(flushTimer);
      flushTimer = setInterval(() => flushEvents(), EVENT_FLUSH_INTERVAL_MS);

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => heartbeat(), DEVICE_HEARTBEAT_MS);

      initialized = true;
      console.log("[SupabaseSync] Restored from storage — operator:", operatorId, "encryption:", !!masterKey);
      return true;
    }
    return false;
  }

  function isReady() { return initialized && operatorId && deviceId; }
  function hasEncryption() { return !!masterKey; }

  async function heartbeat() {
    if (!isReady()) return;
    try {
      await update("devices", { id: deviceId }, { last_seen: new Date().toISOString() });
    } catch (e) {
      console.warn("[SupabaseSync] Heartbeat failed:", e.message);
    }
  }

  // ─── PROFILE SYNC ────────────────────────────────────────────────

  async function pushProfile(profile) {
    if (!isReady()) return null;

    const data = {
      operator_id: operatorId,
      active_device_id: deviceId,
      username: profile.username,
      password_enc: await encrypt(profile.password),
      visa_type: profile.visaType || null,
      start_date: profile.startDate || null,
      end_date: profile.endDate || null,
      locations: profile.locations || [],
      applicant_count: profile.applicantCount || 1,
      price_per_person: profile.pricePerPerson ? parseInt(profile.pricePerPerson) : null,
      agreed_price: profile.agreedPrice ? parseInt(profile.agreedPrice) : null,
      auto_login: profile.autoLogin !== false,
      auto_dashboard: profile.autoDashboard !== false,
      auto_select: profile.autoSelect !== false,
      auto_submit: profile.autoSubmit !== false,
      captcha_mode: profile.captchaMode || "auto",
      status: profile.status || "idle",
      is_active: profile.isActive || false,
    };

    // Security questions — local format is object { "question": "answer" }
    if (profile.securityQuestions) {
      const sq = profile.securityQuestions;
      const entries = Array.isArray(sq) ? sq.map(q => [q.question, q.answer]) : Object.entries(sq);
      for (let i = 0; i < Math.min(entries.length, 3); i++) {
        const [question, answer] = entries[i];
        data[`security_q${i + 1}`] = question || null;
        data[`security_a${i + 1}_enc`] = answer ? await encrypt(answer) : null;
      }
    }

    try {
      const result = await upsert("user_profiles", data, "operator_id,username");
      console.log("[SupabaseSync] Profile pushed:", profile.username);
      return result[0];
    } catch (e) {
      console.error("[SupabaseSync] pushProfile failed:", e.message);
      return null;
    }
  }

  async function pullProfiles() {
    if (!isReady()) return [];

    try {
      const profiles = await query("user_profiles", "select=*&order=username.asc");
      const decrypted = [];

      for (const p of profiles) {
        decrypted.push({
          id: p.id,
          username: p.username,
          password: await decrypt(p.password_enc),
          visaType: p.visa_type,
          startDate: p.start_date,
          endDate: p.end_date,
          locations: p.locations || [],
          applicantCount: p.applicant_count || 1,
          pricePerPerson: p.price_per_person,
          agreedPrice: p.agreed_price,
          autoLogin: p.auto_login,
          autoDashboard: p.auto_dashboard,
          autoSelect: p.auto_select,
          autoSubmit: p.auto_submit,
          captchaMode: p.captcha_mode,
          status: p.status,
          isActive: p.is_active,
          activeDeviceId: p.active_device_id,
          securityQuestions: [
            { question: p.security_q1, answer: await decrypt(p.security_a1_enc) },
            { question: p.security_q2, answer: await decrypt(p.security_a2_enc) },
            { question: p.security_q3, answer: await decrypt(p.security_a3_enc) },
          ].filter(q => q.question),
          updatedAt: p.updated_at,
        });
      }

      console.log("[SupabaseSync] Pulled", decrypted.length, "profiles");
      return decrypted;
    } catch (e) {
      console.error("[SupabaseSync] pullProfiles failed:", e.message);
      return [];
    }
  }

  async function deleteProfile(username) {
    if (!isReady()) return;
    try {
      await remove("user_profiles", { operator_id: operatorId, username });
      console.log("[SupabaseSync] Profile deleted:", username);
    } catch (e) {
      console.error("[SupabaseSync] deleteProfile failed:", e.message);
    }
  }

  async function updateProfileStatus(username, status, isActive = null) {
    if (!isReady()) return;
    const data = { status, updated_at: new Date().toISOString() };
    if (isActive !== null) {
      data.is_active = isActive;
      data.active_device_id = isActive ? deviceId : null;
      if (isActive) {
        const stored = await chrome.storage.local.get(["__supabase_device_name"]);
        data.active_device_name = stored.__supabase_device_name || null;
      } else {
        data.active_device_name = null;
      }
    }
    try {
      await update("user_profiles", { operator_id: operatorId, username }, data);
    } catch (e) {
      console.error("[SupabaseSync] updateProfileStatus failed:", e.message);
    }
  }

  // ─── SLOT HISTORY ────────────────────────────────────────────────

  async function pushSlot(entry) {
    if (!isReady()) return;
    try {
      await insert("slot_history", {
        operator_id: operatorId,
        device_id: deviceId,
        username: entry.username,
        location: entry.location,
        slot_date: entry.date,
        action: entry.action,
        in_range: entry.inRange || false,
        round: entry.round || null,
        detected_at: entry.detectedAt || new Date().toISOString(),
      });
    } catch (e) {
      console.error("[SupabaseSync] pushSlot failed:", e.message);
    }
  }

  async function pushSlotBatch(entries) {
    if (!isReady() || entries.length === 0) return;
    const rows = entries.map(e => ({
      operator_id: operatorId,
      device_id: deviceId,
      username: e.username,
      location: e.location,
      slot_date: e.date,
      action: e.action,
      in_range: e.inRange || false,
      round: e.round || null,
      detected_at: e.detectedAt || new Date().toISOString(),
    }));
    try {
      await insert("slot_history", rows);
    } catch (e) {
      console.error("[SupabaseSync] pushSlotBatch failed:", e.message);
    }
  }

  async function pullSlotHistory(filters = {}) {
    if (!isReady()) return [];
    let params = "select=*&order=detected_at.desc&limit=500";
    if (filters.username) params += `&username=eq.${filters.username}`;
    if (filters.location) params += `&location=eq.${filters.location}`;
    if (filters.since) params += `&detected_at=gte.${filters.since}`;
    try {
      return await query("slot_history", params);
    } catch (e) {
      console.error("[SupabaseSync] pullSlotHistory failed:", e.message);
      return [];
    }
  }

  async function updateSlotAction(username, location, date, newAction) {
    if (!isReady()) return;
    try {
      const matches = await query("slot_history",
        `username=eq.${username}&location=eq.${encodeURIComponent(location)}&slot_date=eq.${date}&order=detected_at.desc&limit=1`
      );
      if (matches.length > 0) {
        await update("slot_history", { id: matches[0].id }, { action: newAction });
      }
    } catch (e) {
      console.error("[SupabaseSync] updateSlotAction failed:", e.message);
    }
  }

  // ─── EVENT LOGS (BUFFERED) ───────────────────────────────────────

  function bufferEvent(event) {
    if (!isReady()) return;
    eventBuffer.push({
      operator_id: operatorId,
      device_id: deviceId,
      username: event.username || null,
      event_type: event.type,
      message: event.message,
      metadata: event.metadata || null,
      created_at: event.timestamp || new Date().toISOString(),
    });
    if (eventBuffer.length >= EVENT_BUFFER_MAX) {
      flushEvents();
    }
  }

  async function flushEvents() {
    if (!isReady() || eventBuffer.length === 0) return;
    const batch = eventBuffer.splice(0);
    try {
      const h = { ...headers() };
      delete h["Prefer"]; // no return needed for batch insert
      const res = await fetch(`${REST_URL}/event_logs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.warn("[SupabaseSync] flushEvents failed:", res.status);
        eventBuffer.unshift(...batch); // put back on failure
      } else {
        console.log("[SupabaseSync] Flushed", batch.length, "events");
      }
    } catch (e) {
      console.warn("[SupabaseSync] flushEvents error:", e.message);
      eventBuffer.unshift(...batch);
    }
  }

  async function pullEvents(filters = {}) {
    if (!isReady()) return [];
    let params = "select=*&order=created_at.desc&limit=200";
    if (filters.username) params += `&username=eq.${filters.username}`;
    if (filters.type) params += `&event_type=eq.${filters.type}`;
    if (filters.since) params += `&created_at=gte.${filters.since}`;
    try {
      return await query("event_logs", params);
    } catch (e) {
      console.error("[SupabaseSync] pullEvents failed:", e.message);
      return [];
    }
  }

  // ─── DAILY STATS ─────────────────────────────────────────────────

  async function pushDailyStat(stat) {
    if (!isReady()) return;
    try {
      await upsert("daily_stats", {
        operator_id: operatorId,
        device_id: deviceId,
        username: stat.username || null,
        stat_date: stat.date,
        stat_hour: stat.hour != null ? stat.hour : null,
        location: stat.location || null,
        rounds: stat.rounds || 0,
        slots_found: stat.slotsFound || 0,
        slots_in_range: stat.slotsInRange || 0,
        missed: stat.missed || 0,
        booked: stat.booked || 0,
        errors: stat.errors || 0,
        captcha_attempts: stat.captchaAttempts || 0,
        captcha_success: stat.captchaSuccess || 0,
      }, "operator_id,device_id,username,stat_date,stat_hour,location");
    } catch (e) {
      console.error("[SupabaseSync] pushDailyStat failed:", e.message);
    }
  }

  async function pushRequestStats(stats) {
    if (!isReady()) return;
    try {
      const stored = await chrome.storage.local.get(["__supabase_device_name"]);
      await insert("request_stats", {
        device_name: stored.__supabase_device_name || null,
        username: stats.username || "",
        period_start: stats.periodStart,
        period_end: stats.periodEnd,
        total_requests: stats.totalRequests || 0,
        successful_requests: stats.successfulRequests || 0,
        blocked_requests: stats.blockedRequests || 0,
        avg_delay_sec: stats.avgDelaySec || 0,
        locations_checked: stats.locationsChecked || [],
        error_types: stats.errorTypes || {},
      });
    } catch (e) {
      console.error("[SupabaseSync] pushRequestStats failed:", e.message);
    }
  }

  async function pullDailyStats(filters = {}) {
    if (!isReady()) return [];
    let params = "select=*&order=stat_date.desc,stat_hour.asc&limit=500";
    if (filters.username) params += `&username=eq.${filters.username}`;
    if (filters.days) {
      const since = new Date();
      since.setDate(since.getDate() - filters.days);
      params += `&stat_date=gte.${since.toISOString().split("T")[0]}`;
    }
    try {
      return await query("daily_stats", params);
    } catch (e) {
      console.error("[SupabaseSync] pullDailyStats failed:", e.message);
      return [];
    }
  }

  // ─── DEVICES ──────────────────────────────────────────────────────

  async function getDevices() {
    if (!isReady()) return [];
    try {
      return await query("devices", "select=*&order=last_seen.desc");
    } catch (e) {
      console.error("[SupabaseSync] getDevices failed:", e.message);
      return [];
    }
  }

  async function renameDevice(newName) {
    if (!isReady()) return;
    try {
      await update("devices", { id: deviceId }, { device_name: newName });
      await chrome.storage.local.set({ __supabase_device_name: newName });
    } catch (e) {
      console.error("[SupabaseSync] renameDevice failed:", e.message);
    }
  }

  async function deleteDevice() {
    if (!deviceId) throw new Error("No device registered");
    try {
      await remove("devices", { id: deviceId });
      // Clear all local Supabase state
      await chrome.storage.local.remove([
        "__supabase_device_id",
        "__supabase_device_name",
        "__supabase_operator_key",
        "__supabase_operator_id",
        "__supabase_master_pw",
        "__configLoaded",
      ]);
      // Stop timers
      if (flushTimer) clearInterval(flushTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      flushTimer = null;
      heartbeatTimer = null;
      // Reset state
      deviceId = null;
      operatorId = null;
      operatorKey = null;
      masterKey = null;
      initialized = false;
      console.log("[SupabaseSync] Device deleted and local state cleared");
    } catch (e) {
      console.error("[SupabaseSync] deleteDevice failed:", e.message);
      throw e;
    }
  }

  // ─── FULL SYNC (pull everything to local) ────────────────────────

  async function fullPull() {
    if (!isReady()) return null;
    try {
      const [profiles, slots, stats, devices] = await Promise.all([
        pullProfiles(),
        pullSlotHistory({ since: daysAgo(30) }),
        pullDailyStats({ days: 30 }),
        getDevices(),
      ]);
      console.log("[SupabaseSync] Full pull complete:", {
        profiles: profiles.length,
        slots: slots.length,
        stats: stats.length,
        devices: devices.length,
      });
      return { profiles, slots, stats, devices };
    } catch (e) {
      console.error("[SupabaseSync] fullPull failed:", e.message);
      return null;
    }
  }

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────

  function destroy() {
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    flushEvents();
    initialized = false;
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────

  return {
    init,
    initFromStorage,
    isReady,
    hasEncryption,
    destroy,

    // Encryption
    setMasterPassword: async (password) => {
      if (operatorId) masterKey = await deriveKey(password, operatorId);
    },

    // Profiles
    pushProfile,
    pullProfiles,
    deleteProfile,
    updateProfileStatus,

    // Slots
    pushSlot,
    pushSlotBatch,
    pullSlotHistory,
    updateSlotAction,

    // Events
    bufferEvent,
    flushEvents,
    pullEvents,

    // Stats
    pushDailyStat,
    pullDailyStats,
    pushRequestStats,

    // Devices
    getDevices,
    renameDevice,
    deleteDevice,

    // Full sync
    fullPull,

    // Getters
    getOperatorId: () => operatorId,
    getDeviceId: () => deviceId,
    getDeviceName: async () => {
      const stored = await chrome.storage.local.get(["__supabase_device_name"]);
      return stored.__supabase_device_name || null;
    },
  };
})();

if (typeof module !== "undefined") module.exports = SupabaseSync;
