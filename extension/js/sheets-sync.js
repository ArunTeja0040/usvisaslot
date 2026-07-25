const SheetsSync = (function () {
  "use strict";

  const HEADERS = [
    "S.No", "Username", "Password", "Dates (From to To)", "Location",
    "Security Que Ans 1", "Security Que Ans 2", "Security Que Ans 3",
    "No of Applicants", "Price Agreed", "Category", "Assigned To"
  ];

  // #57 Per-staff backup — same as HEADERS but WITHOUT "Price Agreed".
  // Pricing must never leave the owner's side.
  const STAFF_HEADERS = [
    "S.No", "Username", "Password", "Dates (From to To)", "Location",
    "Security Que Ans 1", "Security Que Ans 2", "Security Que Ans 3",
    "No of Applicants", "Category"
  ];
  const STORAGE_KEY = "__sheets_spreadsheet_id";
  const STORAGE_SHEET_NAME = "__sheets_sheet_name";

  let cachedToken = null;

  async function getToken(interactive = true) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          cachedToken = token;
          resolve(token);
        }
      });
    });
  }

  async function api(url, opts = {}) {
    const token = cachedToken || await getToken();
    const resp = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (resp.status === 401) {
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      cachedToken = null;
      const newToken = await getToken();
      const retry = await fetch(url, {
        ...opts,
        headers: {
          "Authorization": "Bearer " + newToken,
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
      });
      if (!retry.ok) throw new Error("Sheets API error: " + retry.status);
      return retry.json();
    }
    if (!resp.ok) throw new Error("Sheets API error: " + resp.status + " " + (await resp.text()));
    return resp.json();
  }

  async function getStored() {
    return new Promise((r) => {
      chrome.storage.local.get([STORAGE_KEY, STORAGE_SHEET_NAME], (d) => r({
        spreadsheetId: d[STORAGE_KEY] || null,
        sheetName: d[STORAGE_SHEET_NAME] || null,
      }));
    });
  }

  async function saveConfig(spreadsheetId, sheetName) {
    return new Promise((r) => {
      chrome.storage.local.set({ [STORAGE_KEY]: spreadsheetId, [STORAGE_SHEET_NAME]: sheetName }, r);
    });
  }

  function extractSheetId(urlOrId) {
    if (!urlOrId) return null;
    const match = urlOrId.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId)) return urlOrId;
    return null;
  }

  function extractGid(url) {
    if (!url) return null;
    const match = url.match(/gid=(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  async function resolveSheetName(spreadsheetId, gid) {
    const meta = await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    const sheets = meta.sheets || [];
    if (gid != null) {
      const found = sheets.find((s) => s.properties.sheetId === gid);
      if (found) return found.properties.title;
    }
    return sheets[0]?.properties?.title || "Sheet1";
  }

  async function createSpreadsheet() {
    const sheetName = "Profiles";
    const data = await api("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: "Visa Profiles — Auto Sync" },
        sheets: [{
          properties: { title: sheetName },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{
              values: HEADERS.map((h) => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: { textFormat: { bold: true } },
              })),
            }],
          }],
        }],
      }),
    });
    await saveConfig(data.spreadsheetId, sheetName);
    return { spreadsheetId: data.spreadsheetId, sheetName };
  }

  // #57b Security questions arrive in two shapes: an ARRAY of {question, answer}
  // (cloud/pullProfiles) or a {question: answer} OBJECT (local). Normalise both
  // to [[q, a], ...] so a row never renders "0: [object Object]".
  function sqPairs(sq) {
    if (!sq) return [];
    if (Array.isArray(sq)) return sq.map((o) => [o.question, o.answer]);
    return Object.entries(sq);
  }

  function profileToRow(profile, index, assignee) {
    const qas = sqPairs(profile.securityQuestions);
    const qa1 = qas[0] ? qas[0][0] + ": " + qas[0][1] : "";
    const qa2 = qas[1] ? qas[1][0] + ": " + qas[1][1] : "";
    const qa3 = qas[2] ? qas[2][0] + ": " + qas[2][1] : "";
    const locations = (profile.locations || []).join(", ");
    const dates = (profile.startDate && profile.endDate)
      ? profile.startDate + " to " + profile.endDate
      : (profile.startDate || profile.endDate || "");
    return [
      index + 1,
      profile.username || "",
      profile.password || "",
      dates,
      locations,
      qa1, qa2, qa3,
      profile.applicantCount || 1,
      profile.agreedPrice || "",
      profile.visaType || "",
      assignee || "",
    ];
  }

  async function fullSync(profiles, assigneeByUsername) {
    const stored = await getStored();
    if (!stored.spreadsheetId || !stored.sheetName) throw new Error("Not connected");

    const rows = [HEADERS];
    const amap = assigneeByUsername || {};
    profiles.forEach((p, i) => rows.push(profileToRow(p, i, amap[p.username])));

    const range = `'${stored.sheetName}'!A1`;
    await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${stored.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }),
      }
    );

    const clearRange = `'${stored.sheetName}'!A${rows.length + 1}:L1000`;
    await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${stored.spreadsheetId}/values/${encodeURIComponent(clearRange)}:clear`,
      { method: "POST", body: JSON.stringify({}) }
    ).catch(() => {});

    return stored.spreadsheetId;
  }

  async function connect(urlOrId) {
    await getToken(true);

    if (urlOrId) {
      const spreadsheetId = extractSheetId(urlOrId);
      if (!spreadsheetId) throw new Error("Invalid spreadsheet URL or ID");
      const gid = extractGid(urlOrId);
      const sheetName = await resolveSheetName(spreadsheetId, gid);
      await saveConfig(spreadsheetId, sheetName);
      return spreadsheetId;
    }

    const stored = await getStored();
    if (stored.spreadsheetId) return stored.spreadsheetId;

    const created = await createSpreadsheet();
    return created.spreadsheetId;
  }

  async function isConnected() {
    try {
      const token = await getToken(false);
      const stored = await getStored();
      return !!(token && stored.spreadsheetId);
    } catch {
      return false;
    }
  }

  async function getSpreadsheetId() {
    const stored = await getStored();
    return stored.spreadsheetId;
  }

  function getSheetUrl(sheetId) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}`;
  }

  async function disconnect() {
    if (cachedToken) {
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: cachedToken }, r));
      cachedToken = null;
    }
    await new Promise((r) => chrome.storage.local.remove([STORAGE_KEY, STORAGE_SHEET_NAME], r));
  }

  // ── PER-STAFF BACKUP (#57) ────────────────────────────────────────
  // A SEPARATE spreadsheet per staff member — the only unit that is safe to
  // share, since a Sheet link exposes the whole file. Never writes to, and
  // never reads, the owner's master-sheet config.

  function staffProfileToRow(profile, index) {
    const qas = sqPairs(profile.securityQuestions);
    const qa1 = qas[0] ? qas[0][0] + ": " + qas[0][1] : "";
    const qa2 = qas[1] ? qas[1][0] + ": " + qas[1][1] : "";
    const qa3 = qas[2] ? qas[2][0] + ": " + qas[2][1] : "";
    const locations = (profile.locations || []).join(", ");
    const dates = (profile.startDate && profile.endDate)
      ? profile.startDate + " to " + profile.endDate
      : (profile.startDate || profile.endDate || "");
    return [
      index + 1,
      profile.username || "",
      profile.password || "",
      dates,
      locations,
      qa1, qa2, qa3,
      profile.applicantCount || 1,
      profile.visaType || "",   // no price
    ];
  }

  async function createStaffSpreadsheet(staffName) {
    const data = await api("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: `SlotHunter — ${staffName} clients` },
        sheets: [{
          properties: { title: "Clients" },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{
              values: STAFF_HEADERS.map((h) => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: { textFormat: { bold: true } },
              })),
            }],
          }],
        }],
      }),
    });
    return data.spreadsheetId;
  }

  // profiles = ONLY this staff member's assigned clients (owner filters before
  // calling). Reuses the same spreadsheet on re-export so a shared link stays
  // valid and just refreshes.
  async function exportStaffBackup(staffId, staffName, profiles) {
    await getToken(true);
    const key = `__sheets_staff_${staffId}`;
    const stored = await new Promise((r) => chrome.storage.local.get([key], (d) => r(d[key] || null)));

    let spreadsheetId = stored;
    // Verify a stored sheet still exists; if it was deleted, make a new one.
    if (spreadsheetId) {
      try {
        await api(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId`);
      } catch {
        spreadsheetId = null;
      }
    }
    if (!spreadsheetId) {
      spreadsheetId = await createStaffSpreadsheet(staffName);
      await new Promise((r) => chrome.storage.local.set({ [key]: spreadsheetId }, r));
    }

    const rows = [STAFF_HEADERS];
    profiles.forEach((p, i) => rows.push(staffProfileToRow(p, i)));

    const range = `'Clients'!A1`;
    await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) }
    );
    // Clear any leftover rows from a previous, longer export.
    const clearRange = `'Clients'!A${rows.length + 1}:J1000`;
    await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(clearRange)}:clear`,
      { method: "POST", body: JSON.stringify({}) }
    ).catch(() => {});

    return { spreadsheetId, url: getSheetUrl(spreadsheetId), count: profiles.length };
  }

  return { connect, fullSync, isConnected, getSpreadsheetId, getSheetUrl, disconnect, getToken, exportStaffBackup };
})();
