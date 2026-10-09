FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY server ./server
COPY web ./web
COPY shared ./shared
COPY scripts ./scripts
COPY tizen ./tizen
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && apt-get clean
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=build /app/dist ./dist
USER 1000:1000
EXPOSE 8787
CMD ["node", "dist/server/main.mjs"]
