# A tiny app following the platform contract (D19), for the end-to-end tests:
# it listens on $PORT and answers on /api/health.
FROM node:26-alpine
COPY server.mjs /app/server.mjs
USER node
CMD ["node", "/app/server.mjs"]
