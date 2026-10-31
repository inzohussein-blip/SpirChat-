# SpirChat hub (local or internet). See deploy/internet/README-ar.md.
FROM node:22-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY hub/package.json hub/
COPY web/package.json web/
RUN npm ci
COPY packages packages
COPY hub hub
COPY web web
# Internet hubs the web app suggests by default, e.g. https://hub.example.org
ARG VITE_INTERNET_HUBS=""
RUN VITE_INTERNET_HUBS="$VITE_INTERNET_HUBS" npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages packages
COPY --from=build /app/hub hub
COPY --from=build /app/web/dist web/dist
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "hub/src/main.ts"]
