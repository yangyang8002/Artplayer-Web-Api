FROM node:22-alpine

RUN apk add --no-cache git wget

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public/

RUN mkdir -p data

EXPOSE 1919

ENV PORT=1919
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:1919/api/config/public || exit 1

CMD ["node", "server.js"]
