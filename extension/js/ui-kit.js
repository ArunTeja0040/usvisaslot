/* ============================================================
   ui-kit.js — SlotHunter dashboard shell (issue #59, Phase 1)

   Toasts, command palette, hold-to-confirm and the background-tab
   title badge. Self-contained: no dependencies, no chrome.* calls,
   no storage writes. Exposes window.SHUI and does nothing until
   dashboard.js calls into it.

   Kill switch: set SHUI.enabled = false (or window.__SH_UI_KIT_OFF
   = true before this file loads) and every entry point becomes a
   no-op. Nothing else in the dashboard depends on it.
   ============================================================ */

(function () {
  "use strict";

  var enabled = !window.__SH_UI_KIT_OFF;

  /* HTML-escape. Profile names arrive from Supabase and are
     operator-controlled, so everything interpolated below goes
     through this — same contract as dashboard.js. */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* matchMedia missing — treat as no preference */ }

  /* ── TOASTS ───────────────────────────────────────────────
     Transitions rather than keyframes, so a burst of toasts
     retargets mid-flight instead of restarting from zero. */

  var ICONS = {
    found: '<path d="M12 2.6l2.7 5.9 6.4.8-4.7 4.4 1.2 6.3L12 16.9 6.4 20l1.2-6.3L2.9 9.3l6.4-.8z"/>',
    ok:    '<path d="M20 6L9 17l-5-5"/>',
    warn:  '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/>',
    info:  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8.2v.1"/>'
  };

  var TONE = { found: "var(--accent)", ok: "var(--ok)", warn: "var(--danger)", info: "var(--text-2)" };

  var toaster = null;

  function getToaster() {
    if (toaster && document.body.contains(toaster)) return toaster;
    toaster = document.createElement("div");
    toaster.className = "sh-toaster";
    document.body.appendChild(toaster);
    return toaster;
  }

  /* opts: { kind, title, body, duration, actionLabel, onAction } */
  function toast(opts) {
    if (!enabled) return null;
    opts = opts || {};

    var kind = ICONS[opts.kind] ? opts.kind : "info";
    var host = getToaster();
    var el = document.createElement("div");
    el.className = "sh-toast" + (kind === "found" ? " sh-found" : "");
    el.setAttribute("role", "status");

    el.innerHTML =
      '<svg class="sh-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="color:' + TONE[kind] + '" aria-hidden="true">' +
      ICONS[kind] + '</svg>' +
      '<div class="sh-body"><h5>' + esc(opts.title) + '</h5>' +
      (opts.body ? '<p>' + esc(opts.body) + '</p>' : '') +
      (opts.actionLabel ? '<div class="sh-row"><button type="button" class="btn btn-small btn-primary sh-act">' +
        esc(opts.actionLabel) + '</button></div>' : '') +
      '</div>';

    host.appendChild(el);
    /* Force a frame so the mount transition actually runs.
       data-mounted instead of @starting-style — that is Chrome 117+. */
    void el.offsetWidth;
    el.setAttribute("data-mounted", "1");

    var total = typeof opts.duration === "number" ? opts.duration : (opts.actionLabel ? 9000 : 4500);
    var left = total;
    var last = Date.now();
    var timer = null;
    var dead = false;

    function close() {
      if (dead) return;
      dead = true;
      clearTimeout(timer);
      el.classList.add("sh-out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 430);
    }

    /* The dashboard lives in a background tab for hours. A plain
       setTimeout would expire every toast unseen, so the dwell
       clock only advances while the tab is actually visible. */
    function tick() {
      timer = setTimeout(function () {
        if (document.hidden) { last = Date.now(); tick(); return; }
        left -= Date.now() - last;
        last = Date.now();
        if (left <= 0) close(); else tick();
      }, 200);
    }
    tick();

    el.addEventListener("pointerenter", function () { clearTimeout(timer); });
    el.addEventListener("pointerleave", function () { last = Date.now(); tick(); });

    var act = el.querySelector(".sh-act");
    if (act) {
      act.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (typeof opts.onAction === "function") {
          try { opts.onAction(); } catch (err) { console.warn("[SHUI] toast action failed:", err); }
        }
        close();
      });
    }

    /* Swipe to dismiss. A quick flick counts even if it did not
       travel far — matching how the gesture actually feels. */
    var startX = 0, startT = 0, dragging = false;
    el.addEventListener("pointerdown", function (ev) {
      if (dragging || ev.button !== 0) return;
      if (ev.target.closest(".sh-act")) return;
      dragging = true;
      startX = ev.clientX;
      startT = Date.now();
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      el.style.transition = "none";
    });
    el.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var d = Math.max(0, ev.clientX - startX);
      el.style.transform = "translateX(" + d + "px)";
      el.style.opacity = String(Math.max(.25, 1 - d / 260));
    });
    function endDrag(ev) {
      if (!dragging) return;
      dragging = false;
      var d = ev.clientX - startX;
      var v = Math.abs(d) / Math.max(1, Date.now() - startT);
      el.style.transition = "";
      el.style.opacity = "";
      el.style.transform = "";
      if (d > 90 || (d > 20 && v > 0.11)) {
        el.classList.add("sh-swiped");
        dead = true;
        clearTimeout(timer);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 430);
      }
    }
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    return { close: close, el: el };
  }

  /* ── BACKGROUND-TAB TITLE BADGE ───────────────────────────
     The dashboard is left open in a background tab; the tab
     title is the only alert channel that always reaches the
     operator without extra permissions. */

  var baseTitle = document.title;
  var pending = 0;

  function setBadge(n, label) {
    if (!enabled) return;
    pending = Math.max(0, n | 0);
    document.title = pending > 0
      ? "(" + pending + ") " + (label || "Slot found") + " — SlotHunter"
      : baseTitle;
  }

  function bumpBadge(label) { setBadge(pending + 1, label); }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && pending > 0) setBadge(0);
  });

  /* ── HOLD-TO-CONFIRM ──────────────────────────────────────
     Press is slow and deliberate (1100ms, matching the CSS
     fill); release is immediate. Guards destructive actions
     on a console that drives live bookings. */

  var HOLD_MS = 1100;

  function bindHold(el, onConfirm) {
    if (!enabled || !el || el.__shHoldBound) return;
    el.__shHoldBound = true;
    el.classList.add("sh-hold");

    if (!el.querySelector(".sh-fill")) {
      var fill = document.createElement("span");
      fill.className = "sh-fill";
      el.insertBefore(fill, el.firstChild);
    }

    var timer = null;

    function start(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      if (timer) return;                       /* re-entry guard */
      el.setAttribute("data-holding", "1");
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      timer = setTimeout(function () {
        timer = null;
        el.setAttribute("data-holding", "0");
        try { onConfirm(); } catch (err) { console.warn("[SHUI] hold action failed:", err); }
      }, HOLD_MS);
    }

    function stop() {
      el.setAttribute("data-holding", "0");
      if (timer) { clearTimeout(timer); timer = null; }
    }

    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("pointerleave", stop);

    /* The element now means "hold", so a plain click must do nothing —
       including reaching a delegated handler on an ancestor. Capture
       phase so it lands before any container-level listener. */
    el.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    /* Keyboard users cannot hold — Enter/Space confirm directly. */
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        try { onConfirm(); } catch (err) { console.warn("[SHUI] hold action failed:", err); }
      }
    });
  }

  /* ── COMMAND PALETTE ──────────────────────────────────────
     Deliberately has no open/close animation. It is a
     high-frequency action and motion there reads as lag. */

  var cmdRoot = null, cmdInput = null, cmdList = null;
  var cmdItems = [];      /* [{ group, label, meta, tone, keys, run }] */
  var cmdFiltered = [];
  var cmdSel = 0;
  var cmdProvider = null; /* () => items, called fresh on every open */

  var TONE_SQ = {
    found: "var(--accent)", live: "var(--live)", ok: "var(--ok)",
    error: "var(--danger)", idle: "var(--idle)", cmd: "var(--text-3)"
  };

  function buildPalette() {
    if (cmdRoot) return;
    cmdRoot = document.createElement("div");
    cmdRoot.className = "sh-cmdk";
    cmdRoot.innerHTML =
      '<div class="sh-cmdbox" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<input type="text" class="sh-cmdinput" placeholder="Search clients, run a command…" ' +
      'autocomplete="off" spellcheck="false">' +
      '<div class="sh-cmdlist" role="listbox"></div></div>';
    document.body.appendChild(cmdRoot);

    cmdInput = cmdRoot.querySelector(".sh-cmdinput");
    cmdList = cmdRoot.querySelector(".sh-cmdlist");

    cmdRoot.addEventListener("click", function (ev) { if (ev.target === cmdRoot) closePalette(); });
    cmdInput.addEventListener("input", function () { cmdSel = 0; renderPalette(); });

    cmdList.addEventListener("click", function (ev) {
      var row = ev.target.closest(".sh-cmditem");
      if (!row) return;
      runPaletteItem(parseInt(row.getAttribute("data-i"), 10));
    });
  }

  function renderPalette() {
    var q = (cmdInput.value || "").trim().toLowerCase();
    cmdFiltered = !q ? cmdItems.slice() : cmdItems.filter(function (it) {
      return ((it.label || "") + " " + (it.meta || "")).toLowerCase().indexOf(q) !== -1;
    });

    if (cmdSel >= cmdFiltered.length) cmdSel = Math.max(0, cmdFiltered.length - 1);

    if (!cmdFiltered.length) {
      cmdList.innerHTML = '<div class="sh-cmdempty">No match for "' + esc(q) + '"</div>';
      return;
    }

    var html = "", group = null;
    cmdFiltered.forEach(function (it, i) {
      if (it.group !== group) {
        group = it.group;
        html += '<div class="sh-cmdgroup">' + esc(String(group || "").toUpperCase()) + '</div>';
      }
      html +=
        '<div class="sh-cmditem" role="option" data-i="' + i + '" aria-selected="' + (i === cmdSel) + '">' +
        '<span class="sh-sq" style="background:' + (TONE_SQ[it.tone] || TONE_SQ.cmd) + '"></span>' +
        '<span>' + esc(it.label) + '</span>' +
        (it.meta ? '<span class="sh-meta">' + esc(it.meta) + '</span>' : '') +
        '<span class="sh-key">' + esc(it.keys || "↵") + '</span></div>';
    });
    cmdList.innerHTML = html;

    var active = cmdList.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function runPaletteItem(i) {
    var it = cmdFiltered[i];
    if (!it) return;
    closePalette();
    if (typeof it.run === "function") {
      try { it.run(); } catch (err) { console.warn("[SHUI] palette action failed:", err); }
    }
  }

  function openPalette() {
    if (!enabled) return;
    buildPalette();
    cmdItems = [];
    if (typeof cmdProvider === "function") {
      try { cmdItems = cmdProvider() || []; }
      catch (err) { console.warn("[SHUI] palette provider failed:", err); cmdItems = []; }
    }
    cmdRoot.setAttribute("data-open", "1");
    cmdInput.value = "";
    cmdSel = 0;
    renderPalette();
    cmdInput.focus();
  }

  function closePalette() {
    if (cmdRoot) cmdRoot.removeAttribute("data-open");
  }

  function paletteOpen() { return !!(cmdRoot && cmdRoot.getAttribute("data-open") === "1"); }

  document.addEventListener("keydown", function (ev) {
    if (!enabled) return;

    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "K")) {
      /* On macOS Ctrl-K is kill-to-end-of-line inside a text field.
         Swallowing it there would break editing a profile, so only Cmd-K
         opens the palette from within an input. */
      var t = ev.target;
      var editing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (editing && ev.ctrlKey && !ev.metaKey) return;

      ev.preventDefault();
      if (paletteOpen()) closePalette(); else openPalette();
      return;
    }

    if (!paletteOpen()) return;

    if (ev.key === "Escape") { ev.preventDefault(); closePalette(); return; }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      cmdSel = Math.min(cmdSel + 1, Math.max(0, cmdFiltered.length - 1));
      renderPalette();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      cmdSel = Math.max(0, cmdSel - 1);
      renderPalette();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      runPaletteItem(cmdSel);
    }
  });

  window.SHUI = {
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
    reduceMotion: reduceMotion,
    esc: esc,
    toast: toast,
    setBadge: setBadge,
    bumpBadge: bumpBadge,
    bindHold: bindHold,
    openPalette: openPalette,
    closePalette: closePalette,
    setPaletteProvider: function (fn) { cmdProvider = fn; }
  };
})();
