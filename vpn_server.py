"""
VPN Rotation Control Server — localhost:5124
Cross-platform (macOS + Windows). No launchd/task-scheduler dependency.
Endpoints:
  GET /vpn/start   — enable auto-rotation + connect
  GET /vpn/stop    — disable auto-rotation + disconnect
  GET /vpn/rotate  — force rotate now
  GET /vpn/status  — current VPN state + IP
"""

import subprocess
import json
import signal
import atexit
import platform
import random
import re
import threading
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 5124
ROTATE_INTERVAL = 600  # 10 minutes

IS_WINDOWS = platform.system() == "Windows"

if IS_WINDOWS:
    MULLVAD = r"C:\Program Files\Mullvad VPN\resources\mullvad.exe"
else:
    MULLVAD = "/usr/local/bin/mullvad"

CITIES = [
    "qas", "atl", "bos", "chi", "dal", "den", "hou",
    "mkc", "lax", "mia", "nyc", "phx", "rag", "slc", "sjc",
]

CITY_NAMES = {
    "qas": "Ashburn, VA", "atl": "Atlanta, GA", "bos": "Boston, MA",
    "chi": "Chicago, IL", "dal": "Dallas, TX", "den": "Denver, CO",
    "det": "Detroit, MI", "hou": "Houston, TX", "mkc": "Kansas City, MO",
    "lax": "Los Angeles, CA", "mia": "Miami, FL", "nyc": "New York, NY",
    "phx": "Phoenix, AZ", "rag": "Raleigh, NC", "slc": "Salt Lake City, UT",
    "sfo": "San Francisco, CA", "sjc": "San Jose, CA", "txc": "McAllen, TX",
}

SAFE_PROVIDERS = ["Tzulo", "DataPacket", "xtom", "hostuniversal"]

rotation_timer = None
auto_rotating = False
cached_ip = "unknown"


def run_cmd(cmd, timeout=15):
    try:
        kwargs = {"capture_output": True, "text": True, "timeout": timeout}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        r = subprocess.run(cmd, **kwargs)
        return r.stdout.strip(), r.returncode
    except Exception as e:
        return str(e), 1


def fetch_ip():
    for url in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
            with urllib.request.urlopen(req, timeout=5) as r:
                ip = r.read().decode().strip()
                if ip and len(ip) < 50:
                    return ip
        except Exception:
            continue
    return "unknown"


def refresh_ip():
    global cached_ip
    cached_ip = fetch_ip()
    return cached_ip


def do_rotate():
    out, _ = run_cmd([MULLVAD, "status"])
    current = ""
    m = re.search(r"us-(\w+)-wg", out)
    if m:
        current = m.group(1)

    candidates = [c for c in CITIES if c != current]
    selected = random.choice(candidates) if candidates else random.choice(CITIES)

    run_cmd([MULLVAD, "disconnect"])
    time.sleep(1)
    run_cmd([MULLVAD, "relay", "set", "provider"] + SAFE_PROVIDERS)
    run_cmd([MULLVAD, "relay", "set", "location", "us", selected])
    run_cmd([MULLVAD, "connect", "--wait"])
    time.sleep(3)

    ip = refresh_ip()
    city = CITY_NAMES.get(selected, selected)
    print(f"[VPN] Rotated → us-{selected} ({city}) | IP: {ip}")
    return selected, ip


def rotation_loop():
    global rotation_timer, auto_rotating
    if not auto_rotating:
        return
    try:
        do_rotate()
    except Exception as e:
        print(f"[VPN] Rotation error: {e}")
    if auto_rotating:
        rotation_timer = threading.Timer(ROTATE_INTERVAL, rotation_loop)
        rotation_timer.daemon = True
        rotation_timer.start()


def start_rotation():
    global auto_rotating, rotation_timer
    if auto_rotating:
        return
    auto_rotating = True
    rotation_timer = threading.Timer(ROTATE_INTERVAL, rotation_loop)
    rotation_timer.daemon = True
    rotation_timer.start()
    print(f"[VPN] Auto-rotation started (every {ROTATE_INTERVAL}s)")


def stop_rotation():
    global auto_rotating, rotation_timer
    auto_rotating = False
    if rotation_timer:
        rotation_timer.cancel()
        rotation_timer = None
    print("[VPN] Auto-rotation stopped")


def get_status():
    out, _ = run_cmd([MULLVAD, "status"])

    connected = "Connected" in out and "Disconnected" not in out

    relay_match = re.search(r"us-(\w+)-wg", out)
    city_code = relay_match.group(1) if relay_match else ""
    city_name = CITY_NAMES.get(city_code, city_code)

    return {
        "connected": connected,
        "auto_rotating": auto_rotating,
        "vpn_status": out,
        "public_ip": cached_ip,
        "server": f"us-{city_code}" if city_code else "",
        "city": city_name,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.rstrip("/")
        resp = {"ok": False}

        if path == "/vpn/start":
            run_cmd([MULLVAD, "relay", "set", "provider"] + SAFE_PROVIDERS)
            run_cmd([MULLVAD, "relay", "set", "location", "us"])
            run_cmd([MULLVAD, "connect", "--wait"])
            refresh_ip()
            start_rotation()
            resp = {"ok": True, "action": "started", **get_status()}

        elif path == "/vpn/stop":
            stop_rotation()
            run_cmd([MULLVAD, "disconnect"])
            resp = {"ok": True, "action": "stopped", **get_status()}

        elif path == "/vpn/rotate":
            do_rotate()
            resp = {"ok": True, "action": "rotated", **get_status()}

        elif path == "/vpn/status":
            resp = {"ok": True, **get_status()}

        else:
            resp = {"ok": False, "error": "unknown endpoint"}

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Access-Control-Request-Private-Network")
        self.end_headers()

    def log_message(self, fmt, *args):
        req = str(args[0]) if args else ""
        if "/vpn/" in req and "/vpn/status" not in req:
            print(f"[VPN] {req}")


def cleanup():
    print("\n[VPN] Server shutting down — stopping rotation and disconnecting...")
    stop_rotation()
    run_cmd([MULLVAD, "disconnect"])
    print("[VPN] Cleanup done.")


if __name__ == "__main__":
    atexit.register(cleanup)
    if not IS_WINDOWS:
        signal.signal(signal.SIGTERM, lambda *_: exit(0))

    print(f"VPN control server on http://localhost:{PORT}")
    print(f"Platform: {platform.system()} | Mullvad: {MULLVAD}")
    try:
        HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
