# Container image for the scribefy-mcp stdio server.
#
# Primarily for MCP directory checks (e.g. Glama builds + runs this and verifies
# the server starts and responds to MCP introspection — initialize + tools/list).
# The server registers its four tools WITHOUT an API key; SCRIBEFY_API_KEY is only
# needed to actually *call* a tool. So introspection passes with no key set; set
# SCRIBEFY_API_KEY (sk_live_…/sk_test_…) as an env var to use it for real.
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# stdio MCP server (JSON-RPC over stdin/stdout)
ENTRYPOINT ["node", "dist/index.js"]
