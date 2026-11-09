FROM node:26-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations STORAGE_DIR=/app/uploads
COPY --from=build /src/.output ./.output
COPY --from=build /src/server/db/migrations ./migrations
# A volume mounted here takes this owner the first time it is used.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
