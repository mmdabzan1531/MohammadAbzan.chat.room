import json, os, re, uuid, secrets, threading, random, sqlite3
from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timezone
from functools import wraps
import time
import socket as pysocket
from flask import (Flask, render_template, request, redirect, url_for, session,
                   flash, jsonify, send_from_directory)
from flask_socketio import SocketIO, emit, join_room
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("CHATROOM_DATA_DIR", os.path.join(BASE_DIR, "data"))
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
USERS_FILE = os.path.join(DATA_DIR, "users.json")
GROUPS_FILE = os.path.join(DATA_DIR, "groups.json")
DB_FILE = os.path.join(DATA_DIR, "chat.db")
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_IMAGE_SIZE = 4 * 1024 * 1024
PAGE = 60


def load_secret():
    """Keep sessions valid across restarts even when CHATROOM_SECRET is not set."""
    env = os.environ.get("CHATROOM_SECRET")
    if env:
        return env
    path = os.path.join(DATA_DIR, ".secret")
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        value = secrets.token_hex(32)
        with open(path, "w") as f:
            f.write(value)
        return value


app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(
    SECRET_KEY=load_secret(),
    MAX_CONTENT_LENGTH=MAX_IMAGE_SIZE + 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER_EXTERNAL_HOSTNAME")),
    PERMANENT_SESSION_LIFETIME=60 * 24 * 3600,  # stay signed in for 60 days
)
app.jinja_env.globals["ASSET_V"] = str(int(time.time()))

# BUG FIX: `cors_allowed_origins=[]` rejected every browser connection, which is
# why the chat never went online. None = same-origin only; set CHATROOM_CORS="*"
# (or a comma separated list) if you serve the page from another domain.
_cors = os.environ.get("CHATROOM_CORS")
socketio = SocketIO(
    app, async_mode="threading", ping_interval=20, ping_timeout=30,
    cors_allowed_origins=(_cors if _cors == "*" else _cors.split(",")) if _cors else None,
)

data_lock = threading.RLock()
online_sids = {}
recent_sends = defaultdict(deque)


# ---------- JSON store (users, groups) ----------
def write_json(path, value):
    with data_lock:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)


def read_json(path, default):
    with data_lock:
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            write_json(path, default)
            return default


# ---------- SQLite store (messages: permanent history) ----------
def db():
    c = sqlite3.connect(DB_FILE, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def q(sql, args=(), one=False, commit=False):
    with closing(db()) as c:
        rows = c.execute(sql, args).fetchall()
        if commit:
            c.commit()
        return (rows[0] if rows else None) if one else rows


SELECT_MSG = ("SELECT m.*, p.text AS reply_text, p.username AS reply_user "
              "FROM messages m LEFT JOIN messages p ON p.id = m.reply_to ")


def init_db():
    with closing(db()) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("""CREATE TABLE IF NOT EXISTS messages(
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            group_id TEXT NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL,
            created_at TEXT NOT NULL, reply_to TEXT DEFAULT '',
            edited INTEGER DEFAULT 0, forwarded_from TEXT DEFAULT '')""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_group_seq ON messages(group_id, seq)")
        c.commit()
    old = os.path.join(DATA_DIR, "messages.json")  # one-time import of old history
    if os.path.exists(old) and q("SELECT COUNT(*) c FROM messages", one=True)["c"] == 0:
        try:
            with open(old, encoding="utf-8") as f:
                items = json.load(f)
            with closing(db()) as c:
                for m in items:
                    c.execute("INSERT OR IGNORE INTO messages(id,group_id,username,text,created_at,reply_to,edited,forwarded_from) VALUES(?,?,?,?,?,?,?,?)",
                              (m.get("id") or uuid.uuid4().hex, m.get("group_id", "general"), m.get("username", ""),
                               m.get("text", ""), m.get("created_at") or datetime.now(timezone.utc).isoformat(),
                               m.get("reply_to", ""), int(bool(m.get("edited"))), m.get("forwarded_from", "")))
                c.commit()
            os.replace(old, old + ".migrated")
        except Exception as e:  # never block startup
            print("message migration skipped:", e)


def init_data():
    if not os.path.exists(USERS_FILE):
        write_json(USERS_FILE, {})
    groups = read_json(GROUPS_FILE, {})
    groups.setdefault("general", {"name": "گپ عمومی", "description": "به Chatroom خوش آمدید!", "members": []})
    for gid, g in groups.items():
        g.setdefault("members", [])
        g.setdefault("owner", "system" if gid == "general" else "")
        g.setdefault("invite_code", secrets.token_urlsafe(12))
    write_json(GROUPS_FILE, groups)
    init_db()


init_data()


def shape(r, users):
    u = users.get(r["username"], {})
    ru = users.get(r["reply_user"] or "", {})
    return {
        "id": r["id"], "seq": r["seq"], "group_id": r["group_id"], "username": r["username"],
        "display_name": u.get("display_name", r["username"]), "avatar": u.get("avatar", "🙂"),
        "avatar_url": u.get("avatar_url", ""), "text": r["text"], "created_at": r["created_at"],
        "edited": bool(r["edited"]), "forwarded_from": r["forwarded_from"] or "",
        "reply_to": r["reply_to"] or "",
        "reply_text": (r["reply_text"] or "")[:120],
        "reply_name": ru.get("display_name", r["reply_user"] or ""),
        "reply_gone": bool(r["reply_to"]) and r["reply_text"] is None,
    }


def fetch_page(gid, before=None, limit=PAGE):
    sql = SELECT_MSG + "WHERE m.group_id=? " + ("AND m.seq<? " if before else "") + "ORDER BY m.seq DESC LIMIT ?"
    rows = q(sql, (gid, before, limit + 1) if before else (gid, limit + 1))
    more = len(rows) > limit
    users = read_json(USERS_FILE, {})
    return [shape(r, users) for r in reversed(rows[:limit])], more


def fetch_one(mid):
    r = q(SELECT_MSG + "WHERE m.id=?", (mid,), one=True)
    return (r, shape(r, read_json(USERS_FILE, {}))) if r else (None, None)


def insert_message(gid, username, text, reply_to="", forwarded_from=""):
    mid = uuid.uuid4().hex
    q("INSERT INTO messages(id,group_id,username,text,created_at,reply_to,forwarded_from) VALUES(?,?,?,?,?,?,?)",
      (mid, gid, username, text, datetime.now(timezone.utc).isoformat(), reply_to, forwarded_from), commit=True)
    return fetch_one(mid)[1]


# ---------- helpers ----------
def logged_in(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if "username" not in session:
            return redirect(url_for("index"))
        return fn(*a, **kw)
    return wrap


def safe_user_public(u):
    return {k: u.get(k, d) for k, d in {"username": "", "display_name": u.get("username", ""), "bio": "", "avatar": "🙂", "avatar_url": ""}.items()}


def get_public_users():
    return {n: safe_user_public(u) for n, u in read_json(USERS_FILE, {}).items()}


def is_member(group, username):
    return username in group.get("members", [])


def public_group(g):
    return {"name": g.get("name", "گروه"), "description": g.get("description", ""),
            "members": g.get("members", []), "owner": g.get("owner", "")}


def my_groups(username):
    return {gid: public_group(g) for gid, g in read_json(GROUPS_FILE, {}).items() if is_member(g, username)}


def online_names():
    return sorted(set(online_sids.values()))


def broadcast_presence():
    socketio.emit("presence", {"online": online_names()})


def ensure_general(username):
    with data_lock:
        groups = read_json(GROUPS_FILE, {})
        g = groups.setdefault("general", {"name": "گپ عمومی", "description": "به Chatroom خوش آمدید!", "members": [], "owner": "system", "invite_code": secrets.token_urlsafe(9)})
        if username not in g.setdefault("members", []):
            g["members"].append(username)
            write_json(GROUPS_FILE, groups)
            socketio.emit("group_updated", {"id": "general", "group": public_group(g)}, to="general")


def start_session(username):
    pending = session.get("pending_invite")
    session.clear()
    session["username"] = username
    session.permanent = True
    ensure_general(username)
    return redirect(url_for("join_invite", invite_code=pending)) if pending else redirect(url_for("chat"))


# ---------- pages ----------
@app.route("/healthz")
def healthz():
    return jsonify(status="ok"), 200


@app.route("/manifest.webmanifest")
def manifest():
    icon = lambda f, sz, purpose="any": {"src": "/static/icons/" + f, "sizes": sz, "type": "image/png", "purpose": purpose}
    return jsonify({
        "name": "Chatroom | محمد آبزن", "short_name": "Chatroom", "lang": "fa", "dir": "rtl",
        "start_url": "/chat", "scope": "/", "display": "standalone",
        "background_color": "#1A1230", "theme_color": "#1A1230",
        "icons": [icon("icon-192.png", "192x192"), icon("icon-512.png", "512x512"),
                  icon("maskable-512.png", "512x512", "maskable")],
    }), 200, {"Content-Type": "application/manifest+json"}


@app.route("/sw.js")
def service_worker():
    resp = app.response_class(render_template("sw.js"), mimetype="application/javascript")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/offline")
def offline():
    return ('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>آفلاین</title><body style="font-family:system-ui;background:#1A1230;color:#F5EDF8;display:grid;place-items:center;height:100vh;margin:0;text-align:center">'
            '<div><h1>اتصال برقرار نیست</h1><p>اینترنتت را بررسی کن؛ پیام‌هایت امن هستند و بعد از وصل شدن برمی‌گردند.</p>'
            '<button onclick="location.reload()" style="padding:10px 22px;border-radius:12px;border:0;background:#E5385E;color:#fff;font:inherit">تلاش دوباره</button></div>')


@app.route("/favicon.ico")
def favicon():
    return redirect("/static/icons/icon-192.png")


@app.route("/media/<path:filename>")
def media(filename):
    return send_from_directory(UPLOAD_DIR, filename, max_age=30 * 24 * 3600)


@app.route("/api/me")
def me():
    return (jsonify(ok=True, username=session["username"]), 200) if "username" in session else (jsonify(ok=False), 401)


@app.route("/", methods=["GET", "POST"])
def index():
    if "username" in session:
        return redirect(url_for("chat"))
    if request.method == "GET":
        a, b = random.randint(2, 9), random.randint(2, 9)
        session["captcha_answer"] = str(a + b)
        return render_template("index.html", captcha_question=f"{a} + {b} = ؟")
    action = request.form.get("action", "login")
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    if request.form.get("captcha", "").strip() != session.get("captcha_answer"):
        flash("تأیید ربات ناموفق بود؛ حاصل جمع را درست وارد کن.", "error")
        return redirect(url_for("index", mode=action))
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username):
        flash("شناسه باید ۳ تا ۲۰ حرف انگلیسی، عدد یا زیرخط باشد.", "error")
        return redirect(url_for("index", mode=action))
    if len(password) < 8:
        flash("رمز عبور باید حداقل ۸ کاراکتر باشد.", "error")
        return redirect(url_for("index", mode=action))
    with data_lock:
        users = read_json(USERS_FILE, {})
        if action == "signup":
            if username in users:
                flash("این شناسه قبلاً ثبت شده است.", "error")
                return redirect(url_for("index", mode="signup"))
            users[username] = {"username": username, "password_hash": generate_password_hash(password),
                               "display_name": username, "bio": "", "avatar": "🙂", "avatar_url": ""}
            write_json(USERS_FILE, users)
            return start_session(username)
    user = users.get(username)
    if not user or not check_password_hash(user.get("password_hash", ""), password):
        flash("شناسه یا رمز عبور اشتباه است.", "error")
        return redirect(url_for("index", mode="login"))
    return start_session(username)


@app.route("/chat")
@logged_in
def chat():
    username = session["username"]
    users = read_json(USERS_FILE, {})
    if username not in users:
        session.clear()
        return redirect(url_for("index"))
    ensure_general(username)
    session.permanent = True
    return render_template("chat.html", current_user=safe_user_public(users[username]),
                           groups=my_groups(username), users=get_public_users())


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/join/<invite_code>")
def join_invite(invite_code):
    if "username" not in session:
        session["pending_invite"] = invite_code
        return redirect(url_for("index", mode="login"))
    session.pop("pending_invite", None)
    username = session["username"]
    with data_lock:
        groups = read_json(GROUPS_FILE, {})
        match = next(((gid, g) for gid, g in groups.items()
                      if secrets.compare_digest(str(g.get("invite_code", "")), str(invite_code))), None)
        if not match:
            flash("لینک دعوت معتبر نیست یا منقضی شده است.", "error")
            return redirect(url_for("chat"))
        gid, g = match
        if username not in g.setdefault("members", []):
            g["members"].append(username)
            write_json(GROUPS_FILE, groups)
            socketio.emit("group_updated", {"id": gid, "group": public_group(g)}, to=gid)
            socketio.emit("groups_snapshot", {"groups": my_groups(username)}, to="user:" + username)
    flash("با موفقیت به گروه پیوستی.", "success")
    return redirect(url_for("chat") + "?group=" + gid)


@app.route("/api/profile", methods=["POST"])
@logged_in
def update_profile():
    display_name = str(request.form.get("display_name", "")).strip()[:32]
    bio = str(request.form.get("bio", "")).strip()[:160]
    avatar = str(request.form.get("avatar", "🙂")).strip()[:12]
    if not display_name:
        return jsonify(error="نام نمایشی نمی‌تواند خالی باشد."), 400
    username = session["username"]
    with data_lock:
        users = read_json(USERS_FILE, {})
        if username not in users:
            return jsonify(error="کاربر پیدا نشد."), 404
        photo = request.files.get("avatar_photo")
        if photo and photo.filename:
            ext = os.path.splitext(secure_filename(photo.filename))[1].lower()
            if ext not in ALLOWED_IMAGE_EXTENSIONS:
                return jsonify(error="فرمت عکس پشتیبانی نمی‌شود."), 400
            photo.stream.seek(0, os.SEEK_END)
            size = photo.stream.tell()
            photo.stream.seek(0)
            if size > MAX_IMAGE_SIZE:
                return jsonify(error="حجم عکس باید کمتر از ۴ مگابایت باشد."), 400
            filename = f"{uuid.uuid4().hex}{ext}"
            photo.save(os.path.join(UPLOAD_DIR, filename))
            users[username]["avatar_url"] = "/media/" + filename
        users[username].update(display_name=display_name, bio=bio, avatar=avatar)
        users[username].setdefault("avatar_url", "")
        write_json(USERS_FILE, users)
        pub = safe_user_public(users[username])
    socketio.emit("profile_updated", pub)
    return jsonify(ok=True, user=pub)


@app.route("/api/groups", methods=["POST"])
@logged_in
def create_group():
    p = request.get_json(silent=True) or {}
    name = str(p.get("name", "")).strip()[:40]
    desc = str(p.get("description", "")).strip()[:180]
    if not name:
        return jsonify(error="نام گروه را وارد کن."), 400
    username = session["username"]
    with data_lock:
        groups = read_json(GROUPS_FILE, {})
        gid = uuid.uuid4().hex[:12]
        groups[gid] = {"name": name, "description": desc, "members": [username], "owner": username,
                       "invite_code": secrets.token_urlsafe(12)}
        write_json(GROUPS_FILE, groups)
    socketio.emit("groups_snapshot", {"groups": my_groups(username)}, to="user:" + username)
    return jsonify(ok=True, id=gid, group=public_group(groups[gid]))


@app.route("/api/group/<group_id>", methods=["POST"])
@logged_in
def update_group(group_id):
    p = request.get_json(silent=True) or {}
    username = session["username"]
    with data_lock:
        groups = read_json(GROUPS_FILE, {})
        g = groups.get(group_id)
        if not g or not is_member(g, username):
            return jsonify(error="گروه پیدا نشد یا عضو آن نیستی."), 404
        if g.get("owner") not in ("system", username):
            return jsonify(error="فقط سازنده گروه می‌تواند تنظیمات را تغییر دهد."), 403
        name = str(p.get("name", "")).strip()[:40]
        desc = str(p.get("description", "")).strip()[:180]
        if not name:
            return jsonify(error="نام گروه نمی‌تواند خالی باشد."), 400
        g.update(name=name, description=desc)
        write_json(GROUPS_FILE, groups)
    socketio.emit("group_updated", {"id": group_id, "group": public_group(g)}, to=group_id)
    return jsonify(ok=True, group=public_group(g))


@app.route("/api/group/<group_id>/invite", methods=["POST"])
@logged_in
def invite_link(group_id):
    with data_lock:
        groups = read_json(GROUPS_FILE, {})
        g = groups.get(group_id)
        if not g or not is_member(g, session["username"]):
            return jsonify(error="به این گروه دسترسی نداری."), 403
        if not g.get("invite_code"):
            g["invite_code"] = secrets.token_urlsafe(12)
            write_json(GROUPS_FILE, groups)
    return jsonify(ok=True, invite_url=request.url_root.rstrip("/") + "/join/" + g["invite_code"])


@app.route("/api/user/<username>")
@logged_in
def public_profile(username):
    u = read_json(USERS_FILE, {}).get(username)
    if not u:
        return jsonify(error="کاربر پیدا نشد."), 404
    return jsonify(ok=True, user=safe_user_public(u))


# ---------- realtime ----------
def valid_group(username, gid):
    g = read_json(GROUPS_FILE, {}).get(gid)
    return g if g and is_member(g, username) else None


def allowed_to_send(sid):
    now = time.time()
    dq = recent_sends[sid]
    while dq and now - dq[0] > 10:
        dq.popleft()
    if len(dq) >= 15:
        return False
    dq.append(now)
    return True


@socketio.on("connect")
def on_connect(auth=None):
    username = session.get("username")
    if not username or username not in read_json(USERS_FILE, {}):
        return False
    online_sids[request.sid] = username
    join_room("user:" + username)
    for gid in my_groups(username):
        join_room(gid)
    emit("groups_snapshot", {"groups": my_groups(username)})
    broadcast_presence()


@socketio.on("disconnect")
def on_disconnect():
    online_sids.pop(request.sid, None)
    recent_sends.pop(request.sid, None)
    broadcast_presence()


@socketio.on("sync")
def on_sync(data):
    username = session.get("username")
    if not username:
        return
    last_read = (data or {}).get("last_read") or {}
    counts = {}
    for gid in my_groups(username):
        seq = last_read.get(gid)
        if isinstance(seq, int):
            counts[gid] = q("SELECT COUNT(*) c FROM messages WHERE group_id=? AND seq>? AND username!=?",
                            (gid, seq, username), one=True)["c"]
    emit("unread", {"counts": counts})


@socketio.on("select_group")
def on_select_group(data):
    username = session.get("username")
    gid = str((data or {}).get("group_id", "general"))
    g = valid_group(username, gid) if username else None
    if not g:
        return
    join_room(gid)
    msgs, more = fetch_page(gid)
    emit("group_history", {"group_id": gid, "messages": msgs, "has_more": more, "group": public_group(g)})


@socketio.on("load_older")
def on_load_older(data):
    username = session.get("username")
    data = data or {}
    gid = str(data.get("group_id", ""))
    before = data.get("before")
    if not username or not valid_group(username, gid) or not isinstance(before, int):
        return
    msgs, more = fetch_page(gid, before=before)
    emit("older_messages", {"group_id": gid, "messages": msgs, "has_more": more})


@socketio.on("send_message")
def on_send_message(data):
    username = session.get("username")
    data = data or {}
    gid = str(data.get("group_id", "general"))
    text = str(data.get("text", "")).strip()[:1000]
    if not username or not text or not valid_group(username, gid):
        return {"ok": False, "error": "ارسال پیام ممکن نیست."}
    if not allowed_to_send(request.sid):
        return {"ok": False, "error": "کمی آهسته‌تر؛ پیام‌ها پشت‌سرهم ارسال می‌شوند."}
    reply_to = str(data.get("reply_to", ""))[:50]
    if reply_to and not q("SELECT 1 FROM messages WHERE id=? AND group_id=?", (reply_to, gid), one=True):
        reply_to = ""
    m = insert_message(gid, username, text, reply_to=reply_to)
    m["cid"] = str(data.get("cid", ""))[:40]
    emit("new_message", m, to=gid)
    return {"ok": True, "id": m["id"]}


@socketio.on("typing")
def on_typing(data):
    username = session.get("username")
    data = data or {}
    gid = str(data.get("group_id", ""))
    if username and valid_group(username, gid):
        emit("typing", {"group_id": gid, "username": username, "typing": bool(data.get("typing", True))},
             to=gid, include_self=False)


@socketio.on("edit_message")
def on_edit_message(data):
    username = session.get("username")
    data = data or {}
    mid = str(data.get("id", ""))
    text = str(data.get("text", "")).strip()[:1000]
    if not username or not text:
        return
    row, _ = fetch_one(mid)
    if not row or row["username"] != username or not valid_group(username, row["group_id"]):
        emit("action_error", {"error": "فقط می‌توانی پیام خودت را ویرایش کنی."})
        return
    q("UPDATE messages SET text=?, edited=1 WHERE id=?", (text, mid), commit=True)
    emit("message_updated", fetch_one(mid)[1], to=row["group_id"])


@socketio.on("delete_message")
def on_delete_message(data):
    username = session.get("username")
    mid = str((data or {}).get("id", ""))
    if not username:
        return
    row, _ = fetch_one(mid)
    if not row or row["username"] != username or not valid_group(username, row["group_id"]):
        emit("action_error", {"error": "اجازه حذف این پیام را نداری."})
        return
    q("DELETE FROM messages WHERE id=?", (mid,), commit=True)
    emit("message_deleted", {"id": mid, "group_id": row["group_id"]}, to=row["group_id"])


@socketio.on("forward_message")
def on_forward_message(data):
    username = session.get("username")
    data = data or {}
    mid = str(data.get("id", ""))
    target = str(data.get("target_group", ""))
    if not username or not valid_group(username, target):
        emit("action_error", {"error": "گروه مقصد معتبر نیست یا عضو آن نیستی."})
        return
    row, shaped = fetch_one(mid)
    if not row or not valid_group(username, row["group_id"]):
        return
    m = insert_message(target, username, row["text"], forwarded_from=shaped["display_name"])
    emit("new_message", m, to=target)


def lan_ip():
    try:
        with pysocket.socket(pysocket.AF_INET, pysocket.SOCK_DGRAM) as sk:
            sk.connect(("10.255.255.255", 1))
            return sk.getsockname()[0]
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Chatroom is running\n  This device : http://127.0.0.1:{port}\n  Same Wi-Fi  : http://{lan_ip()}:{port}\n")
    socketio.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=port, debug=False, allow_unsafe_werkzeug=True)
