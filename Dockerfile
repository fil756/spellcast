FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
