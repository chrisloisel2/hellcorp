#!/usr/bin/env python3
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        super().end_headers()

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

port = 8765
for candidate in range(8765, 8795):
    try:
        httpd = Server(('127.0.0.1', candidate), Handler)
        port = candidate
        break
    except OSError:
        continue
else:
    raise SystemExit('Aucun port local libre entre 8765 et 8794.')

url = f'http://127.0.0.1:{port}/index.html'
print(f'HellCorp Motion Studio: {url}')
threading.Timer(0.7, lambda: webbrowser.open(url)).start()
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    httpd.server_close()
