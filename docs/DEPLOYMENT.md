# Deployment Guide

This document describes how to containerize and deploy the Lawyer Consultation backend to a production environment. It covers local smoke tests with Docker Compose, building images for a registry, running database migrations, and recommended steps for common hosting providers.

## Prerequisites

- Node.js 20+ and npm 10+ (for local builds)
- Docker Engine 24+ and Docker Compose
- Access to a PostgreSQL 16 database (managed service or self-hosted)
- Access to a Redis 7 instance for queues and socket.io adapters
- Clerk project credentials for authentication
- Firebase Admin credentials if document or messaging features are enabled
- Email/SMS providers (e.g., Twilio, AWS SES/S3) credentials as required by the feature set you enable

## Environment Variables

Create a `.env.production` (or reuse `.env`) file that will be supplied to the container. At minimum configure the following groups:

### Core application
- `NODE_ENV=production`
- `PORT=3000`
- `APP_BASE_URL` – canonical https URL for the API
- `FRONTEND_URL` – origin allowed for CORS

### Database & caching
- `DATABASE_URL` – Postgres connection string (e.g. `postgresql://user:pass@host:5432/db?schema=public`)
- `SHADOW_DATABASE_URL` – optional, required by Prisma in migrate workflows
- `REDIS_URL` – Redis connection string (e.g. `redis://:pass@host:6379/0`)

### Clerk authentication
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_WEBHOOK_SIGNING_SECRET`
- `CLERK_JWT_ISSUER`
- `CLERK_JWT_AUDIENCE` (comma separated)
- `CLERK_AUTHORIZED_PARTIES` (comma separated)

### JWT / session security
- `JWT_SECRET`
- `SESSION_SECRET`

### Email & SMS providers (adjust to your integrations)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`

### Storage and document services
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `S3_BUCKET_NAME`
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`

### Search, analytics, and queues
- `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY`
- `BULLMQ_CONNECTION_STRING` (if different from `REDIS_URL`)

Inspect the codebase for additional services you intend to use (Stripe, Plaid, etc.) and add corresponding keys. Keep secrets outside of version control—provide them to your hosting platform via secret managers or environment configuration.

## Local smoke test with Docker Compose

1. Copy your production-like settings into `.env.docker` at the project root. For a quick local run you can start with:
   ```env
   NODE_ENV=production
   PORT=3000
   DATABASE_URL=postgresql://lawyer:lawyer@postgres:5432/lawyer?schema=public
   REDIS_URL=redis://redis:6379
   FRONTEND_URL=http://localhost:3001
   CLERK_SECRET_KEY=sk_test_placeholder
   CLERK_WEBHOOK_SIGNING_SECRET=whsec_test_placeholder
   JWT_SECRET=change_me
   SESSION_SECRET=change_me
   ```
2. Build and start the stack:
   ```bash
   docker compose up --build
   ```
3. Wait for the containers to report healthy, then run migrations against the Postgres service:
   ```bash
   docker compose exec app npx prisma migrate deploy
   ```
4. Open http://localhost:3000/health to confirm the service responds.

Stop the stack with `docker compose down` when finished. Volume data persists between runs unless you add `--volumes`.

## Building and pushing the image

1. Build the production image:
   ```bash
   docker build -t ghcr.io/<org>/lawyer-consultation-backend:latest .
   ```
2. Log in to your container registry (for GitHub Container Registry replace the URL accordingly):
   ```bash
   echo $CR_PAT | docker login ghcr.io -u <username> --password-stdin
   ```
3. Push the image:
   ```bash
   docker push ghcr.io/<org>/lawyer-consultation-backend:latest
   ```

Automate these steps in CI (GitHub Actions, GitLab CI, etc.) so every merge to `main` builds and publishes a tagged image.

## Deploying to Render / Fly.io / AWS ECS

These platforms share a similar flow:

1. **Provision infrastructure**
   - PostgreSQL 16 instance
   - Redis 7 instance (or use managed services like Upstash/Elasticache)
   - Object storage (S3-compatible) if document uploads are needed
2. **Configure secrets** – Add all values from `docs/DEPLOYMENT.md#environment-variables` via the provider’s secret manager.
3. **Run migrations** – Use the new npm script to apply schema changes:
   ```bash
   npm run migrate:deploy
   ```
   On container hosts run this once after deploying a new image (Render “Deploy hook”, Fly “Release command”, ECS task). For serverless CI/CD, invoke `npx prisma migrate deploy` in a job targeting the same DATABASE_URL.
4. **Launch the service** – Start the container with command `node dist/index.js`. Ensure the platform exposes port 3000 or remap via environment variable `PORT`.
5. **Verify** – Hit `/health`, watch application logs, and confirm background queues (BullMQ) connect to Redis.

### Example: Render Blueprint

```yaml
services:
  - type: web
    name: lawyer-consultation-backend
    plan: standard
    env: docker
    dockerfilePath: Dockerfile
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: REDIS_URL
        sync: false
      - key: CLERK_SECRET_KEY
        sync: false
      # ...repeat for all secrets
    healthCheckPath: /health
    autoDeploy: true
    buildCommand: "npm ci && npm run build"
    startCommand: "npm run migrate:deploy && npm start"
```

### Example: Fly.io

- Create a PostgreSQL app (`fly pg create`) and a Redis add-on (Upstash or fly redis).
- Initialize the app: `fly launch --copy-config` to reuse `Dockerfile`.
- In `fly.toml`, add:
  ```toml
  [env]
  PORT = "3000"
  NODE_ENV = "production"
  ```
- Add secrets: `fly secrets set DATABASE_URL=... REDIS_URL=...`
- Include a `release_command = "npm run migrate:deploy"` so migrations run on each release.

## Operational checklist

- **Monitoring:** Configure uptime checks against `/health` and aggregate logs using your provider (e.g., Render logs, Fly logs).
- **Backups:** Schedule PostgreSQL backups and enable point-in-time recovery. Persist Redis data if queue durability is required.
- **Scaling:** Horizontal scaling requires sticky sessions for socket.io; prefer a shared Redis adapter (already supported) and configure load balancer to allow WebSocket upgrades.
- **Security:** Enforce HTTPS via your CDN or platform. Keep `CLERK_*` secrets current and rotate JWT/SESSION secrets periodically.
- **CI/CD:** Add a pipeline step that runs `npm run build` and key Jest suites before building the Docker image.

## Troubleshooting

- `Error: Missing required Clerk environment variable` – confirm you set every required `CLERK_*` value.
- `PrismaClientKnownRequestError P1017` – check database connectivity; ensure security groups allow the container to reach the Postgres host.
- WebSocket connection issues – confirm the hosting platform supports WebSockets and `FRONTEND_URL` matches the client origin.

With these assets in place you can reproduce predictable builds locally, publish container images from CI, and roll them out to your infrastructure of choice.
