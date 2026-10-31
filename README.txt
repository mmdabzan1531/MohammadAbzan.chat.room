Chatroom | محمد آبزن
====================
ساختار: app.py، requirements.txt، Procfile، render.yaml، Dockerfile، docker-compose.yml،
        run.sh، run.bat، templates/ (index.html chat.html sw.js)، static/ (style.css chat.js theme.js pwa.js icons/)

اجرا روی هر پلتفرم
- ویندوز:   دابل‌کلیک روی run.bat           (Python 3.9+ لازم است)
- macOS/Linux: ./run.sh
- اندروید (Termux): pkg install python  سپس  sh run.sh
- Docker (هر سیستمی): docker compose up -d   ->  http://localhost:8000
- سرور ابری: Render با render.yaml، یا هر هاستی که Procfile / Docker را بشناسد
بعد از اجرا آدرس http://127.0.0.1:5000 و آدرس شبکه‌ی داخلی (برای گوشی روی همان Wi-Fi) چاپ می‌شود.

نصب به‌صورت برنامه (PWA)
- اندروید/دسکتاپ (Chrome/Edge): دکمه‌ی «نصب برنامه» یا منوی مرورگر -> Install app
- آیفون/آیپد: Safari -> Share -> Add to Home Screen
- نصب و آفلاین‌بودن فقط روی HTTPS (یا localhost) کار می‌کند؛ روی Render/دامنه‌ی HTTPS مشکلی نیست.

تم‌ها: دکمه‌ی ◐ بالای سایدبار (و صفحه‌ی ورود) -> خودکار / یلدا / صبح / فیروزه. انتخاب در مرورگر ذخیره می‌شود.

نکات
- پیام‌ها در chat.db (SQLite) ذخیره می‌شوند و با خروج/ورود یا ری‌استارت می‌مانند.
- ورود ۶۰ روز ماندگار است.
- روی Render دیسک دائمی لازم است (CHATROOM_DATA_DIR=/var/data).
- دامنه‌ی جدا برای صفحه: CHATROOM_CORS=https://دامنه-تو  (یا *).
