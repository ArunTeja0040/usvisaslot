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
