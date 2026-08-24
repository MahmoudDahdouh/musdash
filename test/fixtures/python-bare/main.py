import http.server, os, socketserver

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"python-bare ok\n")

socketserver.TCPServer(("", int(os.environ.get("PORT", 3000))), H).serve_forever()
