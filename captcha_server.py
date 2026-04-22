import base64
import re
import ddddocr
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

ocr = ddddocr.DdddOcr(show_ad=False)

def clean_captcha(text):
    cleaned = re.sub(r'[^A-Za-z0-9]', '', text).upper()
    return cleaned if len(cleaned) == 5 else text.upper().strip()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/solve":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        image_b64 = body.get("image", "")

        try:
            image_bytes = base64.b64decode(image_b64)
            raw = ocr.classification(image_bytes)
            result = clean_captcha(raw)
            print(f"[CAPTCHA] Raw: {raw} → Cleaned: {result}")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"text": result}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[CAPTCHA] {args[0]}")

if __name__ == "__main__":
    port = 5123
    print(f"CAPTCHA solver running on http://localhost:{port}/solve")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
