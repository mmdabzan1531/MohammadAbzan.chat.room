/* Theme switching + tiny modal helper. Loaded in <head> so the theme applies before first paint. */
(function () {
  var KEY = "cr:theme";
  var THEMES = [
    {id: "yalda", name: "یلدا", sub: "بنفش شبانه", sw: ["#1A1230", "#E5385E", "#B9DE82"], bar: "#1A1230"},
    {id: "sobh", name: "صبح", sub: "روشن و خنک", sw: ["#F3EFFA", "#D12F55", "#3F7A0F"], bar: "#F3EFFA"},
    {id: "firouzeh", name: "فیروزه", sub: "سبزآبی تیره", sw: ["#0C1B22", "#0E8F83", "#C5E86C"], bar: "#0C1B22"}
  ];
  var AUTO = {id: "auto", name: "خودکار", sub: "هماهنگ با تنظیم دستگاه", sw: ["#1A1230", "#F3EFFA"]};
  var mq = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;

  function pref() { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } }
  function resolve(p) {
    if (p === "auto") return mq && mq.matches ? "sobh" : "yalda";
    return THEMES.some(function (t) { return t.id === p; }) ? p : "yalda";
  }
  function apply() {
    var id = resolve(pref());
    document.documentElement.setAttribute("data-theme", id);
    var m = document.querySelector('meta[name="theme-color"]');
    THEMES.forEach(function (t) { if (t.id === id && m) m.setAttribute("content", t.bar); });
  }
  function set(p) { try { localStorage.setItem(KEY, p); } catch (e) {} apply(); }
  apply();
  if (mq) (mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply));

  function modal(title, node) {
    var el = document.getElementById("cr-modal");
    if (!el) {
      el = document.createElement("div"); el.className = "modal"; el.id = "cr-modal";
      el.innerHTML = '<section class="card"><h2></h2><div class="cr-body"></div><div class="actions"><button type="button" class="key">بستن</button></div></section>';
      document.body.appendChild(el);
      el.addEventListener("click", function (e) { if (e.target === el || e.target.closest(".actions .key")) el.classList.remove("show"); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") el.classList.remove("show"); });
    }
    el.querySelector("h2").textContent = title;
    var body = el.querySelector(".cr-body"); body.innerHTML = ""; body.appendChild(node);
    el.classList.add("show");
  }

  function openPicker() {
    var box = document.createElement("div");
    [AUTO].concat(THEMES).forEach(function (o) {
      var b = document.createElement("button"); b.type = "button";
      b.className = "pick theme-opt" + (pref() === o.id ? " on" : "");
      b.innerHTML = '<span class="sw">' + o.sw.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("") +
        '</span><span><strong>' + o.name + '</strong><small>' + o.sub + '</small></span>';
      b.onclick = function () {
        set(o.id);
        box.querySelectorAll(".theme-opt").forEach(function (x) { x.classList.toggle("on", x === b); });
      };
      box.appendChild(b);
    });
    modal("تم برنامه", box);
  }
  document.addEventListener("click", function (e) { if (e.target.closest("[data-theme-btn]")) openPicker(); });
  window.CRTheme = {set: set, get: pref, openPicker: openPicker, themes: THEMES};
  window.CRModal = modal;
})();
