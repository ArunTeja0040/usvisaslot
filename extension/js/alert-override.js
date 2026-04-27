(function () {
  const origAlert = window.alert;
  window.alert = function (msg) {
    console.log("[AutoBook] Auto-dismissed alert:", msg);
    document.dispatchEvent(
      new CustomEvent("__abAlertDismissed", { detail: String(msg) })
    );
  };
})();
