FROM node:22-alpine

WORKDIR /app

# No dependencies to install, so there is nothing to fetch at build time and no
# package manager left in the final image path.
COPY package.json ./
COPY server ./server
COPY public ./public

RUN addgroup -S icq && adduser -S icq -G icq && mkdir -p /data && chown icq:icq /data
USER icq

ENV NODE_ENV=production \
    PORT=5190 \
    HOST=0.0.0.0 \
    OPENICQ_DATA=/data/openicq.json

VOLUME ["/data"]
EXPOSE 5190

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:5190/health || exit 1

CMD ["node", "server/index.js"]
