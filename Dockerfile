FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY icons ./icons/

RUN mkdir -p /app/repo

ENV PORT=3000
ENV REPO_DIR=/app/repo
RUN chown -R node:node /app/repo

EXPOSE 3000

USER node

CMD ["node", "server.js"]
