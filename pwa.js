/* Service worker + "install app" button (Android/desktop Chrome/Edge prompt; iOS shows a short guide). */
(function () {
  var deferred = null;
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function buttons() { return document.querySelectorAll("[data-install-btn]"); }
  function toggle(show) { buttons().forEach(function (b) { b.hidden = !show; }); }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; if (!standalone) toggle(true); });
  window.addEventListener("appinstalled", function () { deferred = null; toggle(false); });
  document.addEventListener("DOMContentLoaded", function () { if (ios && !standalone) toggle(true); });
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-install-btn]")) return;
    if (deferred) { deferred.prompt(); deferred = null; toggle(false); return; }
    var p = document.createElement("p");
    p.textContent = "در Safari دکمه‌ی اشتراک‌گذاری (Share) را بزن و «Add to Home Screen» را انتخاب کن تا Chatroom مثل یک برنامه نصب شود.";
    window.CRModal && window.CRModal("نصب روی صفحه اصلی", p);
  });
  if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
})();
