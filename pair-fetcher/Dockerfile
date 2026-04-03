FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm_config_nodedir=/usr/local npm rebuild better-sqlite3 --build-from-source

CMD ["node", "dist/fetcher.js", "--db", "/app/logs/arb.db"]
