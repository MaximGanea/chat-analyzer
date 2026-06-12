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
3. AMI: **Amazon Linux 2023 AMI** (64-bit x86) — search for "Amazon Linux 2023" in the AMI list. It has the SSM agent pre-installed and running, Docker available in `dnf`, and is AWS-optimized.
4. Instance type: **t3.small** (2 vCPU, 2 GB RAM — enough for one gunicorn backend)
5. Key pair: select **Proceed without a key pair** — you will connect exclusively via SSM Session Manager (browser terminal), which does not use SSH keys.
6. Network settings — create a new security group named `chat-analyzer-ec2-sg`:
   - No SSH rule — you connect via SSM, which tunnels through IAM. Port 22 never needs to be open.
   - Inbound rule: HTTP, port 80, source **Anywhere** (0.0.0.0/0) — required for the certbot ACME challenge
   - Inbound rule: HTTPS, port 443, source **Anywhere**
   - Do NOT open port 8000 publicly — the backend must only be reachable through nginx
   - Outbound rule: All traffic, destination **Anywhere** (0.0.0.0/0) — required for the SSM agent to reach AWS endpoints, and for the instance to pull packages and Docker images. AWS adds this by default but verify it is present — if missing the Session Manager tab will be greyed out and no outbound connections will work.
7. IAM instance profile — scroll down to **Advanced details**:
   - **IAM instance profile** → **Create new IAM role**
   - Trusted entity: **EC2**
   - Attach the `AmazonSSMManagedInstanceCore` managed policy
   - Role name: `chat-analyzer-ec2-ssm-role` → Create
   - Back in the launch wizard, select the new role from the **IAM instance profile** dropdown
   - This lets the SSM agent communicate with the SSM service. Without it, the Session Manager tab will be greyed out.
8. Storage: 20 GB gp3 is enough
9. Click **Launch instance**

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

### 1.4 Connect to the instance via SSM (AWS console)

No SSH client, no open ports, no static IP needed.

1. EC2 console → **Instances** → select `chat-analyzer-prod`
2. Click **Connect** (top right)
3. Choose the **Session Manager** tab → **Connect**

A browser terminal opens directly on the instance as `ssm-user`. This is your main way to run commands on the server throughout this guide.

On Amazon Linux 2023 the SSM agent starts automatically on boot, so this should work within 30–60 seconds of the instance reaching the "running" state. If the tab is greyed out, wait another minute and refresh. If it still fails, confirm the IAM role is attached: EC2 → Instance → **Actions → Security → Modify IAM role**.

> **File transfers:** Push your code to a git repository and `git pull` on the server — that is the deployment method used in this guide. No rsync or SCP needed.

---

## Step 2 — Install server dependencies

Run these commands in your SSM terminal session. All commands use `sudo` because the SSM session runs as `ssm-user`, not root.

```bash
# refresh package metadata and apply any OS security updates
sudo dnf update -y

# git — needed to clone your repo onto the server
sudo dnf install -y git

# Docker — runs the backend container
sudo dnf install -y docker
# enable: start Docker now and automatically on every reboot
sudo systemctl enable docker --now
# add ssm-user to the docker group so docker commands work without sudo
# (takes effect after reconnecting the SSM session)
sudo usermod -aG docker ssm-user

# nginx — sits in front of the backend, proxies /api/* and serves static files for now
sudo dnf install -y nginx
sudo systemctl enable nginx --now

# certbot dependencies:
#   python3      — certbot is a Python tool
#   augeas-libs  — certbot uses augeas to safely edit the nginx config file
sudo dnf install -y python3 augeas-libs
# create an isolated Python environment for certbot so it doesn't conflict with system Python
sudo python3 -m venv /opt/certbot/
# upgrade pip inside that environment
sudo /opt/certbot/bin/pip install --upgrade pip
# install certbot and its nginx plugin inside the environment
sudo /opt/certbot/bin/pip install certbot certbot-nginx
# create a symlink so you can just type `certbot` instead of the full path
# /usr/bin is in the system PATH, so anything here is available as a plain command
sudo ln -s /opt/certbot/bin/certbot /usr/bin/certbot

# psql client — lets you connect to RDS from the server to verify the connection
sudo dnf install -y postgresql15
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
6. Master password: generate a strong random password, save it in a password manager. You will put this in `backend/.env` on the server.
7. **Connectivity:**
   - VPC: your default VPC
   - DB subnet group: create new — select **at least two subnets in different AZs** (required by RDS). Click **Create DB subnet group**.
   - Public access: **No** — this is important. RDS must not be reachable from the internet.
   - VPC security group: create a new one named `chat-analyzer-rds-sg`
   - Availability zone: no preference
8. **Additional configuration:**
   - Initial database name: `chat_analyzer`
   - Automated backups: **enable**, retention 7 days (covered in Step 9)
   - Deletion protection: **enable** — prevents accidental console click or script error
9. Click **Create database** — this takes about 5 minutes

### 3.3 Open the RDS security group to EC2

By default the new `chat-analyzer-rds-sg` has no inbound rules.

1. EC2 → Security Groups → find `chat-analyzer-rds-sg` → **Edit inbound rules**
2. Add rule:
   - Type: PostgreSQL
   - Port: 5432
   - Source: **Custom** → search for `chat-analyzer-ec2-sg` (the EC2 security group, not an IP)
3. Save

This means only traffic originating from your EC2 instance can reach port 5432 on RDS. No other source — including the internet — can connect.

### 3.4 Verify the connection from EC2

Once RDS status is **Available**, grab the endpoint from the RDS console (looks like `chat-analyzer-prod.xxxx.us-east-1.rds.amazonaws.com`).

In your SSM session, run:

```bash
psql -h your-rds-endpoint.rds.amazonaws.com -U chat_user -d chat_analyzer
# enter the master password when prompted
# you should get a psql prompt: chat_analyzer=>
\q
```

If this fails:
- Check that the RDS security group inbound rule references the EC2 security group (not an IP)
- Check that your EC2 instance is in the same VPC as the RDS instance
- Check that the RDS instance is not in a subnet with no route to the EC2 subnet

---

## Step 4 — Configure nginx (HTTP first)

Certbot needs nginx to already be running and serving HTTP before it can issue a certificate. Set up HTTP first, then add HTTPS.

On Amazon Linux 2023, nginx uses `conf.d/` for site configs — there is no `sites-available`/`sites-enabled` pattern. Create your site config directly:

```bash
sudo nano /etc/nginx/conf.d/yourdomain.com.conf
```

Paste this (replace `yourdomain.com` with your actual domain):

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

Create the web root, test, and reload:

```bash
sudo mkdir -p /var/www/html
sudo nginx -t          # must print "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

Verify nginx is serving HTTP:

```bash
curl http://yourdomain.com
# any response (default page, 404) means nginx is up
```

---

## Step 5 — Obtain a TLS certificate with certbot

### Why TLS termination belongs at nginx (the edge)

TLS termination means decrypting HTTPS traffic and forwarding plain HTTP internally. nginx does this at the edge so:

- The backend never handles TLS — one less thing to configure and rotate
- Internal traffic (nginx → backend) stays on localhost, so plain HTTP is safe
- Certificate renewal is managed in one place (certbot + nginx)
- The `secure=True` flag on the refresh cookie requires HTTPS — without TLS, the browser will silently drop the cookie

### Run certbot

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot will:
1. Verify you own the domain by making a request to `http://yourdomain.com/.well-known/acme-challenge/...` — this is why nginx must be running first
2. Issue a certificate from Let's Encrypt (free, trusted by all browsers)
3. Automatically modify your nginx config to add the HTTPS server block and redirect HTTP → HTTPS

After certbot finishes, your nginx config will have a second `server` block for port 443 with `ssl_certificate` lines. You do not need to edit it manually.

### Set up auto-renewal

Let's Encrypt certificates expire after 90 days. The pip-installed certbot does NOT set up auto-renewal automatically — you need to do it manually.

`/etc/cron.d/` does not exist on Amazon Linux 2023 by default, so create it first:

```bash
sudo mkdir -p /etc/cron.d
echo "0 0,12 * * * root certbot renew -q" | sudo tee /etc/cron.d/certbot
```

This runs the renewal check twice a day (midnight and noon). If the certificate is close to expiry certbot renews it automatically, otherwise it skips silently.

Verify it was created and test that renewal works:

```bash
# confirm the cron job exists
sudo cat /etc/cron.d/certbot
# should print: 0 0,12 * * * root certbot renew -q

# dry run — tests renewal without actually issuing a new cert
sudo certbot renew --dry-run
# should print "Congratulations, all simulated renewals succeeded"
```

### Test HTTPS

```bash
curl https://yourdomain.com
# should return a response, not a certificate error
```

Open `https://yourdomain.com` in a browser — you should see a padlock and no certificate warning.

---

## Step 6 — Clone the repo and create the environment file

### 6.1 Clone the repo

```bash
sudo mkdir -p /opt/chat-analyzer
sudo chown ssm-user:ssm-user /opt/chat-analyzer
git clone https://github.com/youruser/chat-analyzer.git /opt/chat-analyzer/repo
cd /opt/chat-analyzer/repo
```

For subsequent deploys, pull the latest:

```bash
cd /opt/chat-analyzer/repo && git pull
```

### 6.2 Create the environment file

The prod Docker run command reads `backend/.env` (relative to the repo root). Never commit this file to git — it is already in `.gitignore`.

First generate a strong JWT secret:

```bash
openssl rand -hex 32
# copy the output — you will paste it as JWT_SECRET_KEY below
```

Then create the file:

```bash
nano /opt/chat-analyzer/repo/backend/.env
```

Contents (fill in real values):

```env
ENVIRONMENT=production
APP_NAME=chat-analyzer
APP_DEBUG=false

DATABASE_URL=postgresql+asyncpg://chat_user:YOUR_RDS_PASSWORD@your-rds-endpoint.rds.amazonaws.com:5432/chat_analyzer

JWT_SECRET_KEY=<paste openssl output here>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

Restrict permissions — this file contains secrets:

```bash
chmod 600 /opt/chat-analyzer/repo/backend/.env
```

---

## Step 7 — Deploy the backend container

### 7.1 Build the prod image

```bash
cd /opt/chat-analyzer/repo
docker build -t chat-analyzer-backend:latest ./backend --target prod
```

### 7.2 Run migrations before starting the container

This is a one-off command that runs Alembic against the real RDS database. Run it once before every deploy:

```bash
cd /opt/chat-analyzer/repo
docker run --rm --env-file backend/.env chat-analyzer-backend:latest alembic upgrade head
```

Expected output ends with something like:
```
INFO  [alembic.runtime.migration] Running upgrade  -> abc123, create users table
INFO  [alembic.runtime.migration] Running upgrade abc123 -> def456, create refresh_sessions table
```

If you see `FAILED` check that the `DATABASE_URL` in `backend/.env` is correct and the RDS security group allows port 5432 from the EC2 instance.

### 7.3 Start the backend container

```bash
cd /opt/chat-analyzer/repo
docker run -d \
  --name chat-analyzer-backend \
  --restart unless-stopped \
  --env-file backend/.env \
  -p 127.0.0.1:8000:8000 \
  chat-analyzer-backend:latest
```

Key flags:
- `-p 127.0.0.1:8000:8000` — binds port 8000 on **localhost only**, not on all interfaces. The backend is not reachable from the internet directly — only via nginx on the same machine.
- `--restart unless-stopped` — Docker restarts the container if it crashes or the server reboots

### 7.4 Verify the health endpoint

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

### 8.1 Install Node.js on the server (one-time)

```bash
# NodeSource RPM repository for Node.js 22 LTS
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version   # should print v22.x.x
```

### 8.2 Build on the server

```bash
cd /opt/chat-analyzer/repo/frontend
npm ci
VITE_API_URL= npm run build
```

`VITE_API_URL` must be empty so Axios uses relative paths (`/api/...`). nginx on the server will proxy those to the backend.

### 8.3 Copy to the nginx web root

```bash
sudo cp -r /opt/chat-analyzer/repo/frontend/dist/. /var/www/html/
```

For subsequent deploys, clear old files first so stale chunks from a previous build don't linger:

```bash
sudo rm -rf /var/www/html/* && sudo cp -r /opt/chat-analyzer/repo/frontend/dist/. /var/www/html/
```

### 8.4 Set correct permissions

On Amazon Linux 2023, nginx runs as the `nginx` user:

```bash
sudo chown -R nginx:nginx /var/www/html
sudo chmod -R 755 /var/www/html
```

### 8.5 Verify the full flow

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

`ENVIRONMENT` is not set to `production` in `backend/.env`. The `secure=True` flag on the cookie is gated on that env var (`auth.py`). Without `secure=True`, the browser silently drops the cookie on HTTPS connections.

**`alembic upgrade head` fails with `could not connect to server`**

The RDS security group inbound rule is not correctly referencing the EC2 security group. Go back to Step 3.3 and check the rule source is the **security group ID** of the EC2 instance, not an IP address.

**Frontend shows a blank page after deploy**

The React router is using history mode — nginx must return `index.html` for all non-API routes. Check the `try_files $uri $uri/ /index.html;` line is in the nginx config and that you ran `sudo nginx -t && sudo systemctl reload nginx` after any config change.

**`curl https://yourdomain.com` returns a certificate error immediately after certbot**

DNS has not propagated yet. Wait a few minutes and try again. You can check with `dig +short yourdomain.com` — it should return your Elastic IP before the cert will work.

**Session Manager tab is greyed out**

The IAM role is not attached or the SSM agent hasn't connected yet. Check: EC2 → Instance → **Actions → Security → Modify IAM role** and confirm `chat-analyzer-ec2-ssm-role` is assigned. If the role is correct, wait 1–2 more minutes — on a fresh instance the agent needs a moment to register with the SSM service.
