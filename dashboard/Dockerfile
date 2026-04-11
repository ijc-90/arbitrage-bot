FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .

EXPOSE 4000
CMD ["npx", "ts-node", "server.ts", "--db", "/app/logs/arb.db", "--port", "4000"]
