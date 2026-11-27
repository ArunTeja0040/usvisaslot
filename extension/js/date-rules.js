// date-rules.js — #94
//
// Date-rule parsing, shared by the booking panel (auto-booking.js, a content
// script) and the dashboard's Edit dialog (dashboard.js). One copy on purpose:
// the two surfaces must read "20-23 Dec 26" identically, and a second copy
// would drift the first time one of them was fixed.
//
// Pure parsing and formatting — no DOM, no chrome.* — so it loads safely in
// both places.
(function (root) {
  "use strict";

  // #94 The operator types these in the booking panel, so the parsing lives
  // here. Loose by design — "15 Dec 26", "20-23 Dec 26", "2026-12-15" — with
  // the understood result echoed under the field before it is saved, so a
  // format that could be misread never is.
  const AB_MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const AB_MON_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function abToISO(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    const yy = y < 100 ? 2000 + y : y;
    const dt = new Date(Date.UTC(yy, m - 1, d));
    // Rejects the 31st of a 30-day month rather than rolling it into the next.
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return yy + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function abParseOneDate(tok) {
    const t = String(tok || "").trim().replace(/\s+/g, " ");
    if (!t) return null;
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return abToISO(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{1,2})[ \/.-]([A-Za-z]{3,})[ \/.,-]*(\d{2,4})$/);
    if (m) { const mo = AB_MONTHS[m[2].slice(0, 3).toLowerCase()]; return mo ? abToISO(+m[3], mo, +m[1]) : null; }
    m = t.match(/^([A-Za-z]{3,})[ \/.-](\d{1,2})[ \/.,-]*(\d{2,4})$/);
    if (m) { const mo = AB_MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? abToISO(+m[3], mo, +m[2]) : null; }
    m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
    if (m) return abToISO(+m[3], +m[2], +m[1]);     // day first, as written here
    return null;
  }

  // The whole token is tried as one date FIRST, then every split point in turn,
  // because an ISO date contains the very "-" used as a range separator:
  // "2026-12-15" split on its first dash gives "2026" and "12-15", which reads
  // as nothing.
  function abParseDateToken(tok) {
    const t = String(tok || "").trim();
    const single = abParseOneDate(t);
    if (single) return [single];
    const seps = [];
    const re = /\s*(?:to|:|–|—|-)\s*/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
      seps.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
    for (let i = 0; i < seps.length; i++) {
      const left = t.slice(0, seps[i][0]).trim();
      const right = t.slice(seps[i][1]).trim();
      const end = abParseOneDate(right);
      if (!end) continue;
      let begin = abParseOneDate(left);
      if (!begin && /^\d{1,2}$/.test(left)) begin = abToISO(+end.slice(0, 4), +end.slice(5, 7), +left);
      if (!begin || begin > end) continue;
      const out = [];
      for (let d = new Date(begin + "T00:00:00Z"); d <= new Date(end + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
        out.push(d.toISOString().slice(0, 10));
        if (out.length > 400) break;              // a typo must not build a decade
      }
      return out;
    }
    return null;
  }

  function abParseExcluded(raw) {
    const dates = new Set(); const bad = [];
    String(raw || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean).forEach(function (tok) {
      const got = abParseDateToken(tok);
      if (got && got.length) got.forEach(function (d) { dates.add(d); });
      else bad.push(tok);
    });
    return { dates: Array.from(dates).sort(), bad: bad };
  }

  function abFmtDate(iso) {
    const d = new Date(iso + "T00:00:00Z");
    return d.getUTCDate() + " " + AB_MON_ABBR[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2);
  }


  root.ABDateRules = {
    parseExcluded: abParseExcluded,
    parseOne: abParseOneDate,
    parseToken: abParseDateToken,
    fmt: abFmtDate,
    toISO: abToISO,
  };
})(typeof window !== "undefined" ? window : globalThis);
