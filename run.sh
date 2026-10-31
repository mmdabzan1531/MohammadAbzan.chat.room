#!/usr/bin/env sh
# Linux / macOS / Termux (Android)
cd "$(dirname "$0")" || exit 1
[ -d .venv ] || python3 -m venv .venv || exit 1
. .venv/bin/activate
pip install -q -r requirements.txt && python app.py
