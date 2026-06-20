FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

COPY package*.json ./

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
