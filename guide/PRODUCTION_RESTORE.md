# Production Teardown and Restore

How to shut the paid half of the stack down, and how to bring it back from nothing.

---

## Scope

**Deleted** (~$35/month):

| Resource | Note |
|---|---|
| RDS `temple-project-prod` | deleted without a final snapshot — all data gone |
| EC2 `temple-project-prod` | terminated, no AMI kept |
| Elastic IP | released |
| EBS root volume | destroyed with the instance |

**Kept** (~$0.55/month):

| Resource | Cost | Why |
|---|---|---|
| Route 53 hosted zone | $0.50 | DNS for the domain |
| S3 `temple-project-frontend` | ~$0.01 | the React build |
| CloudFront distribution + `spa-router` function | $0 | free tier |
| ACM certificate (`us-east-1`) | $0 | auto-renews |
| ECR `temple-project-backend` | ~$0.05 | last image, avoids rebuilding registry setup |
| IAM role `github-actions-temple-project-role` + GitHub OIDC provider | $0 | pipeline auth |
| GitHub environment secrets | $0 | `AWS_ROLE_ARN`, `EC2_INSTANCE_ID`, `CLOUDFRONT_DISTRIBUTION_ID` |

**State while torn down:** `https://temple-project.net` loads normally from S3. Any API call returns 502 — there is no origin behind `/api/*`. Pushing to `master` still deploys the frontend; the `migrate` and `deploy-backend` jobs fail because SSM has no instance to reach.

---

## Teardown

Order matters only in that RDS deletion protection must be turned off before RDS can be deleted.

### 1. RDS

1. RDS → Databases → `temple-project-prod` → **Modify** → uncheck **Deletion protection** → Apply immediately
2. **Actions → Delete**
3. Uncheck **Create final snapshot** and uncheck **Retain automated backups**
4. Type the confirmation phrase → Delete

Automated backups are deleted with the instance when retention is unchecked. Nothing recoverable remains.

### 2. EC2

EC2 → Instances → `temple-project-prod` → **Instance state → Terminate instance**.

The root volume is set to delete on termination. `/opt/temple-project/repo/backend/.env` goes with it — the JWT secret and the RDS password are gone, which is fine since both are regenerated on restore.

### 3. Elastic IP

EC2 → Elastic IPs → select → **Actions → Release Elastic IP address**.

An unassociated Elastic IP bills at ~$3.60/month, so this must not be skipped.

### 4. Verify nothing is left running

```bash
aws ec2 describe-instances --region eu-central-1 \
  --filters "Name=instance-state-name,Values=running,stopped" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text

aws rds describe-db-instances --region eu-central-1 \
  --query 'DBInstances[].DBInstanceIdentifier' --output text

aws ec2 describe-addresses --region eu-central-1 \
  --query 'Addresses[].PublicIp' --output text
```

All three should return nothing. Then set a budget alarm: **Billing → Budgets → Create budget** → Monthly cost, $5, email notification.

---

## Restore

~40 minutes, most of it waiting on RDS. Steps 1 and 2 can run in parallel.

### 1. RDS

RDS → **Create database**:

| Field | Value |
|---|---|
| Engine | PostgreSQL 17 |
| Template | Free tier (or Dev/Test → `db.t4g.micro`, 20 GB gp3) |
| DB instance identifier | `temple-project-prod` |
| Master username | `temple_user` |
| Master password | generate, store in a password manager |
| VPC | default |
| Public access | **No** |
| VPC security group | create new: `temple-project-rds-sg` |
| Initial database name | `temple_project` (under Additional configuration) |
| Automated backups | enabled, 7-day retention |
| Deletion protection | enabled |

Creation takes 5–10 minutes. Copy the endpoint when status reaches **Available** — it is needed in step 5.

### 2. EC2

EC2 → **Launch instance**:

| Field | Value |
|---|---|
| Name | `temple-project-prod` |
| AMI | Amazon Linux 2023, 64-bit x86 |
| Instance type | `t3.small` |
| Key pair | **Proceed without a key pair** — access is via SSM |
| Storage | 20 GB gp3 |

Security group — create `temple-project-ec2-sg`:

- Inbound: **HTTP 80 from `0.0.0.0/0`** — CloudFront connects over plain HTTP
- No port 22, no port 443, no port 8000
- Outbound: all traffic

**Advanced details → IAM instance profile** → create role `temple-project-ec2-ssm-role` with:

- `AmazonSSMManagedInstanceCore` — otherwise Session Manager and the whole CD pipeline cannot reach the instance
- `AmazonEC2ContainerRegistryReadOnly` — the `migrate` and `deploy-backend` jobs run `aws ecr get-login-password` **on the instance**, using its own role, not the GitHub role

Missing the second policy is the most common restore failure: SSM connects, the deploy runs, and `docker pull` fails with `no basic auth credentials`.

Launch, then note the **instance ID**.

### 3. Elastic IP

EC2 → Elastic IPs → **Allocate** → select it → **Actions → Associate** → the new instance.

### 4. RDS security group

EC2 → Security Groups → `temple-project-rds-sg` → **Edit inbound rules** → add:

- Type PostgreSQL, port 5432, source = **`temple-project-ec2-sg`** (the security group, not an IP)

### 5. Server setup

EC2 → instance → **Connect → Session Manager → Connect**. If the tab is greyed out, wait 60 seconds — the SSM agent registers on boot.

```bash
sudo dnf update -y
sudo dnf install -y git docker nginx postgresql15

sudo systemctl enable docker --now
sudo systemctl enable nginx --now
sudo usermod -aG docker ssm-user
```

Reconnect the session so the docker group takes effect.

nginx config — the frontend is on S3, so this proxies `/api/` and nothing else:

```bash
sudo nano /etc/nginx/conf.d/temple-project.net.conf
```

```nginx
server {
    listen 80;
    server_name temple-project.net www.temple-project.net origin.temple-project.net;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Repo and environment file — the CD pipeline mounts `/opt/temple-project/repo/backend/.env` into the container, so this exact path must exist:

```bash
sudo mkdir -p /opt/temple-project
sudo chown ssm-user:ssm-user /opt/temple-project
git clone https://github.com/MaximGanea/temple-project.git /opt/temple-project/repo

openssl rand -hex 32          # copy the output for JWT_SECRET_KEY
nano /opt/temple-project/repo/backend/.env
```

```env
ENVIRONMENT=production
APP_NAME=temple-project
APP_DEBUG=false

DATABASE_URL=postgresql+asyncpg://temple_user:RDS_PASSWORD@NEW_RDS_ENDPOINT:5432/temple_project
DATABASE_SSL=true

JWT_SECRET_KEY=OPENSSL_OUTPUT
JWT_ALGORITHM=HS256
JWT_ACCESS_TOKEN_MINUTES=15
JWT_REFRESH_TOKEN_DAYS=7

CORS_ALLOWED_ORIGINS=https://temple-project.net,https://www.temple-project.net
```

```bash
chmod 600 /opt/temple-project/repo/backend/.env
psql -h NEW_RDS_ENDPOINT -U temple_user -d temple_project -c '\q'   # must connect
```

`ENVIRONMENT=production` is not cosmetic: the `secure=True` flag on the refresh cookie is gated on it, and without it the browser silently drops the cookie.

### 6. DNS

Route 53 → hosted zone `temple-project.net` → `origin.temple-project.net` → **Edit record** → set the value to the new Elastic IP, TTL 300.

Leave the apex and `www` alias records alone — they point at CloudFront and did not change.

```bash
dig +short origin.temple-project.net @8.8.8.8    # the new Elastic IP
```

### 7. GitHub secret

Repo → Settings → Environments → `production` → update **`EC2_INSTANCE_ID`** to the new instance ID.

`AWS_ROLE_ARN` and `CLOUDFRONT_DISTRIBUTION_ID` are unchanged — the IAM role and the distribution survived teardown.

### 8. Deploy

Push to `master`, or Actions → the latest CD run → **Re-run all jobs**.

The pipeline builds the image, pushes it to ECR, runs `alembic upgrade head` over SSM against the empty database (creating the schema), replaces the container, and syncs the frontend to S3.

### 9. Verify

```bash
curl -i https://temple-project.net/api/health     # 200 {"status":"ok"}
curl -I https://temple-project.net                # 200, server: AmazonS3
```

Then register an account in the browser, log in, hard-refresh on `/dashboard`, log out. The database is empty — every previous account is gone.

---

## Troubleshooting

**`docker pull` fails with `no basic auth credentials`**
The EC2 instance role is missing `AmazonEC2ContainerRegistryReadOnly`. EC2 → instance → Actions → Security → Modify IAM role.

**Session Manager greyed out, CD jobs time out**
The instance role is missing `AmazonSSMManagedInstanceCore`, or the agent has not registered yet. Wait two minutes, then check the role.

**`alembic upgrade head` fails: `could not connect to server`**
The RDS inbound rule source must be the EC2 **security group**, not an IP. See restore step 4.

**`alembic upgrade head` fails: `no pg_hba.conf entry ... no encryption`**
`DATABASE_SSL=true` is missing from `.env`. RDS requires SSL; `database.py:_ssl_context()` builds the context, and `alembic/env.py` imports it.

**API returns 502 through CloudFront**
Check in order: `dig +short origin.temple-project.net` returns the new Elastic IP · security group allows port 80 from anywhere · `sudo systemctl status nginx` · `docker ps` · `curl http://127.0.0.1:8000/api/health` on the instance.

**Login succeeds but the session is lost on refresh**
`ENVIRONMENT` is not `production` in `.env`, so the refresh cookie is sent without `Secure` and the browser drops it over HTTPS.

---

## Related

- `guide/S3_CLOUDFRONT_FRONTEND.md` — how S3, CloudFront, ACM and Route 53 were built. Those resources survive teardown; consult it only if they are ever lost or need changing.
- `guide/GITHUB_ACTIONS_CICD.md` — how the OIDC role, ECR repository and pipeline were set up. Also survives teardown.
