FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Demo data is never enabled in a deployed build
ENV VITE_ENABLE_DEMO=false
RUN npm run build

FROM nginx:1.30.5-alpine
RUN apk upgrade --no-cache
COPY --from=build /app/dist /usr/share/nginx/html
COPY ops/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
