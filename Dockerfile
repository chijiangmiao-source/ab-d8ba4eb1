FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单，利用层缓存
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm install --no-audit --no-fund

# 复制源码并构建前端（构建产物随后由 Express 托管）
COPY . .
RUN npm run build --workspace web

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# busybox wget 供 HEALTHCHECK 使用（alpine 自带）
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/src/index.js"]
