"""
VPN Rotation Control Server — localhost:5124
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
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 5124
LAUNCHD_LABEL = "com.vpn.rotate"
LAUNCHD_PLIST = f"/Users/aruntejagannu/Library/LaunchAgents/{LAUNCHD_LABEL}.plist"
ROTATE_SCRIPT = "/Users/aruntejagannu/vpn-rotate.sh"


def run_cmd(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except Exception as e:
        return str(e), 1


CITY_NAMES = {
    "qas": "Ashburn, VA", "atl": "Atlanta, GA", "bos": "Boston, MA",
    "chi": "Chicago, IL", "dal": "Dallas, TX", "den": "Denver, CO",
    "det": "Detroit, MI", "hou": "Houston, TX", "mkc": "Kansas City, MO",
    "lax": "Los Angeles, CA", "mia": "Miami, FL", "nyc": "New York, NY",
    "phx": "Phoenix, AZ", "rag": "Raleigh, NC", "slc": "Salt Lake City, UT",
    "sfo": "San Francisco, CA", "sjc": "San Jose, CA", "txc": "McAllen, TX",
}


def get_status():
    out, _ = run_cmd(["mullvad", "status"])
    ip_out, _ = run_cmd(["curl", "-s", "--max-time", "5", "ifconfig.me"])

    loaded, _ = run_cmd(["launchctl", "list"])
    auto_rotating = LAUNCHD_LABEL in loaded

    connected = "Connected" in out and "Disconnected" not in out

    import re
    relay_match = re.search(r"us-(\w+)-wg", out)
    city_code = relay_match.group(1) if relay_match else ""
    city_name = CITY_NAMES.get(city_code, city_code)

    return {
        "connected": connected,
        "auto_rotating": auto_rotating,
        "vpn_status": out,
        "public_ip": ip_out if ip_out else "unknown",
        "server": f"us-{city_code}" if city_code else "",
        "city": city_name,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.rstrip("/")
        resp = {"ok": False}

        if path == "/vpn/start":
            run_cmd(["mullvad", "relay", "set", "provider", "any"])
            run_cmd(["mullvad", "relay", "set", "location", "us"])
            run_cmd(["mullvad", "connect", "--wait"])
            run_cmd(["launchctl", "load", LAUNCHD_PLIST])
            resp = {"ok": True, "action": "started", **get_status()}

        elif path == "/vpn/stop":
            run_cmd(["launchctl", "unload", LAUNCHD_PLIST])
            run_cmd(["mullvad", "disconnect"])
            resp = {"ok": True, "action": "stopped", **get_status()}

        elif path == "/vpn/rotate":
            run_cmd(["bash", ROTATE_SCRIPT])
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
        if "/vpn/" in str(args[0]):
            print(f"[VPN] {args[0]}")


def cleanup():
    print("\n[VPN] Server shutting down — stopping VPN rotation and disconnecting...")
    run_cmd(["launchctl", "unload", LAUNCHD_PLIST])
    run_cmd(["mullvad", "disconnect"])
    print("[VPN] Cleanup done.")


if __name__ == "__main__":
    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: exit(0))

    print(f"VPN control server on http://localhost:{PORT}")
    try:
        HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
