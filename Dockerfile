# Tahap 1: build frontend (butuh VITE_API_URL saat build bila domain terpisah;
# kosongkan = same-origin, karena API serve hasil build ini satu domain).
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Tahap 2: API + hasil build + SQL migrasi
FROM node:22-bookworm-slim
WORKDIR /app
COPY api/package*.json ./
RUN npm install --omit=dev
COPY api/ ./
COPY db/ ./db/
COPY --from=web /build/web/dist ./public-dist
ENV PUBLIC_DIR=/app/public-dist DB_DIR=/app/db PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "node migrate.js && node server.js"]
