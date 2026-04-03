FROM node:20-alpine

RUN apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install && apk del .build-deps

COPY . .

EXPOSE 4000
CMD ["npx", "ts-node", "server.ts", "--db", "/app/logs/arb.db", "--port", "4000"]
