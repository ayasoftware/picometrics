FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install && npm install --no-save esbuild
COPY tsconfig.json ./
COPY src ./src
RUN node_modules/.bin/esbuild src/index.ts --bundle --platform=node --target=node20 --packages=external --outfile=dist/index.js

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN apk add --no-cache curl && addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3104
CMD ["node", "dist/index.js"]
