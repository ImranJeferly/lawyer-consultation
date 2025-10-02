# syntax=docker/dockerfile:1.6

FROM node:20-bullseye-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json .
COPY prisma ./prisma
COPY migrations ./migrations
COPY src ./src
COPY package.json package-lock.json ./
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV PORT=3000

# Copy only the runtime essentials
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY migrations ./migrations

EXPOSE 3000

CMD ["node", "dist/index.js"]
