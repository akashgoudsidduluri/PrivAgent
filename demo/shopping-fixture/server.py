"""
PrivAgent Multi-Page Shopping Demo Server (Port 4174)
Hosts a 5-page deterministic e-commerce fixture for autonomous browser agent testing.
"""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get("SHOPPING_PORT", 4174))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Prevent caching for live testing
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass

    print("============================================================")
    print("[PrivAgent] Deterministic Shopping Demo Portal (Port 4174)")
    print(f"[*] Local Fixture: http://localhost:{PORT}")
    print(f"[*] Directory: {DIRECTORY}")
    print("[*] Products active: 4 items (1 qualifying match: XXL Black Baggy Bag @ ₹899)")
    print("============================================================")
    
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\nShutting down demo server gracefully.")
                sys.exit(0)
    except OSError as e:
        if getattr(e, 'winerror', None) == 10048 or getattr(e, 'errno', None) in (98, 48):
            print(f"\n[!] Port {PORT} is already running an active demo server instance.")
            sys.exit(0)
        else:
            raise e

if __name__ == "__main__":
    main()
