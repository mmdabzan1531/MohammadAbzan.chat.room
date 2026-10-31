(() => {
  "use strict";
  const cfg = window.CHATROOM;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const coarse = matchMedia("(pointer:coarse)").matches;
  const BASE_TITLE = "Chatroom | محمد آبزن";

  const socket = io({reconnectionDelayMax: 4000});
  const feed = $("messages"), input = $("message-input"), form = $("message-form");
  const users = {...cfg.initialUsers};
  const groups = {...cfg.initialGroups};
  const unread = {}, maxSeq = {};
  const LR_KEY = "cr:lr:" + cfg.username, LAST_KEY = "cr:group:" + cfg.username;
  let lastRead = {};
  try { lastRead = JSON.parse(localStorage.getItem(LR_KEY) || "{}"); } catch (_) {}
  const saveLR = () => { try { localStorage.setItem(LR_KEY, JSON.stringify(lastRead)); } catch (_) {} };

  let stored = ""; try { stored = localStorage.getItem(LAST_KEY) || ""; } catch (_) {}
  let activeGroup = groups[cfg.initialGroup] ? cfg.initialGroup : (groups[stored] ? stored : "general");
  let online = new Set(), msgs = [], hasMore = false, loadingOlder = false, ctx = null;
  let menuFor = null, lastTap = {}, awayCount = 0, failures = 0;
  const typers = new Map();

  const profileOf = n => users[n] || {username: n, display_name: n, avatar: "🙂", bio: ""};
  const avatarHtml = u => u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="">` : esc(u.avatar || "🙂");
  const fmtTime = iso => new Date(iso).toLocaleTimeString("fa-IR", {hour: "2-digit", minute: "2-digit"});
  const fmtDay = iso => new Date(iso).toLocaleDateString("fa-IR", {weekday: "long", day: "numeric", month: "long"});
  const dayKey = iso => new Date(iso).toDateString();

  function toast(text) {
    const t = $("toast"); t.textContent = text; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2400);
  }
  const showModal = id => $(id).classList.add("show");
  const hideModal = id => $(id).classList.remove("show");
  function sheet(title, bodyNode, actions) {
    $("sheet-title").textContent = title;
    const body = $("sheet-body"); body.innerHTML = ""; if (bodyNode) body.appendChild(bodyNode);
    const act = $("sheet-actions"); act.innerHTML = "";
    actions.forEach(a => { const b = document.createElement("button"); b.className = "key " + (a.cls || ""); b.textContent = a.label; b.onclick = () => { hideModal("sheet"); a.fn && a.fn(); }; act.appendChild(b); });
    showModal("sheet");
  }

  /* ---------- connection ---------- */
  function setConn(state) {
    const el = $("conn"); el.dataset.state = state;
    el.textContent = state === "off" ? "اتصال قطع شد؛ در حال تلاش دوباره…" : "در حال اتصال…";
  }
  socket.on("connect", () => {
    failures = 0; setConn("on");
    socket.emit("sync", {last_read: lastRead});
    socket.emit("select_group", {group_id: activeGroup});   // reload history after every (re)connect
  });
  socket.on("disconnect", () => setConn("off"));
  socket.on("connect_error", async () => {
    setConn("off"); failures++;
    if (failures === 3) { try { const r = await fetch("/api/me"); if (r.status === 401) location.href = "/"; } catch (_) {} }
  });
  socket.io.on("reconnect_attempt", () => setConn("connecting"));

  /* ---------- rendering ---------- */
  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
  const toBottom = smooth => feed.scrollTo({top: feed.scrollHeight, behavior: smooth ? "smooth" : "auto"});
  function keepScroll(fn) { const nb = nearBottom(), st = feed.scrollTop; fn(); if (nb) toBottom(); else feed.scrollTop = st; }

  function buildMessage(m, cont) {
    const mine = m.username === cfg.username, u = profileOf(m.username);
    const row = document.createElement("article");
    row.className = "msg" + (mine ? " mine" : "") + (cont ? " cont" : "") + (m.pending ? " pending" : "");
    row.dataset.id = m.id;
    const av = {avatar: m.avatar || u.avatar, avatar_url: m.avatar_url || u.avatar_url};
    const quote = m.reply_to ? `<button type="button" class="quote" data-goto="${esc(m.reply_to)}"><b>${esc(m.reply_name || "")}</b><span>${m.reply_gone ? "پیام حذف شده" : esc(m.reply_text)}</span></button>` : "";
    const fwd = m.forwarded_from ? `<div class="fwd">فوروارد از ${esc(m.forwarded_from)}</div>` : "";
    row.innerHTML = `<button type="button" class="avatar" data-profile="${esc(m.username)}" aria-label="پروفایل">${avatarHtml(av)}</button><div class="bubble" tabindex="0"><div class="who">${esc(m.display_name || u.display_name || m.username)}</div>${fwd}${quote}<div class="txt"></div><div class="foot"><span>${m.pending ? "در حال ارسال…" : (m.edited ? "ویرایش‌شده" : "")}</span><time>${fmtTime(m.created_at)}</time></div></div>`;
    row.querySelector(".txt").textContent = m.text;
    return row;
  }
  function appendOne(m, prev) {
    const sameDay = prev && dayKey(prev.created_at) === dayKey(m.created_at);
    if (!sameDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = fmtDay(m.created_at); feed.appendChild(d); }
    const cont = sameDay && prev.username === m.username && !m.forwarded_from && (new Date(m.created_at) - new Date(prev.created_at)) < 300000;
    feed.appendChild(buildMessage(m, cont));
  }
  function renderAll() {
    feed.innerHTML = "";
    if (!msgs.length) {
      const g = groups[activeGroup] || {name: "گروه"};
      feed.innerHTML = `<div class="empty"><svg class="mark"><use href="#star"/></svg><h3>${esc(g.name)}</h3><p>هنوز پیامی نیست. اولین پیام را تو بفرست.</p></div>`;
      return;
    }
    let prev = null; msgs.forEach(m => { appendOne(m, prev); prev = m; });
  }
  const setMax = list => list.forEach(m => { if (m.seq) maxSeq[m.group_id] = Math.max(maxSeq[m.group_id] || 0, m.seq); });

  function markRead() {
    if (document.hidden) return;
    if (maxSeq[activeGroup] && lastRead[activeGroup] !== maxSeq[activeGroup]) { lastRead[activeGroup] = maxSeq[activeGroup]; saveLR(); }
    if (unread[activeGroup]) { unread[activeGroup] = 0; renderGroupList(); }
    updateTitle();
  }
  function updateTitle() {
    const n = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = (n ? `(${n.toLocaleString("fa-IR")}) ` : "") + BASE_TITLE;
  }
  document.addEventListener("visibilitychange", markRead);

  /* ---------- groups / members ---------- */
  function renderGroupList() {
    const list = $("group-list"); list.innerHTML = "";
    Object.entries(groups).forEach(([id, g]) => {
      const b = document.createElement("button");
      b.className = "group-item" + (id === activeGroup ? " active" : ""); b.dataset.groupId = id;
      const n = unread[id] || 0;
      b.innerHTML = `<span class="group-tile">${esc([...(g.name || "گ")][0])}</span><span class="group-text"><strong>${esc(g.name)}</strong><small>${esc(g.description || "گفت‌وگوی گروهی")}</small></span>${n ? `<span class="badge">${n > 99 ? "۹۹+" : n.toLocaleString("fa-IR")}</span>` : ""}`;
      b.addEventListener("click", () => selectGroup(id));
      list.appendChild(b);
    });
  }
  function renderMembers() {
    const g = groups[activeGroup], list = $("members-list"); list.innerHTML = "";
    const names = [...(g ? g.members : [])].sort((a, b) => (online.has(b) - online.has(a)) || a.localeCompare(b));
    names.forEach(name => {
      const u = profileOf(name), row = document.createElement("button");
      row.className = "member"; row.type = "button";
      row.innerHTML = `<span class="avatar">${avatarHtml(u)}</span><span class="member-info"><strong>${esc(u.display_name || name)}</strong><span>@${esc(name)}</span></span><i class="dot ${online.has(name) ? "on" : ""}"></i>`;
      row.addEventListener("click", () => openUserProfile(name));
      list.appendChild(row);
    });
    $("member-count").textContent = names.length.toLocaleString("fa-IR");
    $("online-count").textContent = names.filter(n => online.has(n)).length.toLocaleString("fa-IR");
  }
  function updateHeader() {
    const g = groups[activeGroup] || {};
    $("group-name-head").textContent = g.name || "گروه";
    $("group-description").textContent = g.description || "گفت‌وگوی گروهی";
    $("edit-group-name").value = g.name || ""; $("edit-group-description").value = g.description || "";
  }
  function selectGroup(id) {
    if (!groups[id]) return;
    activeGroup = id; msgs = []; hasMore = false; clearCtx(); closeMenu(); typers.clear(); renderTyping();
    try { localStorage.setItem(LAST_KEY, id); } catch (_) {}
    history.replaceState(null, "", "?group=" + encodeURIComponent(id));
    feed.innerHTML = `<div class="empty"><p>در حال بارگذاری…</p></div>`;
    updateHeader(); renderGroupList(); renderMembers();
    socket.emit("select_group", {group_id: id});
    $("sidebar").classList.remove("open"); $("people").classList.remove("open");
  }

  /* ---------- socket events ---------- */
  socket.on("group_history", d => {
    if (d.group) groups[d.group_id] = d.group;
    if (d.group_id !== activeGroup) return;
    const pend = msgs.filter(x => x.pending && x.group_id === d.group_id);
    msgs = d.messages.concat(pend); hasMore = d.has_more; setMax(d.messages);
    renderAll(); toBottom(); updateHeader(); renderMembers(); renderGroupList(); markRead();
  });
  socket.on("older_messages", d => {
    loadingOlder = false;
    if (d.group_id !== activeGroup) return;
    const h = feed.scrollHeight; msgs = d.messages.concat(msgs); hasMore = d.has_more;
    renderAll(); feed.scrollTop = feed.scrollHeight - h;
  });
  socket.on("unread", d => { Object.entries(d.counts || {}).forEach(([g, n]) => { if (g !== activeGroup) unread[g] = n; }); renderGroupList(); updateTitle(); });
  socket.on("new_message", m => {
    setMax([m]);
    if (m.group_id !== activeGroup) {
      if (m.username !== cfg.username) { unread[m.group_id] = (unread[m.group_id] || 0) + 1; renderGroupList(); updateTitle(); }
      return;
    }
    const i = m.cid ? msgs.findIndex(x => x.pending && x.cid === m.cid) : -1;
    if (i >= 0) { msgs[i] = m; keepScroll(renderAll); }
    else if (!msgs.some(x => x.id === m.id)) {
      const stick = nearBottom() || m.username === cfg.username, prev = msgs[msgs.length - 1];
      if (!msgs.length) feed.innerHTML = "";
      msgs.push(m); appendOne(m, prev);
      if (stick) toBottom(true); else { awayCount++; syncJump(); }
    }
    typers.delete(m.username); renderTyping();
    if (document.hidden && m.username !== cfg.username) { unread[m.group_id] = (unread[m.group_id] || 0) + 1; updateTitle(); } else markRead();
  });
  socket.on("message_updated", m => {
    const i = msgs.findIndex(x => x.id === m.id); if (i < 0) return;
    msgs[i] = m; keepScroll(renderAll);
  });
  socket.on("message_deleted", d => {
    if (d.group_id !== activeGroup) return;
    msgs = msgs.filter(x => x.id !== d.id); closeMenu(); keepScroll(renderAll);
  });
  socket.on("action_error", d => toast(d.error || "عملیات انجام نشد."));
  socket.on("presence", d => { online = new Set(d.online || []); renderMembers(); });
  socket.on("groups_snapshot", d => { Object.assign(groups, d.groups || {}); renderGroupList(); updateHeader(); renderMembers(); });
  socket.on("group_updated", d => {
    if (!d || !d.group) return; groups[d.id] = d.group; renderGroupList();
    if (d.id === activeGroup) { updateHeader(); renderMembers(); }
  });
  socket.on("profile_updated", u => {
    users[u.username] = u;
    if (u.username === cfg.username) { $("my-avatar").innerHTML = avatarHtml(u); $("my-display").textContent = u.display_name; }
    msgs.forEach(m => { if (m.username === u.username) Object.assign(m, {display_name: u.display_name, avatar: u.avatar, avatar_url: u.avatar_url}); });
    keepScroll(renderAll); renderMembers();
  });
  socket.on("typing", d => {
    if (d.group_id !== activeGroup || d.username === cfg.username) return;
    clearTimeout(typers.get(d.username)); typers.delete(d.username);
    if (d.typing) typers.set(d.username, setTimeout(() => { typers.delete(d.username); renderTyping(); }, 5000));
    renderTyping();
  });
  function renderTyping() {
    const names = [...typers.keys()].map(n => profileOf(n).display_name || n), el = $("typing");
    el.textContent = !names.length ? "" : names.length > 2 ? "چند نفر در حال نوشتن‌اند…" : names.join(" و ") + " در حال نوشتن…";
    el.classList.toggle("on", names.length > 0);
  }

  /* ---------- scroll: older history + jump button ---------- */
  function syncJump() {
    const away = !nearBottom(); $("jump").hidden = !away;
    if (!away) awayCount = 0;
    const b = $("jump-n"); b.hidden = !awayCount; b.textContent = awayCount.toLocaleString("fa-IR");
  }
  feed.addEventListener("scroll", () => {
    syncJump(); closeMenu();
    if (feed.scrollTop < 80 && hasMore && !loadingOlder && msgs.length) {
      const first = msgs.find(m => m.seq); if (!first) return;
      loadingOlder = true; setTimeout(() => { loadingOlder = false; }, 6000);
      socket.emit("load_older", {group_id: activeGroup, before: first.seq});
    }
  });
  $("jump").addEventListener("click", () => toBottom(true));

  /* ---------- composer ---------- */
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  function setCtx(kind, id, name, text) {
    ctx = {kind, id, name, text};
    $("ctx-kind").textContent = kind === "edit" ? "ویرایش پیام" : "پاسخ به " + name;
    $("ctx-text").textContent = text.slice(0, 80); $("ctx-bar").hidden = false;
  }
  function clearCtx() { if (ctx && ctx.kind === "edit") { input.value = ""; autosize(); } ctx = null; $("ctx-bar").hidden = true; }
  $("cancel-ctx").addEventListener("click", clearCtx);
  let lastTyping = 0;
  input.addEventListener("input", () => {
    autosize();
    if (input.value && Date.now() - lastTyping > 2500) { lastTyping = Date.now(); socket.emit("typing", {group_id: activeGroup, typing: true}); }
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === "Escape") clearCtx();
  });
  function burst() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = $("send-button").getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (let i = 0; i < 9; i++) {
      const s = document.createElement("i"), a = (i / 9) * Math.PI * 2 + Math.random() * .5, d = 34 + Math.random() * 32;
      s.className = "seed";
      s.style.cssText = `left:${x}px;top:${y}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 10}px;--r:${Math.random() * 200}deg`;
      document.body.appendChild(s); setTimeout(() => s.remove(), 700);
    }
  }
  form.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    if (ctx && ctx.kind === "edit") { socket.emit("edit_message", {id: ctx.id, text}); ctx = null; $("ctx-bar").hidden = true; input.value = ""; autosize(); return; }
    const cid = uid(), me = users[cfg.username] || cfg.me, reply = ctx && ctx.kind === "reply" ? ctx : null;
    const p = {id: "p-" + cid, cid, pending: true, group_id: activeGroup, username: cfg.username, display_name: me.display_name,
      avatar: me.avatar, avatar_url: me.avatar_url, text, created_at: new Date().toISOString(),
      reply_to: reply ? reply.id : "", reply_name: reply ? reply.name : "", reply_text: reply ? reply.text : ""};
    if (!msgs.length) feed.innerHTML = "";
    const prev = msgs[msgs.length - 1]; msgs.push(p); appendOne(p, prev); toBottom(true);
    // socket.io buffers this while offline and delivers it on reconnect
    socket.emit("send_message", {text, group_id: activeGroup, reply_to: p.reply_to, cid}, res => {
      if (res && !res.ok) { msgs = msgs.filter(x => x.cid !== cid); keepScroll(renderAll); toast(res.error || "پیام ارسال نشد."); }
    });
    burst(); ctx = null; $("ctx-bar").hidden = true; input.value = ""; autosize(); input.focus();
  });

  /* ---------- tap menu: tap = actions, double-tap = reply ---------- */
  const menu = $("msg-menu");
  function closeMenu() { menu.classList.remove("open"); document.querySelectorAll(".msg.picked").forEach(r => r.classList.remove("picked")); menuFor = null; }
  function openMenu(row, m) {
    closeMenu(); menuFor = m.id; row.classList.add("picked");
    const mine = m.username === cfg.username;
    menu.innerHTML = [["reply", "↩", "پاسخ"], ["copy", "⧉", "کپی"], ["forward", "➦", "فوروارد"]]
      .concat(mine ? [["edit", "✎", "ویرایش"], ["delete", "✕", "حذف"]] : [])
      .map(([a, i, l]) => `<button type="button" role="menuitem" data-act="${a}" class="${a === "delete" ? "del" : ""}"><i>${i}</i>${l}</button>`).join("");
    menu.classList.add("open");
    const r = row.querySelector(".bubble").getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    let top = r.bottom + 6; if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.min(Math.max(8, mine ? r.left : r.right - w), innerWidth - w - 8);
    menu.style.top = top + "px"; menu.style.left = left + "px";
    menu.querySelector("button").focus({preventScroll: true});
  }
  const msgOf = el => { const row = el.closest(".msg"); return row ? msgs.find(x => x.id === row.dataset.id) : null; };
  feed.addEventListener("click", e => {
    const prof = e.target.closest("[data-profile]"); if (prof) return openUserProfile(prof.dataset.profile);
    const go = e.target.closest("[data-goto]"); if (go) return gotoMsg(go.dataset.goto);
    const bubble = e.target.closest(".bubble"); if (!bubble || String(getSelection())) return;
    const m = msgOf(bubble); if (!m || m.pending) return;
    const now = Date.now();
    if (lastTap.id === m.id && now - lastTap.t < 320) { lastTap = {}; closeMenu(); return startReply(m); }
    lastTap = {id: m.id, t: now};
    menuFor === m.id ? closeMenu() : openMenu(bubble.closest(".msg"), m);
  });
  feed.addEventListener("contextmenu", e => {
    const b = e.target.closest(".bubble"), m = b && msgOf(b);
    if (m && !m.pending) { e.preventDefault(); openMenu(b.closest(".msg"), m); }
  });
  document.addEventListener("click", e => { if (menuFor && !e.target.closest(".bubble") && !e.target.closest("#msg-menu")) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenu(); document.querySelectorAll(".modal.show").forEach(m => m.classList.remove("show")); } });
  menu.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]"), m = msgs.find(x => x.id === menuFor); if (!btn || !m) return;
    closeMenu();
    ({reply: startReply, copy: copyMsg, forward: askForward, edit: startEdit, delete: askDelete})[btn.dataset.act](m);
  });
  function gotoMsg(id) {
    const row = feed.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return toast("پیام اصلی در بخش بارگذاری‌شده نیست.");
    row.scrollIntoView({block: "center", behavior: "smooth"}); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1200);
  }
  function startReply(m) { setCtx("reply", m.id, m.display_name || m.username, m.text); input.focus(); }
  function startEdit(m) { setCtx("edit", m.id, "", m.text); input.value = m.text; autosize(); input.focus(); }
  async function copyMsg(m) {
    try { await navigator.clipboard.writeText(m.text); toast("کپی شد"); }
    catch (_) { const t = document.createElement("textarea"); t.value = m.text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); toast("کپی شد"); }
  }
  function askDelete(m) { sheet("این پیام حذف شود؟", null, [{label: "نه", fn: null}, {label: "حذف", cls: "hot", fn: () => socket.emit("delete_message", {id: m.id})}]); }
  function askForward(m) {
    const others = Object.entries(groups).filter(([id]) => id !== activeGroup);
    const box = document.createElement("div");
    if (!others.length) box.textContent = "برای فوروارد باید عضو گروه دیگری هم باشی.";
    others.forEach(([id, g]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "pick";
      b.innerHTML = `<span class="group-tile">${esc([...(g.name || "گ")][0])}</span><strong>${esc(g.name)}</strong>`;
      b.onclick = () => { hideModal("sheet"); socket.emit("forward_message", {id: m.id, target_group: id}); toast("فوروارد شد"); };
      box.appendChild(b);
    });
    sheet("فوروارد به…", box, [{label: "بستن"}]);
  }

  /* ---------- modals & API calls ---------- */
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => hideModal(b.dataset.close)));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.classList.remove("show"); }));
  $("open-profile").addEventListener("click", () => showModal("profile-modal"));
  $("open-group").addEventListener("click", () => showModal("group-modal"));
  $("open-create-group").addEventListener("click", () => showModal("create-group-modal"));
  $("open-sidebar").addEventListener("click", () => $("sidebar").classList.add("open"));
  $("close-sidebar").addEventListener("click", () => $("sidebar").classList.remove("open"));
  $("open-members").addEventListener("click", () => $("people").classList.add("open"));
  $("close-members").addEventListener("click", () => $("people").classList.remove("open"));

  async function post(url, opts, statusEl, okText, modal) {
    statusEl.textContent = "در حال ذخیره…";
    try {
      const r = await fetch(url, opts), d = await r.json();
      if (!r.ok) throw new Error(d.error || "خطا");
      statusEl.textContent = okText; if (modal) setTimeout(() => hideModal(modal), 600);
      return d;
    } catch (err) { statusEl.textContent = err.message; return null; }
  }
  $("save-profile").addEventListener("click", async () => {
    const fd = new FormData();
    fd.append("avatar", $("profile-avatar").value); fd.append("display_name", $("profile-name").value); fd.append("bio", $("profile-bio").value);
    const photo = $("profile-photo").files[0]; if (photo) fd.append("avatar_photo", photo);
    const d = await post("/api/profile", {method: "POST", body: fd}, $("profile-status"), "پروفایل ذخیره شد.", "profile-modal");
    if (d) users[d.user.username] = d.user;
  });
  $("save-group").addEventListener("click", () => post(`/api/group/${encodeURIComponent(activeGroup)}`,
    {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: $("edit-group-name").value, description: $("edit-group-description").value})},
    $("group-status"), "تنظیمات ذخیره شد.", "group-modal"));
  $("create-group-submit").addEventListener("click", async () => {
    const d = await post("/api/groups", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name: $("new-group-name").value, description: $("new-group-description").value})},
      $("create-group-status"), "گروه ساخته شد.", "create-group-modal");
    if (!d) return;
    groups[d.id] = d.group; $("new-group-name").value = ""; $("new-group-description").value = ""; selectGroup(d.id);
  });
  async function openUserProfile(name) {
    try {
      const r = await fetch(`/api/user/${encodeURIComponent(name)}`), d = await r.json(); if (!r.ok) throw 0;
      const u = d.user; users[u.username] = u;
      $("view-user-avatar").innerHTML = avatarHtml(u); $("view-user-name").textContent = u.display_name || u.username;
      $("view-user-id").textContent = "@" + u.username; $("view-user-bio").textContent = u.bio || "هنوز بیویی ننوشته.";
      showModal("user-view-modal");
    } catch (_) { toast("پروفایل باز نشد."); }
  }
  $("share-group").addEventListener("click", async () => {
    try {
      const r = await fetch(`/api/group/${encodeURIComponent(activeGroup)}/invite`, {method: "POST"}), d = await r.json();
      if (!r.ok) throw new Error(d.error || "ساخت لینک ناموفق بود");
      $("group-invite-url").value = d.invite_url;
      try { await navigator.clipboard.writeText(d.invite_url); toast("لینک دعوت کپی شد"); } catch (_) { showModal("group-modal"); }
    } catch (e) { toast(e.message); }
  });
  $("copy-invite").addEventListener("click", async () => {
    const el = $("group-invite-url"); if (!el.value) return;
    try { await navigator.clipboard.writeText(el.value); toast("لینک کپی شد"); } catch (_) { el.select(); document.execCommand("copy"); }
  });

  updateHeader(); renderGroupList(); renderMembers(); renderAll();
  feed.innerHTML = `<div class="empty"><p>در حال بارگذاری…</p></div>`;
})();
