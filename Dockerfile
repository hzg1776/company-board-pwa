FROM node:22-alpine AS deps

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_FILE=/app/data/board.json

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
