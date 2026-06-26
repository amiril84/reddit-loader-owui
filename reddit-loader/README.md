# Open WebUI external loader

Internal external-web-loader service for Open WebUI.

- Reddit-related URLs are rendered with persistent Chromium in Xvfb through
  the configured residential proxy. Rejected sticky sessions are rotated.
- Threads URLs are rendered with the same persistent Chromium context and
  extract public logged-out visible post, series, reply, and post-link content.
- Other public HTTP(S) URLs use direct fetching and Readability extraction.
- The service must only be attached to the private Docker network.
- `POST /load` implements Open WebUI's external loader contract.
- `GET /health` is available for container health checks.

Supported browser-rendered hosts:

- `reddit.com`, `redd.it`, and Reddit subdomains.
- `threads.com`, `www.threads.com`, `threads.net`, and `www.threads.net`.

Required environment variables:

```text
LOADER_API_KEY
PROXY_HOST
PROXY_PORT
PROXY_USER
PROXY_PASS
```
