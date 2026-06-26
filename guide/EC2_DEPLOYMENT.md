# EC2 Deployment Guide

Deploy chat-analyzer to AWS EC2 with RDS PostgreSQL, nginx, and Let's Encrypt TLS.

**Prerequisites:** AWS account · domain you control · project working locally with `docker compose up`

---

## Architecture

```
Internet
   │
   ▼
DNS (yourdomain.com → Elastic IP)
   │
   ▼
EC2 t3.small
│  nginx :443 (TLS termination)
│    ├── /          → /var/www/html  (React static files)
│    └── /api/*     → 127.0.0.1:8000 (backend container)
│  Docker: backend container (prod target)
└─────────────────────────────────────────
        │  private VPC
        ▼
RDS PostgreSQL (private subnet, not internet-accessible)
```

---

## Quick re-deploy reference

After initial setup, a new release is:

```bash
cd /opt/chat-analyzer/repo && git pull

# backend
docker build -t chat-analyzer-backend:latest ./backend --target prod
docker run --rm --env-file backend/.env chat-analyzer-backend:latest alembic upgrade head
docker stop chat-analyzer-backend && docker rm chat-analyzer-backend
docker run -d --name chat-analyzer-backend --restart unless-stopped \
  --env-file backend/.env -p 127.0.0.1:8000:8000 chat-analyzer-backend:latest

# frontend
cd frontend && npm ci && VITE_API_URL= npm run build
sudo rm -rf /var/www/html/* && sudo cp -r dist/. /var/www/html/
sudo chown -R nginx:nginx /var/www/html && sudo chmod -R 755 /var/www/html
```

---

## Step 1 — Provision EC2 with an Elastic IP

### 1.1 Launch the instance

1. EC2 → **Launch instance**
2. Name: `chat-analyzer-prod`
3. AMI: **Amazon Linux 2023** (64-bit x86) — has SSM agent pre-installed, Docker in `dnf`
4. Instance type: **t3.small** (2 vCPU, 2 GB RAM)
5. Key pair: **Proceed without a key pair** — connect via SSM Session Manager, no SSH needed
6. Security group — create `chat-analyzer-ec2-sg`:
   - No SSH rule (port 22 never needs to be open)
   - Inbound: HTTP port 80, source **Anywhere** — required for certbot ACME challenge
   - Inbound: HTTPS port 443, source **Anywhere**
   - Do NOT open port 8000 publicly — backend is only reachable through nginx
   - Outbound: All traffic, destination **Anywhere** — required for SSM agent and package pulls
7. **Advanced details → IAM instance profile** → Create new IAM role:
   - Trusted entity: EC2
   - Policy: `AmazonSSMManagedInstanceCore`
   - Role name: `chat-analyzer-ec2-ssm-role`
   - Select the new role from the dropdown
8. Storage: 20 GB gp3
9. **Launch instance**

### 1.2 Allocate and associate an Elastic IP

A static public IP that survives instance restarts. Without it, EC2 assigns a new IP on every start, breaking DNS.

1. EC2 → **Elastic IPs** → **Allocate Elastic IP address**
2. Select the new IP → **Actions → Associate Elastic IP address** → choose `chat-analyzer-prod`
3. Note the IP — you will point your domain at it next

### 1.3 Point your domain at the Elastic IP

In your DNS provider (Route 53, Cloudflare, Namecheap, etc.):

- A record: `yourdomain.com` → Elastic IP
- A record: `www.yourdomain.com` → same Elastic IP
- TTL: **300 seconds**

Verify propagation:

```bash
dig +short yourdomain.com
# should return your Elastic IP
```

### 1.4 Connect via SSM Session Manager

1. EC2 → **Instances** → select `chat-analyzer-prod` → **Connect**
2. **Session Manager** tab → **Connect**

A browser terminal opens as `ssm-user`. The SSM agent starts automatically on boot — if the tab is greyed out, wait 60 seconds and refresh. If it still fails, check the IAM role: **Actions → Security → Modify IAM role**.

> **Code deploys:** Push to git and `git pull` on the server. No rsync or SCP needed.

---

## Step 2 — Install server dependencies

```bash
sudo dnf update -y
sudo dnf install -y git

# Docker
sudo dnf install -y docker
sudo systemctl enable docker --now
sudo usermod -aG docker ssm-user
# reconnect the SSM session after this so docker group takes effect

# nginx
sudo dnf install -y nginx
sudo systemctl enable nginx --now

# certbot (isolated virtualenv to avoid conflicts with system Python)
sudo dnf install -y python3 augeas-libs
sudo python3 -m venv /opt/certbot/
sudo /opt/certbot/bin/pip install --upgrade pip
sudo /opt/certbot/bin/pip install certbot certbot-nginx
sudo ln -s /opt/certbot/bin/certbot /usr/bin/certbot

# psql client (to verify RDS connection)
sudo dnf install -y postgresql15
```

---

## Step 3 — Create RDS PostgreSQL

### 3.1 Create the instance

1. RDS → **Create database**
2. Engine: **PostgreSQL 17**, Template: **Free tier** (db.t3.micro, 20 GB)
3. Identifier: `chat-analyzer-prod`
4. Master username: `chat_user` · Master password: generate a strong one, store in a password manager
5. **Connectivity:**
   - VPC: your default VPC
   - DB subnet group: create new, select at least two subnets in different AZs
   - **Public access: No** — RDS must not be internet-reachable
   - VPC security group: create new named `chat-analyzer-rds-sg`
6. **Additional configuration:**
   - Initial database name: `chat_analyzer`
   - Automated backups: enabled, 7-day retention
   - Deletion protection: enabled

### 3.2 Open the RDS security group to EC2

1. EC2 → Security Groups → `chat-analyzer-rds-sg` → **Edit inbound rules**
2. Add: PostgreSQL / port 5432 / source = `chat-analyzer-ec2-sg` (the EC2 security group, not an IP)

This allows only traffic from your EC2 instance on port 5432. No other source can connect.

### 3.3 Verify the connection from EC2

Once RDS status is **Available**, get the endpoint from the RDS console (`chat-analyzer-prod.xxxx.us-east-1.rds.amazonaws.com`).

```bash
psql -h your-rds-endpoint.rds.amazonaws.com -U chat_user -d chat_analyzer
# enter master password — you should get a psql prompt
\q
```

If this fails: check the RDS inbound rule references the EC2 security group (not an IP), and both instances are in the same VPC.

---

## Step 4 — Configure nginx (HTTP first)

Certbot needs nginx serving HTTP before it can issue a certificate. Set up HTTP, then add HTTPS.

On Amazon Linux 2023 nginx uses `conf.d/` for site configs (no `sites-available`/`sites-enabled`):

```bash
sudo nano /etc/nginx/conf.d/yourdomain.com.conf
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    root /var/www/html;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo mkdir -p /var/www/html
sudo nginx -t                  # must print "syntax is ok" and "test is successful"
sudo systemctl reload nginx

curl http://yourdomain.com     # any response confirms nginx is up
```

---

## Step 5 — Obtain a TLS certificate with certbot

TLS terminates at nginx so the backend never handles it. The `secure=True` flag on the refresh cookie requires HTTPS — without it the browser silently drops the cookie.

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot verifies domain ownership via `http://yourdomain.com/.well-known/acme-challenge/...`, issues a Let's Encrypt certificate, and automatically adds the HTTPS server block to your nginx config.

### Auto-renewal

Let's Encrypt certificates expire after 90 days. The pip-installed certbot does not set up auto-renewal automatically — do it manually:

```bash
sudo mkdir -p /etc/cron.d
echo "0 0,12 * * * root certbot renew -q" | sudo tee /etc/cron.d/certbot

# verify and dry-run
sudo cat /etc/cron.d/certbot
sudo certbot renew --dry-run   # should print "all simulated renewals succeeded"
```

```bash
curl https://yourdomain.com    # no certificate error
```

---

## Step 6 — Clone the repo and create the environment file

```bash
sudo mkdir -p /opt/chat-analyzer
sudo chown ssm-user:ssm-user /opt/chat-analyzer
git clone https://github.com/youruser/chat-analyzer.git /opt/chat-analyzer/repo
cd /opt/chat-analyzer/repo
```

Generate a JWT secret:

```bash
openssl rand -hex 32
```

Create `backend/.env` (never commit this file — it is in `.gitignore`):

```bash
nano /opt/chat-analyzer/repo/backend/.env
```

```env
ENVIRONMENT=production
APP_NAME=chat-analyzer
APP_DEBUG=false

DATABASE_URL=postgresql+asyncpg://chat_user:YOUR_RDS_PASSWORD@your-rds-endpoint.rds.amazonaws.com:5432/chat_analyzer

JWT_SECRET_KEY=<openssl rand -hex 32 output>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

```bash
chmod 600 /opt/chat-analyzer/repo/backend/.env
```

---

## Step 7 — Deploy the backend container

```bash
cd /opt/chat-analyzer/repo

# build
docker build -t chat-analyzer-backend:latest ./backend --target prod

# run migrations (one-off before every deploy)
docker run --rm --env-file backend/.env chat-analyzer-backend:latest alembic upgrade head

# start
docker run -d --name chat-analyzer-backend --restart unless-stopped \
  --env-file backend/.env \
  -p 127.0.0.1:8000:8000 \
  chat-analyzer-backend:latest
```

`-p 127.0.0.1:8000:8000` binds only to localhost — the backend is not reachable from the internet directly. `--restart unless-stopped` restarts the container on crash or server reboot.

### Verify

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}

curl https://yourdomain.com/api/auth/
# 404 or 405, not a connection error

docker logs chat-analyzer-backend
# gunicorn boot messages, no errors

docker inspect --format='{{.State.Health.Status}}' chat-analyzer-backend
# healthy  (after ~30s)
```

---

## Step 8 — Build and deploy the frontend

### Install Node.js (one-time)

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version   # v22.x.x
```

### Build and copy

```bash
cd /opt/chat-analyzer/repo/frontend
npm ci
VITE_API_URL= npm run build
```

`VITE_API_URL` must be empty so Axios uses relative paths (`/api/...`). nginx proxies those to the backend.

```bash
sudo rm -rf /var/www/html/*
sudo cp -r /opt/chat-analyzer/repo/frontend/dist/. /var/www/html/

# nginx on Amazon Linux 2023 runs as the `nginx` user
sudo chown -R nginx:nginx /var/www/html
sudo chmod -R 755 /var/www/html
```

### Verify the full flow

Open `https://yourdomain.com`:

- Register a new account
- Log in — access token stays in JS memory, refresh cookie is HTTPOnly
- Hard-refresh the page — still logged in (bootstrap reads the refresh cookie)
- Log out

In browser DevTools → Network:
- All API calls go to `https://yourdomain.com/api/...` (same origin, no CORS headers needed)
- `Set-Cookie` on login response has `Secure; HttpOnly; SameSite=Lax`

---

## Step 9 — RDS backups

Automated backups should already be on (enabled in Step 3). Verify:

RDS Console → instance → **Maintenance & backups** → Automated backups: Enabled, 7-day retention.

### Manual snapshot before risky migrations

```bash
aws rds create-db-snapshot \
  --db-instance-identifier chat-analyzer-prod \
  --db-snapshot-identifier chat-analyzer-pre-migration-$(date +%Y%m%d)

# wait for "available" before running the migration
aws rds describe-db-snapshots \
  --db-snapshot-identifier chat-analyzer-pre-migration-YYYYMMDD \
  --query 'DBSnapshots[0].Status'
```

### Test restoration once (now, not during an incident)

1. RDS → Snapshots → select snapshot → **Actions → Restore snapshot**
2. New identifier: `chat-analyzer-restore-test`
3. Connect with psql and verify data
4. Delete the test instance immediately — you are billed while it runs

---

## Step 10 — Final validation checklist

Run this from your **phone on mobile data** (not dev machine, not home WiFi):

- [ ] `https://yourdomain.com` loads the app — padlock visible, no cert warning
- [ ] Register a new account
- [ ] Log in — redirected to dashboard
- [ ] Hard-refresh — still logged in
- [ ] Log out — redirected to login, protected routes inaccessible
- [ ] `curl https://yourdomain.com/health` returns `{"status":"ok"}`
- [ ] Port 8000 NOT reachable: `curl http://YOUR_ELASTIC_IP:8000` times out or is refused
- [ ] RDS not public: **Publicly accessible: No** in RDS console

---

## Troubleshooting

**nginx returns 502 on `/api/` routes**

```bash
docker ps                          # is the container running?
docker logs chat-analyzer-backend  # any startup errors?
curl http://127.0.0.1:8000/health  # does the backend respond locally?
```

**Refresh cookie not set (no `Set-Cookie` header)**

`ENVIRONMENT` is not `production` in `backend/.env`. The `secure=True` flag on the cookie is gated on that value. Without `secure=True`, the browser silently drops the cookie on HTTPS.

**`alembic upgrade head` fails: `could not connect to server`**

The RDS inbound rule is wrong. Go back to Step 3.2 — the source must be the EC2 **security group**, not an IP address.

**`alembic upgrade head` fails: `no pg_hba.conf entry ... no encryption`**

RDS requires SSL but the connection is not using it. Two things must both be fixed:

1. `alembic/env.py` creates its own engine — it does not inherit the one from `database.py`. Import `_ssl_context` from `database.py` and pass it to the engine in `env.py`.
2. asyncpg with `ssl=True` fails certificate verification because the AWS RDS CA is not in the container's trust store. Use a custom `ssl.SSLContext` with `CERT_NONE` — the connection is still encrypted, cert verification is skipped. See `database.py:_ssl_context()` for the implementation.

**Frontend blank page after deploy**

React Router uses history mode — nginx must return `index.html` for all non-API routes. Confirm `try_files $uri $uri/ /index.html;` is in the nginx config, then: `sudo nginx -t && sudo systemctl reload nginx`.

**Certificate error immediately after certbot**

DNS has not propagated yet. Check: `dig +short yourdomain.com` must return your Elastic IP before the cert will work.

**Session Manager tab is greyed out**

IAM role not attached or SSM agent not yet registered. Check: **Actions → Security → Modify IAM role** → confirm `chat-analyzer-ec2-ssm-role` is assigned. If the role is correct, wait 1–2 minutes.
