(()=>{let e=XMLHttpRequest.prototype,t=e.open,n=e.send,s=e.setRequestHeader;function r(e){e.addEventListener("load",function(){let t=e.responseText.trim(),n=e._url.match(/query-family-members/gi)?"vD":"vSC";if("vSC"===n&&(e._url.includes("schedule-days")?n="vSD":e._url.includes("schedule-entries")&&(n="vST")),t){const s=JSON.parse(t);if("vSD"===n&&e._postData!==undefined){const t=function(e){if(!e)return{};if("function"==typeof e.entries)return Object.fromEntries(e.entries());if("string"==typeof e){const t={};return e.split("&").forEach(e=>{const[n,s]=e.split("=").map(decodeURIComponent);n&&(t[n]=s)}),t}return{}}(e._postData);if(t.parameters)try{s.postId=JSON.parse(t.parameters).postId}catch(e){}}const r=new CustomEvent("vSCP",{detail:{data:s,resource:n}});dispatchEvent(r)}})}e.open=function(e,n){return this._method=e,this._url=n,this._requestHeaders={},this._startTime=(new Date).toISOString(),t.apply(this,arguments)},e.setRequestHeader=function(e,t){return this._requestHeaders[e]=t,s.apply(this,arguments)};let o={cacheString:"0",route:""};e.send=function(e){if(this._url.match(/schedule-group\/(get-family-((emergency-)?(ofc|consular)-schedule)|query-family-members)/gi)){this._postData=e;let t=function(e){const t={};return e.slice(e.indexOf("?")+1).split("&").forEach(e=>{const[n,s]=e.split("=");t[decodeURIComponent(n)]=decodeURIComponent(s)}),t}(this._url);(t.route!==o.route||t.cacheString-o.cacheString>=200)&&r(this),o=t}return n.apply(this,arguments)}})(),addEventListener("fromContent",e=>{let t=e.detail;if("selectSlotDate"===t.type){const e=document.querySelector("#datepicker");$(e).datepicker("setDate",t.slotDate),$(e).datepicker("option","onSelect").call(e,t.slotDate)}else if("selectLocation"===t.type){const e=document.querySelector("#post_select");$(e).val(t.location),$(e).trigger("change")}});

// ── TEST build: capture schedule-days request as a reusable template (parallel scan A1) ──
(function(){
  if (XMLHttpRequest.prototype.__tmplPatched) return;
  XMLHttpRequest.prototype.__tmplPatched = true;
  var oOpen = XMLHttpRequest.prototype.open;
  var oSetH = XMLHttpRequest.prototype.setRequestHeader;
  var oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__tu = u; this.__tm = m; this.__th = {}; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v){ if (this.__th) this.__th[k] = v; return oSetH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body){
    try {
      if (this.__tu && /get-family-(?:ofc|consular)-schedule-days/i.test(this.__tu)) {
        dispatchEvent(new CustomEvent("vSCPTemplate", { detail: {
          url: this.__tu, method: this.__tm || "POST", headers: this.__th || {}, body: String(body || "")
        }}));
      }
    } catch (e) {}
    return oSend.apply(this, arguments);
  };
})();
// ── #67 HTTP status detection (401 / 429) — MAIN world, CSP-immune ──
// auto-booking.js used to inject an inline <script> for this. The site's own
// pages ship a CSP with no 'unsafe-inline', so that injection was blocked and
// 401/429 detection was silently dead on the booking page — exactly where it
// matters. page.js is registered by the service worker via
// chrome.scripting.registerContentScripts (browser-level, so page CSP does not
// apply), which makes this the right home for it.
(function () {
  if (XMLHttpRequest.prototype.__abStatusPatched) return;
  XMLHttpRequest.prototype.__abStatusPatched = true;

  var oOpen = XMLHttpRequest.prototype.open;
  var oSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, u) {
    this.__abUrl = u;
    return oOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      if (this.status !== 401 && this.status !== 429) return;
      var detail = { status: this.status, url: String(this.__abUrl || "").substring(0, 200), at: Date.now() };
      if (this.status === 429) {
        // Capture which system refused us — Cloudflare edge, the platform
        // throttle, or the site's own limiter all return 429 but need
        // opposite responses.
        try {
          detail.retryAfter = this.getResponseHeader("Retry-After");
          detail.cfRay = this.getResponseHeader("CF-Ray");
          detail.msBurst = this.getResponseHeader("x-ms-ratelimit-burst-remaining-xrm-requests");
          detail.msTime = this.getResponseHeader("x-ms-ratelimit-time-remaining-xrm-requests");
          detail.ctype = this.getResponseHeader("Content-Type");
          detail.body = String(this.responseText || "").substring(0, 500);
        } catch (e) {}
      }
      try { dispatchEvent(new CustomEvent("abHttpStatus", { detail: detail })); } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
})();

// ─── #80 PORTAL FAST PATH ────────────────────────────────────────────
// The portal exposes its own scheduling functions on `window`. Calling them
// directly skips every render wait the DOM path needs: no datepicker poll, no
// hunting for a[data-date], no waiting for time radios to appear. Only the
// server round-trip is left.
//
// This must live in page.js because only the MAIN world can see these globals;
// the ISOLATED world sees a different `window`.
//
// Protocol mirrors the existing vSCP bridge:
//   in   CustomEvent "abPortalCmd"    { id, type, ...params }
//   out  CustomEvent "abPortalResult" { id, ok, data | error }
//
// Every command is best-effort. Any failure is reported rather than thrown, so
// auto-booking.js can fall back to the DOM path. Phase 1 deliberately leaves
// booking-outcome detection to the existing waitForBookingOutcome().
(function () {
  "use strict";

  var N = {
    jsdata: "jsdata",
    token: "token",                       // booking token, minted by the entries call
    sd: "sd",                             // days token, minted by the days call
    applications: "applications",
    getScheduleDays: "getScheduleDays",
    getScheduleEntries: "getScheduleEntries",
    onClickSubmit: "onClickSubmit",
  };

  // Reading an undeclared global throws; never let that escape.
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function asFn(name) { var v = g(name); return typeof v === "function" ? v : null; }

  // The portal threads call parameters through a single mutable object.
  function bag() {
    var d = g(N.jsdata);
    if (d && typeof d === "object") return d;
    var fresh = {};
    try { window[N.jsdata] = fresh; } catch (e) {}
    return fresh;
  }

  function seed(obj) {
    var b = bag();
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) b[k] = obj[k];
    }
    return b;
  }

  // The entries call only works with the token the days call just minted.
  function daysToken() {
    var s = g(N.sd);
    if (typeof s === "string" && s) return s;
    var t = g(N.token);
    return (typeof t === "string" && t) ? t : undefined;
  }

  function hasApplications() {
    var a = g(N.applications);
    if (Array.isArray(a)) return a.length > 0;
    var p = bag().primaryId;
    return typeof p === "string" && p !== "";
  }

  // "2026-10-15" or "10/15/2026" → "2026-10-15"
  function normDate(v) {
    if (typeof v !== "string" || !v) return null;
    var head = v.indexOf("T") === -1 ? v : v.slice(0, v.indexOf("T"));
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(head);
    if (!m) return null;
    var mo = Number(m[1]), da = Number(m[2]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return m[3] + "-" + String(mo).padStart(2, "0") + "-" + String(da).padStart(2, "0");
  }

  function parseDays(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      var d = (r && typeof r === "object") ? normDate(r.Date) : null;
      if (d) out.push({ date: d });
    }
    return out;
  }

  function parseEntries(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var e = raw[i];
      if (!e || typeof e !== "object") continue;
      var time = (typeof e.Time === "string" && e.Time.trim() !== "") ? e.Time : null;
      var num = Number(e.Num);
      if (time === null || !Number.isSafeInteger(num) || num <= 0 || seen[num]) continue;
      seen[num] = 1;
      // EntriesAvailable = seats left on this slot. Null when the portal omits it.
      var seats = (typeof e.EntriesAvailable === "number" && isFinite(e.EntriesAvailable))
        ? e.EntriesAvailable : null;
      out.push({ time: time, num: num, seats: seats });
    }
    return out;
  }

  function probe() {
    var days = asFn(N.getScheduleDays);
    var entries = asFn(N.getScheduleEntries);
    var submit = asFn(N.onClickSubmit);
    var missing = [];
    if (!days) missing.push(N.getScheduleDays);
    if (!entries) missing.push(N.getScheduleEntries);
    if (!submit) missing.push(N.onClickSubmit);
    return {
      available: missing.length === 0,
      missing: missing,
      hasApplications: hasApplications(),
      daysToken: daysToken() !== undefined,
    };
  }

  function reply(id, ok, payload) {
    var detail = { id: id, ok: ok };
    if (ok) detail.data = payload; else detail.error = String(payload || "failed");
    try { dispatchEvent(new CustomEvent("abPortalResult", { detail: detail })); } catch (e) {}
  }

  // The portal's callbacks fire once; guard against a late second call landing
  // on an already-settled command.
  function once(fn) {
    var done = false;
    return function () { if (done) return; done = true; try { fn.apply(null, arguments); } catch (e) {} };
  }

  addEventListener("abPortalCmd", function (ev) {
    var cmd = ev && ev.detail;
    if (!cmd || typeof cmd.id !== "string") return;
    var id = cmd.id;

    try {
      if (cmd.type === "probe") { reply(id, true, probe()); return; }

      var p = probe();
      if (!p.available) { reply(id, false, "portal functions unavailable: " + p.missing.join(",")); return; }

      if (cmd.type === "days") {
        if (!cmd.postId) { reply(id, false, "days: postId required"); return; }
        seed({ postId: cmd.postId });
        var doneDays = once(function (raw) {
          reply(id, true, { days: parseDays(raw), token: daysToken() || null });
        });
        asFn(N.getScheduleDays).call(window, doneDays);
        return;
      }

      if (cmd.type === "entries") {
        var date = normDate(cmd.date);
        if (!date) { reply(id, false, "entries: bad date"); return; }
        var tok = daysToken();
        if (tok === undefined) { reply(id, false, "entries: no days token — call days first"); return; }
        // scheduleDayId must be cleared or the portal reuses the previous day.
        seed({ scheduleDayId: null, Token: tok, Date: date + "T00:00:00" });
        var doneEntries = once(function (raw) {
          reply(id, true, { entries: parseEntries(raw), bookingToken: g(N.token) || null });
        });
        asFn(N.getScheduleEntries).call(window, doneEntries);
        return;
      }

      if (cmd.type === "submit") {
        var num = Number(cmd.num);
        if (!Number.isSafeInteger(num) || num <= 0) { reply(id, false, "submit: bad num"); return; }
        seed({ Num: num });
        asFn(N.onClickSubmit).call(window);
        // Fired, not confirmed. Outcome detection stays with waitForBookingOutcome().
        reply(id, true, { submitted: true, num: num });
        return;
      }

      reply(id, false, "unknown command: " + String(cmd.type));
    } catch (e) {
      reply(id, false, (e && e.message) || "portal call threw");
    }
  });
})();
