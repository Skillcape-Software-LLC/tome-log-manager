# Deploying Tome on AWS Fargate

This guide covers adding a Tome service to an **existing** ECS cluster. It assumes you already have a VPC, subnets, an ECS cluster, and an Application Load Balancer provisioned.

> **Note on `start.sh`**: The repository's `start.sh` script automates credential generation, schema initialization, and admin key seeding for the Docker Compose setup, where Postgres runs as a sibling container with `docker-entrypoint-initdb.d`. On Fargate, the database is an external RDS instance, so those entrypoint hooks don't apply. The manual steps in sections 1 and 2 below are the Fargate equivalent of what `start.sh` and the Postgres container handle automatically in the compose flow. They only need to be run once during initial setup.

---

## 1. Provision the PostgreSQL Instance (RDS)

### Create the RDS Instance

1. Open the **RDS Console** and click **Create database**.
2. Configure the instance:

| Setting | Value |
|---------|-------|
| Engine | PostgreSQL 16 |
| Template | Production (or Dev/Test for non-prod) |
| Instance class | `db.t4g.medium` minimum (adjust for expected log volume) |
| Storage | General Purpose SSD (gp3), 50 GB minimum, enable autoscaling |
| DB instance identifier | `tome-db` |
| Master username | `logger` |
| Master password | Generate or set a strong password |
| DB name | `logs` |

3. Under **Connectivity**:
   - Place the instance in the **same VPC** as your ECS cluster.
   - Select **private subnets** only (no public access).
   - Create or assign a security group that allows inbound TCP 5432 **only from the Fargate service security group** (configured later).
4. Under **Additional configuration**:
   - Set **Backup retention** to at least 7 days.
   - Enable **Encryption at rest**.
   - Enable **Performance Insights** (free tier for 7-day retention).

### Tune PostgreSQL Parameters

Create a custom **DB Parameter Group** (`tome-params`) and set:

| Parameter | Value | Why |
|-----------|-------|-----|
| `shared_buffers` | `{DBInstanceClassMemory/4}` | 25% of instance memory |
| `work_mem` | `8192` (8 MB) | Matches compose tuning |
| `maintenance_work_mem` | `65536` (64 MB) | Matches compose tuning |
| `max_connections` | `100` | Tome defaults to a 25-connection pool; headroom for direct access/migrations |

Apply the parameter group to the instance and reboot if needed.

### Initialize the Schema

Connect to the RDS instance from a bastion host or through SSM Session Manager:

```bash
psql "postgresql://logger:<PASSWORD>@<RDS_ENDPOINT>:5432/logs" < postgres/init.sql
```

### Seed the Admin API Key

Generate a key and its SHA-256 hash, then insert the bootstrap admin row:

```bash
ADMIN_KEY=$(openssl rand -hex 32)
ADMIN_KEY_HASH=$(echo -n "$ADMIN_KEY" | openssl dgst -sha256 | sed 's/^.*= //')

psql "postgresql://logger:<PASSWORD>@<RDS_ENDPOINT>:5432/logs" \
  -c "INSERT INTO api_keys (key_hash, name, role)
      VALUES ('$ADMIN_KEY_HASH', 'bootstrap-admin', 'admin');"
```

**Save `$ADMIN_KEY` securely** (e.g., in AWS Secrets Manager). This is the only time the raw key is available -- Tome only stores the hash.

---

## 2. Store Secrets in AWS

### Secrets Manager

Create a secret named `tome/database-url` containing the full connection string:

```
postgresql://logger:<PASSWORD>@<RDS_ENDPOINT>:5432/logs
```

If you use SMTP alerting, create a second secret `tome/smtp-password` for the SMTP credential.

### Systems Manager Parameter Store (alternative)

For non-sensitive config you can use SSM Parameter Store (`SecureString` type) instead. Both work with ECS task definition `secrets` blocks.

---

## 3. Create the ECS Task Definition

### IAM Execution Role

Your task execution role needs these policies:

- `AmazonECSTaskExecutionRolePolicy` (managed policy for pulling images and writing logs)
- A custom inline policy to read your secrets:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": [
        "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:tome/*"
      ]
    }
  ]
}
```

### Task Definition

Register a task definition (JSON or via console). Key settings:

```json
{
  "family": "tome-api",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "tome-api",
      "image": "ghcr.io/<YOUR_ORG>/tome-log-manager:<VERSION>",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        { "name": "NODE_ENV",        "value": "production" },
        { "name": "TOME_LOG_LEVELS", "value": "trace,debug,info,warn,error,fatal" },
        { "name": "SMTP_HOST",       "value": "smtp.sendgrid.net" },
        { "name": "SMTP_PORT",       "value": "587" },
        { "name": "SMTP_USER",       "value": "apikey" },
        { "name": "SMTP_FROM",       "value": "logs@yourdomain.com" },
        { "name": "SMTP_STARTTLS",   "value": "true" }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:tome/database-url"
        },
        {
          "name": "SMTP_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:tome/smtp-password"
        }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://localhost:3000/healthz || exit 1"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/tome-api",
          "awslogs-region": "<REGION>",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "stopTimeout": 30
    }
  ]
}
```

**Notes on the container configuration:**

- **Image**: Replace `<YOUR_ORG>` with your GitHub organization and `<VERSION>` with a release tag. Pin to a specific version rather than `latest` for production. See section 4 for ECR mirroring if preferred.
- **Port 3000**: The Tome container listens on port 3000 internally. The ALB handles the external port mapping.
- **CPU/Memory**: 512 CPU / 1024 MB is a reasonable starting point. Scale up based on ingest volume.
- **`stopTimeout: 30`**: Gives the application time to drain its in-memory write buffer and close database connections during graceful shutdown (the app handles `SIGTERM`).

### Create the CloudWatch Log Group

```bash
aws logs create-log-group --log-group-name /ecs/tome-api --region <REGION>
aws logs put-retention-policy --log-group-name /ecs/tome-api --retention-in-days 30
```

---

## 4. Container Image

The Tome Docker image is published publicly to GHCR. Fargate can pull it directly -- no cloning the repo or building from source required.

The image URI follows this pattern:

```
ghcr.io/<YOUR_ORG>/tome-log-manager:<VERSION>
```

Pin to a specific release tag (e.g., `1.2.3`) rather than `latest` for production deployments. Tags are published automatically by CI on every `v*` git tag.

> **Optional: Mirror to Amazon ECR** -- If you prefer faster pulls (same-network), no external registry dependency, or built-in image scanning, you can mirror the image to ECR:
>
> ```bash
> aws ecr create-repository --repository-name tome-api \
>   --image-scanning-configuration scanOnPush=true --region <REGION>
>
> docker pull ghcr.io/<YOUR_ORG>/tome-log-manager:<VERSION>
> docker tag ghcr.io/<YOUR_ORG>/tome-log-manager:<VERSION> \
>   <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/tome-api:<VERSION>
>
> aws ecr get-login-password --region <REGION> \
>   | docker login --username AWS --password-stdin \
>     <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
>
> docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/tome-api:<VERSION>
> ```
>
> Then use the ECR URI in the task definition instead of the GHCR one.

---

## 5. SSL Termination on the ALB

SSL terminates at the load balancer. The Fargate task receives plain HTTP on port 3000. Tome already sets `trustProxy: true`, so `X-Forwarded-*` headers are trusted correctly.

### Request or Import a Certificate

If you don't already have a certificate on the ALB:

1. Open **AWS Certificate Manager** (ACM) in the same region as the ALB.
2. Click **Request a public certificate**.
3. Enter your domain (e.g., `logs.yourdomain.com`).
4. Validate via DNS (add the CNAME record ACM provides to your DNS).
5. Wait for status to show **Issued**.

### Configure the ALB Listener

1. In the **EC2 Console**, open your ALB and go to the **Listeners** tab.
2. Add (or edit) an **HTTPS:443** listener:
   - **Default action**: Forward to a new target group (see next section).
   - **Security policy**: `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2+ only).
   - **Default SSL certificate**: Select the ACM certificate from above.
3. If an **HTTP:80** listener exists, set its default action to **Redirect to HTTPS** (301, port 443).

### Create the Target Group

1. **Target type**: IP (required for Fargate awsvpc networking).
2. **Protocol**: HTTP, **Port**: 3000.
3. **Health check**:
   - Path: `/healthz`
   - Protocol: HTTP
   - Healthy threshold: 2
   - Unhealthy threshold: 3
   - Interval: 15s
   - Timeout: 5s

---

## 6. Create the ECS Service

### Security Groups

Create a security group for the Fargate tasks (`tome-tasks-sg`):

| Rule | Type | Port | Source |
|------|------|------|--------|
| Inbound | TCP | 3000 | ALB security group |
| Outbound | TCP | 5432 | RDS security group |
| Outbound | TCP | 587 | `0.0.0.0/0` (SMTP) |
| Outbound | TCP | 443 | `0.0.0.0/0` (GHCR pull, Secrets Manager, CloudWatch) |

Update the **RDS security group** to allow inbound TCP 5432 from `tome-tasks-sg`.

### Deploy the Service

```bash
aws ecs create-service \
  --cluster <CLUSTER_NAME> \
  --service-name tome-api \
  --task-definition tome-api \
  --desired-count 2 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={
    subnets=[<PRIVATE_SUBNET_1>,<PRIVATE_SUBNET_2>],
    securityGroups=[<TOME_TASKS_SG>],
    assignPublicIp=DISABLED
  }" \
  --load-balancers "targetGroupArn=<TARGET_GROUP_ARN>,containerName=tome-api,containerPort=3000" \
  --health-check-grace-period-seconds 30 \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100" \
  --enable-execute-command
```

**Notes:**

- **`desired-count: 2`**: Run at least two tasks across different AZs for availability.
- **`assignPublicIp: DISABLED`**: Tasks are in private subnets; outbound traffic goes through a NAT Gateway.
- **`enable-execute-command`**: Allows `aws ecs execute-command` for debugging (requires the task role to allow SSM).
- **`health-check-grace-period-seconds: 30`**: Prevents the ALB from draining tasks before the app is fully started.

---

## 7. Auto Scaling (Optional)

```bash
# Register the service as a scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/<CLUSTER_NAME>/tome-api \
  --min-capacity 2 \
  --max-capacity 10

# Scale on CPU utilization
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/<CLUSTER_NAME>/tome-api \
  --policy-name tome-cpu-scaling \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    },
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

If you scale beyond 4 tasks, increase the RDS `max_connections` parameter. Each Tome instance opens up to 25 database connections.

---

## 8. DNS

Create a DNS record pointing to the ALB:

| Type | Name | Value |
|------|------|-------|
| CNAME (or Alias) | `logs.yourdomain.com` | ALB DNS name (e.g., `tome-alb-123456.us-east-1.elb.amazonaws.com`) |

If you use Route 53 in the same account, prefer an **Alias** record to the ALB (no extra charge, supports zone apex).

---

## 9. Verify the Deployment

```bash
# Health check
curl https://logs.yourdomain.com/healthz
# Expected: {"status":"ok"}

# Ingest a test record (replace with your admin key)
curl -X POST https://logs.yourdomain.com/records \
  -H "Content-Type: application/json" \
  -H "x-api-key: <ADMIN_KEY>" \
  -d '{
    "timestamp": "2026-04-09T12:00:00Z",
    "level": "info",
    "collection": "deployment-test",
    "message": "Fargate deployment verified"
  }'

# Query it back
curl "https://logs.yourdomain.com/records?collection=deployment-test" \
  -H "x-api-key: <ADMIN_KEY>"

# Prometheus metrics
curl https://logs.yourdomain.com/metrics \
  -H "x-api-key: <ADMIN_KEY>"
```

---

## 10. Ongoing Operations

### Deploying a New Version

Update the image tag in the task definition and trigger a rolling deployment:

```bash
aws ecs update-service \
  --cluster <CLUSTER_NAME> \
  --service tome-api \
  --force-new-deployment
```

The `minimumHealthyPercent=100` / `maximumPercent=200` configuration ensures zero-downtime rolling updates. ECS will start new tasks, wait for them to pass ALB health checks, then drain the old ones.

### Monitoring

- **Application logs**: CloudWatch Logs group `/ecs/tome-api`
- **Metrics**: Tome exposes a Prometheus `/metrics` endpoint with counters by log level, collection, and alert status. Point your Prometheus scraper or CloudWatch Agent at the ALB endpoint.
- **RDS**: Monitor `DatabaseConnections`, `FreeableMemory`, and `ReadLatency` in the RDS console.
- **ALB**: Watch `TargetResponseTime`, `HTTP_5XX_Count`, and `HealthyHostCount` in the ALB metrics.

### Database Backups

RDS automated backups handle point-in-time recovery. For ad-hoc exports:

```bash
# From a bastion or via ECS Exec
pg_dump "postgresql://logger:<PASSWORD>@<RDS_ENDPOINT>:5432/logs" -Fc -f tome-backup.dump
```

### ECS Exec (Debugging)

```bash
aws ecs execute-command \
  --cluster <CLUSTER_NAME> \
  --task <TASK_ID> \
  --container tome-api \
  --interactive \
  --command "/bin/sh"
```
