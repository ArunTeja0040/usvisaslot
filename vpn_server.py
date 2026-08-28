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
import ssl
import threading
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 5124
ROTATE_MIN = 900   # 15 minutes
ROTATE_MAX = 1200  # 20 minutes


def next_interval():
    # Random 15-20 min between rotations so the IP-change cadence is not a
    # fixed, predictable pattern.
    return random.randint(ROTATE_MIN, ROTATE_MAX)

IS_WINDOWS = platform.system() == "Windows"

if IS_WINDOWS:
    MULLVAD = r"C:\Program Files\Mullvad VPN\resources\mullvad.exe"
else:
    MULLVAD = "/usr/local/bin/mullvad"

# #73 Exit pool, country -> cities. Every city listed is served by at least one
# SAFE_PROVIDERS host (verified against `mullvad relay list`), so the provider
# pin below still matches a relay in each of them.
# Deliberately excluded: ca-yyc (Calgary) — techfutures only, no safe provider,
# so pinning providers there would leave Mullvad with nothing to connect to.
POOLS = {
    "us": ["qas", "atl", "bos", "chi", "dal", "den", "hou",
           "mkc", "lax", "mia", "nyc", "phx", "rag", "slc", "sjc"],
    "ca": ["mtr", "tor", "van"],
    "au": ["adl", "bne", "mel", "per", "syd"],
    "it": ["mil", "pmo"],
}

# Flat [(country, city), ...] so a rotation can pick uniformly across the pool.
EXITS = [(cc, city) for cc, cities in POOLS.items() for city in cities]

CITY_NAMES = {
    "qas": "Ashburn, VA", "atl": "Atlanta, GA", "bos": "Boston, MA",
    "chi": "Chicago, IL", "dal": "Dallas, TX", "den": "Denver, CO",
    "det": "Detroit, MI", "hou": "Houston, TX", "mkc": "Kansas City, MO",
    "lax": "Los Angeles, CA", "mia": "Miami, FL", "nyc": "New York, NY",
    "phx": "Phoenix, AZ", "rag": "Raleigh, NC", "slc": "Salt Lake City, UT",
    "sfo": "San Francisco, CA", "sjc": "San Jose, CA", "txc": "McAllen, TX",
    "mtr": "Montreal, QC", "tor": "Toronto, ON", "van": "Vancouver, BC",
    "adl": "Adelaide", "bne": "Brisbane", "mel": "Melbourne",
    "per": "Perth", "syd": "Sydney",
    "mil": "Milan", "pmo": "Palermo",
}

SAFE_PROVIDERS = ["Tzulo", "DataPacket", "xtom", "hostuniversal"]

# Relay names look like "us-sjc-wg-501" / "au-syd-wg-101".
RELAY_RE = re.compile(r"\b([a-z]{2})-([a-z]{3})-wg", re.IGNORECASE)

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
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    urls = [
        "https://am.i.mullvad.net/ip",
        "https://api.ipify.org",
        "https://icanhazip.com",
    ]
    for attempt in range(2):
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
                with urllib.request.urlopen(req, timeout=8, context=ctx) as r:
                    ip = r.read().decode().strip()
                    if ip and len(ip) < 50 and ip[0].isdigit():
                        return ip
            except Exception:
                continue
        if attempt == 0:
            time.sleep(3)
    return "unknown"


def refresh_ip():
    global cached_ip
    cached_ip = fetch_ip()
    return cached_ip


def current_exit():
    """(country, city) of the relay we are on, or ("", "") when not connected."""
    out, _ = run_cmd([MULLVAD, "status"])
    m = RELAY_RE.search(out)
    return (m.group(1).lower(), m.group(2).lower()) if m else ("", "")


def do_rotate():
    current = current_exit()

    # Never re-pick the exit we are already on — a rotation that lands on the
    # same IP is treated as a failure by the extension.
    candidates = [e for e in EXITS if e != current]
    country, city = random.choice(candidates) if candidates else random.choice(EXITS)

    run_cmd([MULLVAD, "disconnect"])
    time.sleep(1)
    run_cmd([MULLVAD, "relay", "set", "provider"] + SAFE_PROVIDERS)
    run_cmd([MULLVAD, "relay", "set", "location", country, city])
    run_cmd([MULLVAD, "connect", "--wait"])
    time.sleep(5)

    ip = refresh_ip()
    name = CITY_NAMES.get(city, city)
    print(f"[VPN] Rotated → {country}-{city} ({name}) | IP: {ip}")
    return f"{country}-{city}", ip


def rotation_loop():
    global rotation_timer, auto_rotating
    if not auto_rotating:
        return
    try:
        do_rotate()
    except Exception as e:
        print(f"[VPN] Rotation error: {e}")
    if auto_rotating:
        rotation_timer = threading.Timer(next_interval(), rotation_loop)
        rotation_timer.daemon = True
        rotation_timer.start()


def start_rotation():
    global auto_rotating, rotation_timer
    if auto_rotating:
        return
    auto_rotating = True
    rotation_timer = threading.Timer(next_interval(), rotation_loop)
    rotation_timer.daemon = True
    rotation_timer.start()
    print(f"[VPN] Auto-rotation started (random {ROTATE_MIN // 60}-{ROTATE_MAX // 60} min)")


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

    relay_match = RELAY_RE.search(out)
    country_code = relay_match.group(1).lower() if relay_match else ""
    city_code = relay_match.group(2).lower() if relay_match else ""
    city_name = CITY_NAMES.get(city_code, city_code)

    return {
        "connected": connected,
        "auto_rotating": auto_rotating,
        "vpn_status": out,
        "public_ip": cached_ip,
        "server": f"{country_code}-{city_code}" if city_code else "",
        "country": country_code,
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
            time.sleep(5)
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
