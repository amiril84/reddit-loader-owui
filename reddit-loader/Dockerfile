FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY server.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    BROWSER_DATA_DIR=/data/browser \
    NAVIGATION_TIMEOUT_MS=45000 \
    REQUEST_TIMEOUT_MS=30000 \
    MAX_RESPONSE_BYTES=10485760

RUN mkdir -p /data/browser \
    && chown -R pwuser:pwuser /app /data

USER pwuser

EXPOSE 8080

CMD ["xvfb-run", "-a", "node", "server.js"]
