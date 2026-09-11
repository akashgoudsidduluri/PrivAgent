"""
PrivAgent Synthetic Banking Demo Server
Starts a local HTTP server hosting the synthetic banking portal.
"""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get("DEMO_PORT", 4173))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Prevent caching for live development
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass

    print("============================================================")
    print("[PrivAgent] Demo Banking Site (SIH26171, ISRO)")
    print(f"[*] Local Demo Portal: http://localhost:{PORT}")
    print(f"[*] Directory: {DIRECTORY}")
    print("[*] Synthetic records active: Rahul Sharma, 4111 1111 1111 1111")
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
            print(f"\n[!] Port {PORT} is ALREADY running an active demo server instance!")
            print(f"[*] You can already open and test the site at: http://localhost:{PORT}")
            print("[*] (If you wish to restart it, stop the existing running process first.)\n")
            sys.exit(0)
        else:
            raise e

if __name__ == "__main__":
    main()
