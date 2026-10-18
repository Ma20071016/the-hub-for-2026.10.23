# Proxy HTML too: Python checks login and injects account information.
proxy_pass http://127.0.0.1:5173;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header Connection "";
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
# Send NDJSON review progress immediately.
proxy_buffering off;
proxy_cache off;
# The backend requires Content-Length and has a short socket read timeout.
proxy_request_buffering on;
proxy_connect_timeout 5s;
# Idle time between response reads, not a total computation deadline.
proxy_read_timeout 1800s;
proxy_send_timeout 60s;
