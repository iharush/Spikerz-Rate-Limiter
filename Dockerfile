FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci
COPY tsconfig.server.json ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY infra/sql ./infra/sql
RUN mkdir -p /app/.secrets && chown node:node /app/.secrets
USER node
CMD ["node", "dist/apps/data-api/src/main.js"]

FROM nginx:1.29-alpine AS web
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin-web/dist /usr/share/nginx/html
