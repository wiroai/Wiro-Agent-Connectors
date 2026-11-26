# syntax=docker/dockerfile:1

# Runs one connector over stdio, named by the first argument, with its
# credentials from the environment:
#   docker run -i --rm -e SERPER_APIKEY wiroai/wiro-agent-connectors serper
#   docker run --rm wiroai/wiro-agent-connectors --list

# The build stage runs on the build machine's own platform. Its output is plain
# JavaScript and no runtime dependency ships native code, so the same files
# serve both amd64 and arm64, and the final stage only copies them.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
LABEL org.opencontainers.image.title="Wiro Agent Connectors" \
      org.opencontainers.image.description="MCP connectors for services with no official MCP server, such as Gmail, Shopify and YouTube. One connector per container, over stdio." \
      org.opencontainers.image.url="https://github.com/wiroai/Wiro-Agent-Connectors" \
      org.opencontainers.image.source="https://github.com/wiroai/Wiro-Agent-Connectors" \
      org.opencontainers.image.vendor="Wiro AI" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="ai.wiro/agent-connectors"
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE ./
# The base image's node user, by number so that runtimes which check for a
# non-root user (Kubernetes runAsNonRoot, for one) can verify it.
USER 1000:1000
ENTRYPOINT ["node", "dist/cli.js"]
