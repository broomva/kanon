# Kanon rendezvous server.
#
# Build from the REPO ROOT (the workspace lockfile drives the install):
#   docker build -f apps/server/Dockerfile -t kanon-server .
#
# Run (the data repo lives on a mounted volume — see README "Deploy"):
#   docker run -p 3000:3000 -v kanon-data:/data \
#     -e KANON_DATA_DIR=/data/workspace \
#     -e KANON_API_KEYS="key:actor@example.com:human" \
#     kanon-server

FROM oven/bun:1

# git carries the canonical log; openssh for git+ssh remotes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
COPY examples ./examples

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "apps/server/src/index.ts"]
