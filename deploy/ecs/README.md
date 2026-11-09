# Trackify: AWS ECS Fargate deployment (manual task definitions)

## 0. Requirements and design

- AWS CLI v2, Docker Engine/Buildx, an AWS account and permissions for ECR, ECS, IAM, ELB, RDS, VPC, CloudWatch, Secrets Manager.
- Use **one HTTPS public ALB** with **two target groups**: `/api/*` -> API:4000, default `/*` -> web:80. Set ALB target group type to **ip** for Fargate.
- Use PostgreSQL on RDS in private subnets, with an SG allowing TCP 5432 **from the API task SG only**. Use a secret for the connection URL. Ensure the RDS SSL settings match your connection string.
- Run API/web Fargate tasks in private subnets; for ECR image pull, logs and secrets provide NAT or the appropriate VPC endpoints. ALB in public subnets. Restrict API/web task SG ingress to the ALB SG on ports 4000/80.
- Set a real DNS name and ACM certificate on ALB listener 443; redirect 80 to 443. Keep frontend and API on same origin for session cookies and CSRF.
- Replace placeholders below; never commit credentials. AWS CLI examples use `ap-south-1` (change as needed).

## 1. Build images from the repository ROOT

```bash
docker build -f apps/api/Dockerfile --target runtime -t trackify-api:latest .
docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=/api/v1 -t trackify-web:latest .
```

For local smoke tests, start a PostgreSQL instance with `docker compose up -d`, run Prisma migrations with the development workflow in README, then:

```bash
docker run --rm -p 4000:4000 --env-file apps/api/.env trackify-api:latest
# In another terminal:
curl -i http://localhost:4000/api/v1/health/
curl -i http://localhost:4000/api/v1/health/ready
# Frontend:
docker run --rm -p 8080:80 trackify-web:latest
curl -i http://localhost:8080/health
```

For a backend container, `localhost` in DATABASE_URL means the container, not the host. When using Docker Desktop and a host PostgreSQL port, replace localhost with `host.docker.internal` in a **local-only** env file. `ready` returns 503 until DB is accessible and migrated.

## 2. Create ECR repositories and push

```bash
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws ecr create-repository --repository-name trackify-api --region "$AWS_REGION"
aws ecr create-repository --repository-name trackify-web --region "$AWS_REGION"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
docker tag trackify-api:latest "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/trackify-api:latest"
docker tag trackify-web:latest "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/trackify-web:latest"
docker push "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/trackify-api:latest"
docker push "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/trackify-web:latest"
```

For Apple Silicon building images to deploy to Linux/amd64 Fargate, use `docker buildx build --platform linux/amd64 ... --load` instead of `docker build`, or select ARM64 in the ECS runtime platform consistently.

## 3. Database and secrets

1. Create RDS PostgreSQL (compatible with your Prisma schema) in private subnets. Create database and user with least-privilege permissions. Prefer TLS with certificate verification.
2. Store a complete URL such as `postgresql://USER:URL_ENCODED_PASSWORD@RDS_ENDPOINT:5432/trackify?sslmode=require` as a **Secrets Manager secret string**; the ECS task execution role must have `secretsmanager:GetSecretValue` and, if applicable, KMS decrypt permissions.
3. Do not place DATABASE_URL in plaintext ECS environment variables or image build arguments. `DIRECT_DATABASE_URL` may be set for the migration task if the normal URL is pooled.
4. Apply migrations **before** switching traffic to the new version. Build the migration target:

```bash
docker build -f apps/api/Dockerfile --target migration -t trackify-migration:latest .
```

Push this image to its own ECR repository, or reuse the API repository with a separate tag. Run **one** ECS Fargate task with the migration image, private RDS network access, and DATABASE_URL (and optionally DIRECT_DATABASE_URL) injected as secrets. Wait for exit code 0. Do **not** run migrations automatically in every API task.

## 4. Create ECS cluster and task definitions MANUALLY in the console

Create an ECS cluster (Fargate). Create a CloudWatch log group for each container. Create an **execution role** for pulling ECR images, writing logs, and fetching secrets; grant application task role only permissions the app actually needs.

**API task definition**:
- Launch type Fargate; Linux; CPU architecture matches image; network mode `awsvpc`.
- Suggested starting task size: 0.5 vCPU / 1 GB memory (measure before production).
- Image: ECR `trackify-api` URI, container port **4000** TCP.
- Env: values in `production.env.example`, replacing `app.example.com` with the actual HTTPS frontend origin.
- Secret: `DATABASE_URL` from Secrets Manager.
- Log driver: awslogs, region and log group set.
- Health check (optional ECS container check): `CMD-SHELL`, `node -e "require('http').get('http://127.0.0.1:4000/api/v1/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"`. ALB target group health path: `/api/v1/health/ready`.

**Web task definition**:
- Fargate Linux, port **80** TCP, ECR `trackify-web` image.
- Log driver awslogs. ALB target group health path: `/health`.

**Migration task definition**: use the migration image, same network access to RDS and database secret, no load balancer or long-running ECS service. Run one task, check logs and successful exit before rollout.

## 5. ALB, services and DNS

1. Create an internet-facing ALB in two public subnets. HTTPS 443 listener with ACM certificate.
2. Create two target groups, target type **IP**: `trackify-api` port 4000, health `/api/v1/health/ready`; `trackify-web` port 80, health `/health`.
3. HTTPS listener rule: **path `/api/*`** forwards to API target group. Default action forwards to web target group.
4. Create two ECS services (API and web) with Fargate launch type, private subnet networking, **public IP disabled**, respective target groups and container ports.
5. Point your domain to the ALB. Set `CORS_ORIGINS=https://YOUR_DOMAIN`, `TRUST_PROXY=1`, `SESSION_COOKIE_SECURE=true`, `SESSION_COOKIE_SAMESITE=strict`. Use `/api/v1` as Vite build-time API base URL (already default).
6. Confirm `/health` returns 200, `/api/v1/health/ready` returns 200, and the app can authenticate and persist data.

## 6. Operational checks

- Confirm tasks become healthy and can reach RDS; inspect CloudWatch logs if they restart.
- Check cookie `Secure`, SameSite, and login/logout behavior over HTTPS.
- Review CPU/memory usage, scale-out database connection limits, cost, alarms, backups, RDS availability, ECR scanning and image pinning by immutable digest.
- Current rate limiting is in-memory per API instance. Consider a shared store if scaling out and strict global rate limiting is required.
- Use deployment rollback and backward-compatible database migrations; never assume migration rollback is automatic.
- For production, verify your TLS and RDS certificate policy and adjust connection URL accordingly.

## 7. Fixes included in this ZIP

- The API runtime copies both root and `apps/api/node_modules`, so workspace-local `cookie@2.x` resolves correctly.
- The API retains `parseCookie` from `cookie@2.x` in `session-cookie.ts`.
- Pino logs JSON by default, even when `NODE_ENV=development`; optional pretty output requires `LOG_PRETTY=true` **and** installation of `pino-pretty`. ECS production uses JSON logs.
- The Dockerfile's last stage is `migration`. **Always specify `--target runtime` for the API service/image**. Use `--target migration` only for one-off database migrations.
- Do not copy the temporary EC2 HTTP configuration into ECS. Use `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, `TRUST_PROXY=1`, and `CORS_ORIGINS=https://your-real-domain`.
- The web Nginx config intentionally returns 404 on `/api/*`: the ECS ALB must route `/api/*` directly to the API target group. The EC2 single-host Nginx reverse-proxy setup is different.
- ECS requires a managed RDS PostgreSQL database (or equivalent reachable PostgreSQL) and a `DATABASE_URL` secret. The local Compose database is **not** the ECS database.

### Quick verification before ECR push

```bash
docker build -f apps/api/Dockerfile --target runtime -t trackify-api:latest .
docker build -f apps/api/Dockerfile --target migration -t trackify-migration:latest .
docker build -f apps/web/Dockerfile -t trackify-web:latest .
docker run --rm --entrypoint node trackify-api:latest -e "const p=require.resolve('cookie',{paths:['/app/apps/api']}); console.log(p,Object.keys(require(p)))"
```

The last command should resolve the cookie module under `/app/apps/api/node_modules` and list `parseCookie`. A running API also requires its database secret and other runtime environment variables.
