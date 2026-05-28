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

## CentOS Stream VM setup

End-to-end install on a fresh CentOS Stream 9 VM.

### 1. System update + essentials

```bash
sudo dnf update -y
sudo dnf install -y git curl wget vim policycoreutils-python-utils
sudo dnf groupinstall -y "Development Tools"
```

### 2. Install Python 3.12 (Django 5.2 needs Python 3.10+)

```bash
sudo dnf install -y python3.12 python3.12-pip python3.12-devel
python3.12 --version
```

### 3. Install Redis (required by Django Channels)

```bash
sudo dnf install -y redis
sudo systemctl enable --now redis
redis-cli ping        # should print PONG
```

### 4. Install build dependencies (for cryptography / cffi wheels)

```bash
sudo dnf install -y gcc openssl-devel libffi-devel rust cargo
```

### 5. Clone the project

```bash
mkdir -p ~/sk_meet_work && cd ~/sk_meet_work
git clone <your-repo-url> e2e_meet
```

### 6. Create the virtualenv

```bash
cd ~/sk_meet_work
python3.12 -m venv project_env
source project_env/bin/activate
pip install --upgrade pip setuptools wheel
```

### 7. Install Python dependencies

```bash
cd ~/sk_meet_work/e2e_meet
pip install -r requirements.txt
```

### 8. Django setup

```bash
cd ~/sk_meet_work/e2e_meet
python manage.py migrate
python manage.py createsuperuser
python manage.py collectstatic --noinput
```

### 9. Open the firewall for port 8000

```bash
sudo firewall-cmd --permanent --add-port=8000/tcp
sudo firewall-cmd --reload
```

### 10. Allow SELinux to bind the port (if SELinux is enforcing)

```bash
sudo semanage port -a -t http_port_t -p tcp 8000 || \
sudo semanage port -m -t http_port_t -p tcp 8000
```

### 11. Run the server

```bash
cd ~/sk_meet_work/e2e_meet
source ../project_env/bin/activate
daphne -b 0.0.0.0 -p 8000 e2e_meet.asgi:application
```

Open `http://<vm-ip>:8000/` in a browser.

### Optional: run as a systemd service

Create `/etc/systemd/system/e2e_meet.service`:

```ini
[Unit]
Description=e2e_meet Daphne ASGI server
After=network.target redis.service
Requires=redis.service

[Service]
User=<your-user>
WorkingDirectory=/home/<your-user>/sk_meet_work/e2e_meet
Environment="PATH=/home/<your-user>/sk_meet_work/project_env/bin"
ExecStart=/home/<your-user>/sk_meet_work/project_env/bin/daphne -b 0.0.0.0 -p 8000 e2e_meet.asgi:application
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now e2e_meet
sudo journalctl -u e2e_meet -f
```

### HTTPS note (required for WebRTC outside localhost)

Browsers block `getUserMedia` (camera/mic) on non-localhost origins unless the
page is served over HTTPS. Two easy options:

- **Cloudflare Tunnel** — `CSRF_TRUSTED_ORIGINS` already allows `*.trycloudflare.com`:
  ```bash
  sudo dnf install -y https://pkg.cloudflare.com/cloudflared-stable-linux-x86_64.rpm
  cloudflared tunnel --url http://localhost:8000
  ```
- **nginx + Let's Encrypt** in front of Daphne (proxy `/` and upgrade `/ws/` to WebSocket).

