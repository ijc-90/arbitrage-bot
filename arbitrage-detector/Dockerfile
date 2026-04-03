FROM node:20-alpine

RUN apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install && apk del .build-deps

COPY . .

CMD ["npx", "ts-node", "detector.ts", "--db", "/app/logs/arb.db"]
