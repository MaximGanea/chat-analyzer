# Phase 5: First Production Deployment

**Goal:** Deploy chat-analyzer to a real server reachable from the internet. By the end you will be able to open your phone (not your dev machine), create an account, log in, and log out.

**Prerequisites:** AWS account, a domain name you control, the project working locally with `docker compose up`.

**Estimated time:** one full day if you have never done this before.

---

## Overview

The final architecture for this phase:

```
Internet
   │
   ▼
DNS (yourdomain.com → Elastic IP)
   │
   ▼
EC2 t3.small  ──────────────────────────────────────────────
│  nginx :443 (TLS termination)                             │
│    ├── /          → /var/www/html (React static files)   │
│    └── /api/*     → localhost:8000 (backend container)   │
│  Docker: backend container (prod target)                  │
└───────────────────────────────────────────────────────────
        │  private network (VPC)
        ▼
RDS PostgreSQL (private subnet, not internet-accessible)
```

---

## Step 1 — Provision EC2 with an Elastic IP

### 1.1 Launch the instance

1. Open the AWS Console → EC2 → **Launch instance**
2. Name: `chat-analyzer-prod`
3. AMI: **Ubuntu Server 24.04 LTS** (64-bit x86)
4. Instance type: **t3.small** (2 vCPU, 2 GB RAM — enough for one gunicorn backend)
5. Key pair: create a new one, download the `.pem` file, save it somewhere safe (`~/.ssh/chat-analyzer.pem`). You will never be able to download it again.
6. Network settings — create a new security group named `chat-analyzer-ec2-sg`:
   - Inbound rule: SSH, port 22, source **My IP** (not 0.0.0.0/0 — only your IP)
   - Inbound rule: HTTP, port 80, source **Anywhere** (0.0.0.0/0) — needed for the certbot challenge
   - Inbound rule: HTTPS, port 443, source **Anywhere**
   - Do NOT open port 8000 publicly — backend must only be reachable via nginx
7. Storage: 20 GB gp3 is enough
8. Click **Launch instance**

### 1.2 Allocate and associate an Elastic IP

An Elastic IP is a static public IP that stays the same even if you stop and restart the instance. Without it, EC2 assigns a new public IP on every start, which would break your DNS record.

1. EC2 → **Elastic IPs** → **Allocate Elastic IP address** → Allocate
2. Select the new IP → **Actions → Associate Elastic IP address**
3. Choose your instance (`chat-analyzer-prod`) → Associate
4. Note the IP address — you will point your domain at it in the next step

### 1.3 Point your domain at the Elastic IP

In your DNS provider (Route 53, Cloudflare, Namecheap, etc.):

- Create an **A record**: `yourdomain.com` → your Elastic IP
- Create another **A record**: `www.yourdomain.com` → same Elastic IP
- Set TTL to **300 seconds** (5 minutes) — low TTL lets you react quickly if you need to change the IP

DNS propagation can take a few minutes. Verify with:

```bash
dig +short yourdomain.com
# should return your Elastic IP
```

### 1.4 SSH into the instance

```bash
chmod 400 ~/.ssh/chat-analyzer.pem
ssh -i ~/.ssh/chat-analyzer.pem ubuntu@YOUR_ELASTIC_IP
```

---

## Step 2 — Install server dependencies

Run these on the EC2 instance:

```bash
sudo apt update && sudo apt upgrade -y

# Docker
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add your user to the docker group so you don't need sudo
sudo usermod -aG docker ubuntu
newgrp docker

# nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# psql client (for testing RDS connection)
sudo apt install -y postgresql-client
```

---

## Step 3 — Create RDS PostgreSQL

### 3.1 Concepts you need to understand first

**VPC (Virtual Private Cloud):** An isolated network inside AWS. Your EC2 and RDS both live inside a VPC. By default AWS creates a default VPC in every region — you can use it for this phase.

**Subnet:** A subdivision of the VPC tied to a specific availability zone (AZ). A VPC has multiple subnets. Subnets are either:
- **Public subnet** — has a route to an Internet Gateway. Resources here can be reached from the internet (with the right security group). Your EC2 is in a public subnet.
- **Private subnet** — no route to the internet. Resources here cannot be reached from the internet at all. Your RDS goes here.

**Security group:** A stateful firewall attached to a resource. It controls which IPs and ports can connect in and out. Security groups can reference other security groups as a source — e.g., "allow port 5432 from the EC2 security group" — which is how you let the backend reach RDS without opening it to the internet.

### 3.2 Create the RDS instance

1. AWS Console → RDS → **Create database**
2. Engine: **PostgreSQL**, version **17**
3. Templates: **Free tier** (db.t3.micro, 20 GB storage) — fine for this phase
4. DB instance identifier: `chat-analyzer-prod`
5. Master username: `chat_user`
6. Master password: generate a strong random password, save it in a password manager. You will put this in `.env.prod` on the server.
7. **Connectivity:**
   - VPC: your default VPC
   - DB subnet group: create new — select **at least two subnets in different AZs** (required by RDS). Click **Create DB subnet group**.
   - Public access: **No** — this is important. RDS must not be reachable from the internet.
   - VPC security group: create a new one named `chat-analyzer-rds-sg`
   - Availability zone: no preference
8. **Additional configuration:**
   - Initial database name: `chat_analyzer`
   - Automated backups: **enable**, retention 7 days (covered in Step 6)
   - Deletion protection: **enable** — prevents accidental `terraform destroy` or console click
9. Click **Create database** — this takes about 5 minutes

### 3.3 Open the RDS security group to EC2

By default the new `chat-analyzer-rds-sg` has no inbound rules.

1. EC2 → Security Groups → find `chat-analyzer-rds-sg` → **Edit inbound rules**
2. Add rule:
   - Type: PostgreSQL
   - Port: 5432
   - Source: **Custom** → search for `chat-analyzer-ec2-sg` (the EC2 security group, not the IP)
3. Save

This means only traffic originating from your EC2 instance can reach port 5432 on RDS. No other source — including the internet — can connect.

### 3.4 Verify the connection from EC2

Once RDS status is **Available**, grab the endpoint from the RDS console (looks like `chat-analyzer-prod.xxxx.us-east-1.rds.amazonaws.com`).

SSH into EC2 and run:

```bash
psql -h your-rds-endpoint.rds.amazonaws.com -U chat_user -d chat_analyzer
# enter the master password when prompted
# you should get a psql prompt: chat_analyzer=>
\q
```

If this fails:
- Check that the RDS security group inbound rule references the EC2 security group (not an IP)
- Check that your EC2 instance is in the same VPC as the RDS instance
- Check that the RDS instance is not in a subnet that has no route to the EC2 subnet

---

## Step 4 — Configure nginx (HTTP first)

Certbot needs nginx to already be running and serving HTTP before it can issue a certificate. Set up HTTP first, then add HTTPS.

Create the nginx site config:

```bash
sudo nano /etc/nginx/sites-available/yourdomain.com
```

Paste this (replace `yourdomain.com` with your actual domain):

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    root /var/www/html;
    index index.html;

    # Proxy all /api/* requests to the backend container
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Serve the React SPA — all non-API routes return index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable the site and test:

```bash
sudo ln -s /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t          # must print "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

Verify nginx is serving HTTP (not yet HTTPS):

```bash
curl http://yourdomain.com
# should return the default nginx page or a 404 — any response means nginx is up
```

---

## Step 5 — Obtain a TLS certificate with certbot

### Why TLS termination belongs at nginx (the edge)

TLS termination means decrypting HTTPS traffic and forwarding plain HTTP internally. nginx does this at the edge so:

- The backend never handles TLS — one less thing to configure and rotate
- Internal traffic (nginx → backend) stays on localhost, so plain HTTP is safe
- Certificate renewal is managed in one place (certbot + nginx)
- The `secure=True` flag on the refresh cookie requires HTTPS — without TLS, the cookie will not be set

### Run certbot

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot will:
1. Verify you own the domain by making a request to `http://yourdomain.com/.well-known/acme-challenge/...` — this is why nginx must be running first
2. Issue a certificate from Let's Encrypt (free, trusted by all browsers)
3. Automatically modify your nginx config to add the HTTPS server block and redirect HTTP → HTTPS

After certbot finishes, your nginx config will have a second `server` block for port 443 with `ssl_certificate` lines added. You do not need to edit it manually.

### Verify auto-renewal

Let's Encrypt certificates expire after 90 days. Certbot installs a systemd timer to renew automatically:

```bash
sudo systemctl status certbot.timer
# should show "active (waiting)"

# dry run to confirm renewal works without actually issuing a new cert:
sudo certbot renew --dry-run
# should print "Congratulations, all simulated renewals succeeded"
```

### Test HTTPS

```bash
curl https://yourdomain.com
# should return a response (not a certificate error)
```

Open `https://yourdomain.com` in a browser — you should see a padlock and no certificate warning.

---

## Step 6 — Create the environment file on the server

On the EC2 instance, create the production env file for the backend. Never commit this file to git.

```bash
sudo mkdir -p /opt/chat-analyzer
sudo nano /opt/chat-analyzer/.env.prod
```

Contents (fill in real values):

```env
ENVIRONMENT=production
APP_NAME=chat-analyzer
APP_DEBUG=false

DATABASE_URL=postgresql+asyncpg://chat_user:YOUR_RDS_PASSWORD@your-rds-endpoint.rds.amazonaws.com:5432/chat_analyzer

JWT_SECRET_KEY=<output of: openssl rand -hex 32>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

Restrict permissions — this file contains secrets:

```bash
sudo chmod 600 /opt/chat-analyzer/.env.prod
sudo chown root:root /opt/chat-analyzer/.env.prod
```

Generate a strong JWT secret locally and paste it in:

```bash
openssl rand -hex 32
```

---

## Step 7 — Deploy the backend container

### 7.1 Copy the backend to the server

On your **local machine**, copy the backend source:

```bash
rsync -avz --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' \
  backend/ ubuntu@YOUR_ELASTIC_IP:/opt/chat-analyzer/backend/
```

Or clone the repo on the server directly:

```bash
# on EC2:
git clone https://github.com/youruser/chat-analyzer.git /opt/chat-analyzer/repo
```

### 7.2 Build the prod image on the server

```bash
# on EC2, from the directory containing the backend source:
cd /opt/chat-analyzer/repo    # or wherever your code is

docker build -t chat-analyzer-backend:latest ./backend --target prod
```

### 7.3 Run migrations before starting the container

This is a one-off command that runs Alembic against the real RDS database. Run it once before every deploy:

```bash
docker run --rm \
  --env-file /opt/chat-analyzer/.env.prod \
  chat-analyzer-backend:latest \
  alembic upgrade head
```

Expected output ends with something like:
```
INFO  [alembic.runtime.migration] Running upgrade  -> abc123, create users table
INFO  [alembic.runtime.migration] Running upgrade abc123 -> def456, create refresh_sessions table
```

If you see `FAILED` check that the `DATABASE_URL` in `.env.prod` is correct and the RDS security group allows port 5432 from the EC2 instance.

### 7.4 Start the backend container

```bash
docker run -d \
  --name chat-analyzer-backend \
  --restart unless-stopped \
  --env-file /opt/chat-analyzer/.env.prod \
  -p 127.0.0.1:8000:8000 \
  chat-analyzer-backend:latest
```

Key flags:
- `-p 127.0.0.1:8000:8000` — binds port 8000 on **localhost only**, not on all interfaces. This means the backend is not reachable from the internet directly, only via nginx (which runs on the same machine).
- `--restart unless-stopped` — Docker restarts the container if it crashes or the server reboots

### 7.5 Verify the health endpoint

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}

# also check via the domain (goes through nginx):
curl https://yourdomain.com/api/auth/   # should return 404 or 405, not a connection error
```

Check container logs:

```bash
docker logs chat-analyzer-backend
# should show gunicorn worker boot messages, no errors
```

Check Docker healthcheck status:

```bash
docker inspect --format='{{.State.Health.Status}}' chat-analyzer-backend
# should print: healthy  (after ~30s)
```

---

## Step 8 — Build and deploy the frontend

### 8.1 Build on your local machine

`VITE_API_URL` must be empty so that Axios uses relative paths (`/api/...`). nginx on the server will proxy those to the backend.

```bash
# in frontend/
VITE_API_URL= npm run build
```

Or set it in `frontend/.env.production`:

```env
VITE_API_URL=
```

Then run `npm run build`. The output is in `frontend/dist/`.

### 8.2 Upload to the server

```bash
rsync -avz --delete frontend/dist/ ubuntu@YOUR_ELASTIC_IP:/var/www/html/
```

`--delete` removes files on the server that no longer exist in the local build, so stale chunks from a previous deploy don't linger.

### 8.3 Set correct permissions

```bash
# on EC2:
sudo chown -R www-data:www-data /var/www/html
sudo chmod -R 755 /var/www/html
```

### 8.4 Verify the full flow

Open `https://yourdomain.com` in your browser. You should see the login page.

- Register a new account
- Log in — the access token stays in memory, the refresh cookie is set as HTTPOnly
- Refresh the page — you should still be logged in (bootstrap reads the refresh cookie)
- Log out

Also open browser DevTools → Network tab and confirm:
- All API calls go to `https://yourdomain.com/api/...` (same origin, no CORS)
- The `Set-Cookie` header on the login response has `Secure; HttpOnly; SameSite=Lax`

---

## Step 9 — Set up automated RDS backups and snapshots

### The difference between automated backups and manual snapshots

| | Automated backup | Manual snapshot |
|---|---|---|
| Created by | RDS on a schedule | You (or a script) on demand |
| Retention | 1–35 days, configurable | Until you delete it |
| Deleted with instance | Yes, unless you copy them first | No — survives instance deletion |
| Point-in-time restore | Yes (any second within retention window) | No (snapshot is a fixed point in time) |
| Use case | Daily safety net, PITR | Before a risky migration, before deleting the instance |

### Enable automated backups (should already be on)

If you followed Step 3, automated backups are already enabled with 7-day retention. Verify:

1. RDS Console → your instance → **Maintenance & backups** tab
2. Confirm **Automated backups** is Enabled, retention period is 7 days
3. Note the backup window — choose a time when traffic is lowest (e.g., 03:00–04:00 UTC)

### Take a manual snapshot before risky operations

Before any migration that drops or renames columns:

```bash
# AWS CLI — create a manual snapshot:
aws rds create-db-snapshot \
  --db-instance-identifier chat-analyzer-prod \
  --db-snapshot-identifier chat-analyzer-pre-migration-$(date +%Y%m%d)
```

Wait for the snapshot status to become `available` before running the migration:

```bash
aws rds describe-db-snapshots \
  --db-snapshot-identifier chat-analyzer-pre-migration-YYYYMMDD \
  --query 'DBSnapshots[0].Status'
```

### Test backup restoration (do this now, not during an incident)

1. RDS → Snapshots → select a snapshot → **Actions → Restore snapshot**
2. Give it a new instance identifier: `chat-analyzer-restore-test`
3. After it's available, connect with psql and run a query to confirm data is intact
4. Delete the test instance immediately after — you are billed for it while it runs

---

## Step 10 — Final validation checklist

Do this from your **phone on mobile data** — not your dev machine, not your home WiFi:

- [ ] `https://yourdomain.com` loads the app (padlock visible, no certificate warning)
- [ ] Register a new account
- [ ] Log in — redirected to the dashboard
- [ ] Hard refresh the page — still logged in
- [ ] Log out — redirected to login, cannot access protected routes
- [ ] `curl https://yourdomain.com/health` returns `{"status":"ok"}`
- [ ] Port 8000 is NOT reachable: `curl http://YOUR_ELASTIC_IP:8000` should time out or be refused
- [ ] RDS is not publicly accessible: confirm **Publicly accessible: No** in the RDS console

---

## Common problems

**nginx returns 502 Bad Gateway on `/api/` routes**

The backend container is not running or is not listening on `127.0.0.1:8000`. Check:

```bash
docker ps                          # is the container running?
docker logs chat-analyzer-backend  # any startup errors?
curl http://127.0.0.1:8000/health  # does the backend respond locally?
```

**Refresh cookie is not being set (no `Set-Cookie` header)**

`ENVIRONMENT` is not set to `production` in `.env.prod`. The `secure=True` flag on the cookie is gated on that env var (`auth.py`). Without `secure=True`, the browser silently drops the cookie on HTTPS connections.

**`alembic upgrade head` fails with `could not connect to server`**

The RDS security group inbound rule is not correctly referencing the EC2 security group. Go back to Step 3.3 and check the rule source is the **security group ID** of the EC2 instance, not an IP address.

**Frontend shows a blank page after deploy**

The React router is using history mode — nginx must return `index.html` for all non-API routes. Check the `try_files $uri $uri/ /index.html;` line is in the nginx config and that you ran `sudo nginx -t && sudo systemctl reload nginx` after any config change.

**`curl https://yourdomain.com` returns a certificate error immediately after certbot**

DNS has not propagated yet. Wait a few minutes and try again. You can check with `dig +short yourdomain.com` — it should return your Elastic IP before the cert will work.
