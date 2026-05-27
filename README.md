# e2e_meet — Web-Based Video Calling App

A Zoom-like video calling web app. Up to **6 participants per room** over a WebRTC
mesh (peer-to-peer, no media server), with real-time text chat alongside the call.

## Features

- User authentication (signup / login / logout)
- Create and join meeting rooms
- Live video + audio for up to 6 peers via WebRTC mesh
- In-call text chat with persisted history (last 50 messages restored on reload)
- Dark theme, vanilla-JS frontend

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Django 5.2 + Django Channels |
| ASGI server | Daphne (HTTP + WebSocket on one port) |
| Channel layer | Redis (`127.0.0.1:6379`) |
| Database | SQLite |
| Media | WebRTC mesh, peer-to-peer |
| Frontend | Vanilla JavaScript |

## Project layout

```
e2e-meet-project/
├── README.md           ← this file
├── CLAUDE.md           ← agent / contributor notes
├── PLAN.md             ← full build plan
├── PROGRESS.md         ← phase checklist
├── TECHNICAL.md        ← live architectural reference
├── project_env/        ← Python virtualenv (checked into the repo)
└── e2e_meet/           ← Django project
    ├── manage.py
    ├── e2e_meet/       ← project package (settings, asgi, urls)
    ├── accounts/       ← auth app
    ├── meetings/       ← rooms + chat + signaling app
    ├── templates/
    └── static/
```

## Prerequisites

- Python 3.11+
- Redis running locally on `127.0.0.1:6379`

```bash
# macOS (Homebrew)
brew services start redis
brew services list | grep redis   # confirm it's up
```

## Setup

```bash
# from the workspace root
python3 -m venv project_env            # create the virtualenv (first time only)
source project_env/bin/activate        # activate it

cd e2e_meet
pip install -r requirements.txt        # install dependencies
python manage.py migrate
python manage.py createsuperuser       # optional, for /admin
```

## Running

```bash
cd e2e_meet
daphne -p 8000 e2e_meet.asgi:application
```

Then open <http://localhost:8000>. To test a real call, open the same room URL
in two browser windows (or two devices on the same LAN).

> **ICE servers:** none are configured by default, so calls work on
> localhost / same-LAN. For calls across networks, add
> `stun:stun.l.google.com:19302` to `RTC_CONFIG` in
> `e2e_meet/static/js/room.js` — it's a one-line change.

## Documentation

- **PLAN.md** — the original full build plan
- **PROGRESS.md** — phase-by-phase checklist (all 8 phases complete)
- **TECHNICAL.md** — data model, routes, ASGI wiring, WebRTC plan (kept current)
- **CLAUDE.md** — conventions and resume runbook for contributors / agents
