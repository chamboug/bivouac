# Built from the monorepo's root: the page takes the oidc layer of the same commit.
FROM node:26-alpine AS build
WORKDIR /src/status-page
COPY status-page/package.json status-page/package-lock.json ./
# No install scripts: nothing from a dependency runs at install time (D94).
RUN npm ci --ignore-scripts
COPY status-page/ ./
COPY app-layers/oidc ./.layers/oidc
RUN npx nuxt build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/status-page/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
