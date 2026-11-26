FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/package.json proxy/
COPY web/package.json web/
COPY demo/package.json demo/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web build \
 && rm -rf node_modules proxy/node_modules demo/node_modules web/node_modules \
 && pnpm install --frozen-lockfile --prod --filter @sceau/proxy --filter @sceau/demo

FROM node:24-alpine
WORKDIR /app
# TypeScript runs as is on Node 24; nothing is compiled, so the stack traces point at the sources
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/proxy proxy
COPY --from=build /src/demo demo
COPY --from=build /src/web/dist web/dist
COPY deploy/sceau.yaml /etc/sceau/sceau.yaml
RUN mkdir -p /var/lib/sceau && chown node:node /var/lib/sceau \
 && chmod +x proxy/src/cli.ts && ln -s /app/proxy/src/cli.ts /usr/local/bin/sceau

ENV NODE_ENV=production \
    SCEAU_LISTEN=0.0.0.0:7325 \
    SCEAU_DATA=/var/lib/sceau \
    SCEAU_CONSOLE=/app/web/dist
USER node
VOLUME /var/lib/sceau
EXPOSE 7325
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:7325/healthz || exit 1
ENTRYPOINT ["sceau"]
CMD ["serve", "-c", "/etc/sceau/sceau.yaml"]
