"""
PrivAgent Canvas Privacy Demo Server
Starts a local HTTP server hosting the synthetic canvas privacy test site.
"""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get("CANVAS_DEMO_PORT", 4174))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass

    print("============================================================")
    print("[PrivAgent] Milestone 3 Canvas Privacy Demo (SIH26171, ISRO)")
    print(f"[*] Local Canvas Demo Portal: http://localhost:{PORT}")
    print(f"[*] Directory: {DIRECTORY}")
    print("[*] Target: Pure Canvas-rendered PII (Zero DOM text nodes)")
    print("============================================================")
    
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\nShutting down canvas demo server gracefully.")
                sys.exit(0)
    except OSError as e:
        if getattr(e, 'winerror', None) == 10048 or getattr(e, 'errno', None) in (98, 48):
            print(f"\n[!] Port {PORT} is ALREADY running an active canvas demo server instance!")
            print(f"[*] You can open and test the site at: http://localhost:{PORT}\n")
            sys.exit(0)
        else:
            raise e

if __name__ == "__main__":
    main()
