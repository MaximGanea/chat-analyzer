# S3 + CloudFront Frontend Guide

Move the React build off EC2 and onto a managed CDN so nginx only handles API proxying.

**Prerequisites:** Phase 6 complete (GitHub Actions CI/CD running) · domain pointing to EC2 Elastic IP · AWS account

---

## What changes

Before this guide, the frontend is served by nginx on EC2:

```
Internet → CloudFront (not yet)
Internet → DNS → Elastic IP → EC2 nginx :443
                               ├── /        → /var/www/html (React files on disk)
                               └── /api/*   → 127.0.0.1:8000 (backend container)
```

After this guide:

```
Internet → DNS → CloudFront
                  ├── /api/*   → Elastic IP → EC2 nginx → backend container
                  └── /*       → S3 bucket (React files)
```

EC2 stays. The backend container keeps running there. nginx keeps running — but it loses its static file config and only proxies `/api/*`. The frontend deploy job in GitHub Actions stops SSM-ing into EC2 and instead uploads the built files directly to S3.

**Why stop serving static files from EC2?**
The React build is a set of files that never change between requests — there is no compute involved in serving them. Running a compute instance to serve static files wastes money and adds operational burden. S3 is designed for exactly this: it stores files and serves them at any scale for fractions of a cent. Putting CloudFront in front adds a global CDN with caching so users get the files from a nearby edge location instead of your EC2 region.

**Why not make the S3 bucket public?**
A public bucket means anyone who knows your bucket URL can hit S3 directly, bypassing CloudFront — bypassing your cache, your HTTPS enforcement, and any future edge logic. CloudFront + Origin Access Control (OAC) means only CloudFront can read from the bucket. The bucket stays completely private.

---

## Quick reference

After setup, every push to main in GitHub Actions will:

1. Build the frontend on a GitHub runner
2. Sync hashed assets to S3 with a one-year cache header
3. Sync `index.html` with `no-cache`
4. Invalidate `/index.html` on CloudFront so users see the new version immediately

To check that CloudFront is serving from S3 and not stale cache:

```bash
curl -I https://yourdomain.com/assets/index-abc123.js
# look for: X-Cache: Hit from cloudfront (second request)
# look for: Cache-Control: public, max-age=31536000, immutable
```

---

## Step 1 — Create the S3 bucket

1. AWS Console → **S3** → **Create bucket**
2. Bucket name: `chat-analyzer-frontend`
3. Region: same region as your EC2 instance (e.g., `us-east-1`)
4. **Object Ownership:** leave at `ACLs disabled`
5. **Block Public Access:** leave all four checkboxes checked (all public access blocked) — CloudFront will access the bucket privately via OAC, not through a public URL
6. Leave all other settings at defaults → **Create bucket**

Do not enable static website hosting. With the modern CloudFront + OAC approach, CloudFront reads directly from the S3 REST API — no website hosting endpoint needed, and the bucket stays fully private.

> **What is OAC?** Origin Access Control is how CloudFront authenticates itself to your private S3 bucket. When a user requests a file, CloudFront signs the request to S3 with its own identity. S3 checks the signature and only serves the file because CloudFront's identity is allowed in the bucket policy. No public access required, and no one can bypass CloudFront to hit S3 directly.

---

## Step 2 — Request an ACM certificate

CloudFront requires an SSL certificate from **AWS Certificate Manager (ACM)**, and it must be in the **us-east-1** region regardless of where your EC2 instance is. This is an AWS requirement — CloudFront only reads certificates from us-east-1.

> **Why ACM instead of certbot?** certbot issues Let's Encrypt certificates that you renew manually (or via cron). ACM issues certificates that AWS renews automatically, forever. You never touch the certificate again after this step.

1. AWS Console → change region to **US East (N. Virginia) — us-east-1** (top-right region selector)
2. **Certificate Manager** → **Request a certificate**
3. Certificate type: **Request a public certificate** → **Next**
4. Domain names — add both:
   - `yourdomain.com`
   - `www.yourdomain.com`
5. Validation method: **DNS validation** → **Request**

### Why DNS validation over email validation?

Email validation sends a confirmation email to addresses like `admin@yourdomain.com` — you have to click a link, and you have to do it again every time the cert renews. DNS validation works by adding a CNAME record to your domain once. ACM checks the record exists and renews the certificate automatically for as long as the record is there. You add the record once and never touch it again.

### Add the validation CNAME records

After requesting the certificate, ACM shows a table of CNAME records it needs you to create. For each domain:

1. Copy the **CNAME name** and **CNAME value**
2. Go to your DNS provider → add a CNAME record with those exact values
3. TTL: 300 seconds

Wait 5–10 minutes. Refresh the ACM page. Status changes from **Pending validation** to **Issued**.

Note the **Certificate ARN** once it is issued — you will select this certificate when creating the CloudFront distribution.

---

## Step 3 — Create a CloudFront Origin Access Control

OAC is the mechanism that lets CloudFront access your private S3 bucket. You create it once here and attach it to the S3 origin when creating the distribution.

1. AWS Console → **CloudFront** → left sidebar → **Origin access**
2. **Create control setting**
3. Name: `chat-analyzer-frontend-oac`
4. Origin type: **S3**
5. Signing behavior: **Sign requests (recommended)**
6. **Create**

---

## Step 4 — Create the CloudFront distribution

The distribution is the CloudFront configuration that ties together your two origins (S3 and EC2) and the routing rules between them.

### 4.1 Create the distribution

CloudFront → **Create distribution**

### 4.2 Configure the S3 origin (first origin)

| Field | Value |
|---|---|
| Origin domain | Select `chat-analyzer-frontend.s3.us-east-1.amazonaws.com` from the dropdown |
| Origin access | **Origin access control settings (recommended)** |
| Origin access control | Select `chat-analyzer-frontend-oac` (created in Step 3) |

Leave all other origin fields at defaults.

### 4.3 Configure the default cache behavior (serves the frontend)

| Field | Value |
|---|---|
| Path pattern | Default (`*`) |
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Cache policy | **CachingOptimized** (AWS managed — caches based on `Cache-Control` headers from S3) |

### 4.4 Configure SPA routing (important)

React Router uses client-side routing — when a user goes directly to `https://yourdomain.com/dashboard`, S3 has no file at that path and returns a 403. CloudFront must intercept that and serve `index.html` instead so React Router can handle the route.

Scroll down to **Custom error responses** → **Add custom error response**:

| Field | Value |
|---|---|
| HTTP error code | 403 |
| Customize error response | Yes |
| Response page path | `/index.html` |
| HTTP response code | 200 |

Add a second one:

| HTTP error code | 404 |
| Customize error response | Yes |
| Response page path | `/index.html` |
| HTTP response code | 200 |

### 4.5 Add the EC2 origin (second origin)

Further down the page → **Add origin**

| Field | Value |
|---|---|
| Origin domain | Your Elastic IP address (type it in — e.g., `1.2.3.4`) |
| Protocol | **HTTP only** |
| HTTP port | 80 |

> **Why HTTP between CloudFront and EC2?** TLS is already terminated at CloudFront — the user's connection to CloudFront is HTTPS/encrypted. The leg from CloudFront to EC2 is within AWS's private network and does not leave AWS's infrastructure, so HTTP is acceptable here. This also means you do not need to keep certbot running on EC2 for this purpose (though you can leave it — it does not hurt anything).

### 4.6 Add the `/api/*` behavior (routes API calls to EC2)

**Add behavior**

| Field | Value |
|---|---|
| Path pattern | `/api/*` |
| Origin | Select the EC2 Elastic IP origin you just added |
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Cache policy | **CachingDisabled** — API responses must never be cached |
| Origin request policy | **AllViewer** — forward all headers, cookies, and query strings to the backend |

> **Why `CachingDisabled` for `/api/*`?** CloudFront caches responses at the edge by default. If API responses were cached, two users could get each other's data, or a login endpoint could return a cached 200 from a previous session. Always disable caching for anything that goes to your backend.

> **Why `AllViewer` for origin request policy?** Your backend needs the real client IP (for rate limiting), the `Cookie` header (for the refresh token), and the `Authorization` header. Without `AllViewer`, CloudFront strips these and the backend receives incomplete requests.

### 4.7 Configure domain names and certificate

Still on the create distribution page, scroll to **Settings**:

| Field | Value |
|---|---|
| Alternate domain names (CNAMEs) | Add `yourdomain.com` and `www.yourdomain.com` |
| Custom SSL certificate | Select the ACM certificate from Step 2 |
| Default root object | `index.html` |

→ **Create distribution**

CloudFront takes **5–15 minutes** to deploy globally. The status shows **Deploying** — wait until it shows **Enabled** before continuing.

Note the **Distribution domain name** — it looks like `d1234abcdef8.cloudfront.net`. You will point your DNS at this in Step 6.

---

## Step 5 — Update the S3 bucket policy

CloudFront created the distribution and knows which OAC to use, but S3 does not yet allow CloudFront to read from it. You need to add a bucket policy.

CloudFront makes this easy — it generates the policy for you.

1. CloudFront → your distribution → **Origins** tab → click the S3 origin → **Edit**
2. You will see a banner: **"Update the S3 bucket policy"** → click **Copy policy**
3. Open a new tab → **S3** → `chat-analyzer-frontend` → **Permissions** tab → **Bucket policy** → **Edit**
4. Paste the copied policy → **Save changes**

The policy looks like this (CloudFront fills in the real ARNs):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::chat-analyzer-frontend/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

The `Condition` is the key part — it limits access to your specific CloudFront distribution. Even if someone creates their own CloudFront distribution and points it at your bucket, the condition rejects it.

---

## Step 6 — Update DNS to point to CloudFront

Right now your domain points to the EC2 Elastic IP. Change it to point to the CloudFront distribution domain instead.

In your DNS provider:

| Record | Old value | New value |
|---|---|---|
| A / CNAME `yourdomain.com` | Elastic IP | `d1234abcdef8.cloudfront.net` |
| A / CNAME `www.yourdomain.com` | Elastic IP | `d1234abcdef8.cloudfront.net` |

> **A record vs CNAME for the apex domain:** Most DNS providers do not allow a CNAME on the apex domain (`yourdomain.com` without `www`) because it conflicts with how DNS works. If your provider supports **ALIAS records** (Cloudflare calls it a flattened CNAME, Route 53 calls it ALIAS), use that for the apex. If not, some providers let you enter a CloudFront domain in an A record field — check your provider's docs.

Verify propagation (wait 1–5 minutes after saving):

```bash
dig +short yourdomain.com
# should return a CloudFront IP, not your Elastic IP
```

Test the frontend loads through CloudFront:

```bash
curl -I https://yourdomain.com
# X-Cache: Miss from cloudfront  (first request — not cached yet)
curl -I https://yourdomain.com
# X-Cache: Hit from cloudfront   (second request — served from edge)
```

Test that API calls still work:

```bash
curl https://yourdomain.com/api/auth/
# 404 or 405 — not a connection error
```

---

## Step 7 — Update the IAM policy for GitHub Actions

The `github-actions-chat-analyzer` IAM user currently has only ECR and SSM permissions. It now also needs to write to S3 and invalidate the CloudFront cache.

1. IAM → **Policies** → `github-actions-chat-analyzer-policy` → **Edit**
2. Add two new statements to the existing JSON (inside the `Statement` array). Replace `ACCOUNT_ID` and `DISTRIBUTION_ID` with your values (find the distribution ID on the CloudFront console — it looks like `E1A2B3C4D5E6F7`):

```json
{
  "Sid": "S3Frontend",
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::chat-analyzer-frontend",
    "arn:aws:s3:::chat-analyzer-frontend/*"
  ]
},
{
  "Sid": "CloudFrontInvalidate",
  "Effect": "Allow",
  "Action": "cloudfront:CreateInvalidation",
  "Resource": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
}
```

→ **Next** → **Save changes**

**Why `s3:ListBucket` on the bucket itself (not `/*`)?**
`aws s3 sync --delete` first lists the bucket contents to figure out which files to delete. `ListBucket` is a bucket-level permission, not an object-level one, so it goes on the bucket ARN without `/*`. `PutObject` and `DeleteObject` are object-level and go on `/*`.

---

## Step 8 — Add the CloudFront distribution ID to GitHub Actions secrets

The CD workflow needs the distribution ID to run the CloudFront invalidation.

GitHub → your repo → **Settings** → **Environments** → `production` → **Add secret**

| Secret name | Value |
|---|---|
| `CLOUDFRONT_DISTRIBUTION_ID` | Your distribution ID (e.g., `E1A2B3C4D5E6F7`) |

---

## Step 9 — Replace the deploy-frontend job in cd.yml

Open `.github/workflows/cd.yml`. Find the `deploy-frontend` job and replace it entirely:

```yaml
  deploy-frontend:
    needs: [test-backend, test-frontend]
    runs-on: ubuntu-latest
    environment: production

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install and build
        run: npm ci && VITE_API_URL= npm run build
        working-directory: frontend

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Sync hashed assets (long cache)
        run: |
          aws s3 sync frontend/dist/ s3://chat-analyzer-frontend \
            --delete \
            --exclude "index.html" \
            --cache-control "public, max-age=31536000, immutable"

      - name: Sync index.html (no cache)
        run: |
          aws s3 sync frontend/dist/ s3://chat-analyzer-frontend \
            --exclude "*" \
            --include "index.html" \
            --cache-control "no-cache"

      - name: Invalidate CloudFront index.html
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
            --paths "/index.html"
```

Also update the `smoke-test` job's `needs` — it no longer needs to wait for the SSM-based frontend deploy since the frontend is now independent of the backend deploy sequence. The existing `needs: [deploy-backend, deploy-frontend]` is still correct and does not need to change.

The updated job dependency graph after this change:

```
test-backend ──┐
               ├──► build-and-push ──► migrate ──► deploy-backend ──┐
test-frontend ─┤                                                      ├──► smoke-test
               └──────────────────────────────────► deploy-frontend ─┘
```

**Why two separate sync passes instead of one?**
`aws s3 sync` applies one `--cache-control` value to every file it touches in a single pass. Hashed assets (`/assets/index-abc123.js`) have content-based filenames that change every build — they can be cached for a year safely. `index.html` always has the same name but new content every deploy — it must never be cached or users will load stale HTML that references old JS filenames. Two passes with `--exclude`/`--include` give each file type its own header.

**Why invalidate only `/index.html` and not `/*`?**
CloudFront charges per invalidation path after the first 1000 per month. Invalidating `/*` would also clear the cache for every JS and CSS file, but those are safe — they have hashed filenames, so a new deploy creates new filenames and the old cached files are naturally unreachable. Only `index.html` needs a manual invalidation because it keeps its name across deploys. This keeps costs near zero and makes invalidation faster.

**Why does `deploy-frontend` no longer need `build-and-push`?**
The old job SSM-ed into EC2 and ran `git pull`, so it needed to know the backend build had already started (to avoid deploying old frontend code while a new backend was being pushed). The new job builds the frontend entirely on the GitHub runner and pushes to S3 — it has no dependency on the Docker image or ECR. It only needs the tests to have passed.

---

## Step 10 — Update nginx on EC2

nginx on EC2 no longer needs to serve static files. Remove the static file configuration and leave only the API proxy.

Open an SSM Session Manager terminal on EC2 (EC2 → `chat-analyzer-prod` → Connect → Session Manager → Connect):

```bash
sudo nano /etc/nginx/conf.d/yourdomain.com.conf
```

Replace the entire file contents with:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`), then test and reload:

```bash
sudo nginx -t
# must print: syntax is ok / test is successful

sudo systemctl reload nginx
```

> **What about the HTTPS server block certbot added?** Replacing the entire file above removes it — certbot's port 443 block is gone after you save this config. certbot itself (the binary, cron job, and certificates) will be removed in Step 11.

---

## Step 11 — Clean up

### Remove certbot

certbot was installed in Phase 5 to issue a Let's Encrypt certificate for nginx. CloudFront now handles TLS using the ACM certificate — certbot is no longer needed and its cron job is renewing a certificate nobody uses.

In the SSM terminal:

```bash
# Stop the renewal cron job
sudo rm /etc/cron.d/certbot

# Remove certbot and its virtualenv
sudo rm -rf /opt/certbot

# Remove the Let's Encrypt certificates and config
sudo rm -rf /etc/letsencrypt
```

Verify nginx still works with just the API proxy config after removing certbot:

```bash
sudo nginx -t
sudo systemctl status nginx
curl http://127.0.0.1/api/auth/
# 404 or 405 — not a connection error
```

### Remove /var/www/html

The directory is no longer used. In the SSM terminal:

```bash
sudo rm -rf /var/www/html
```

### Remove Node.js from EC2

Node.js was installed on EC2 to build the frontend. It is no longer needed there:

```bash
sudo dnf remove -y nodejs
```

### Remove docker-compose.prod.yml

Every service it defined has been replaced:

```
docker-compose.prod.yml
├── postgres   → RDS (replaced in Phase 5)
├── backend    → docker run on EC2, image pulled from ECR (replaced in Phase 6)
└── frontend   → S3 + CloudFront (replaced in Phase 7)
```

Delete the file from the repo:

```bash
git rm docker-compose.prod.yml
git commit -m "remove docker-compose.prod.yml — all services replaced by Phase 7"
git push origin main
```

---

## Step 12 — Validation checklist

Run from your phone on mobile data after the first successful CD pipeline run:

- [ ] `https://yourdomain.com` loads the app — padlock visible, no cert warning
- [ ] Second request to an asset: `curl -I https://yourdomain.com/assets/index-abc123.js` shows `X-Cache: Hit from cloudfront`
- [ ] Asset response has `Cache-Control: public, max-age=31536000, immutable`
- [ ] `curl -I https://yourdomain.com` shows `Cache-Control: no-cache` for `index.html`
- [ ] Full flow: register → login → hard refresh → still logged in → logout
- [ ] Direct navigation to `/dashboard` works — React Router handles the route (SPA routing via custom error response)
- [ ] `curl https://yourdomain.com/api/auth/` returns 404 or 405 — not a connection error (API routing through CloudFront → EC2 works)
- [ ] `curl http://YOUR_ELASTIC_IP` no longer returns the React app (EC2 no longer serves static files)
- [ ] ECR image appears in ECR console tagged with the merge commit SHA
- [ ] GitHub Actions pipeline: all jobs green

---

## Troubleshooting

**CloudFront returns 403 on all routes**

The S3 bucket policy was not updated (Step 5). Go to S3 → `chat-analyzer-frontend` → Permissions → Bucket policy. If it is empty or does not contain a `cloudfront.amazonaws.com` principal, go back to Step 5 and copy the policy from the CloudFront distribution's Origins tab.

**`/dashboard` shows AccessDenied XML instead of the app**

The custom error responses (Step 4.4) were not configured. CloudFront → your distribution → **Error pages** tab → add both the 403 → `/index.html` and 404 → `/index.html` responses. Deploy takes a few minutes after saving.

**API calls return 502 or time out**

The `/api/*` behavior is misconfigured. Check:
- CloudFront → distribution → **Behaviors** tab — confirm `/api/*` is listed with the EC2 origin
- The EC2 origin protocol is HTTP and port is 80
- EC2 security group allows port 80 inbound from `0.0.0.0/0` (it should — this was set in Phase 5 for certbot)
- nginx is running: in SSM terminal run `sudo systemctl status nginx`

**`aws s3 sync` fails in GitHub Actions with `AccessDenied`**

The IAM policy update in Step 7 did not save or has a typo. Go to IAM → Policies → `github-actions-chat-analyzer-policy` → JSON tab and confirm the `S3Frontend` and `CloudFrontInvalidate` statements are present with the correct bucket name and distribution ID.

**CloudFront invalidation fails in GitHub Actions**

The `CLOUDFRONT_DISTRIBUTION_ID` secret in the GitHub `production` environment is missing or wrong (Step 8). Double check it matches the distribution ID shown in the CloudFront console (format: `E1A2B3C4D5E6F7`).

**Users still see the old frontend after a deploy**

The CloudFront invalidation for `index.html` ran but the user's browser cached it locally (not CloudFront — browser cache). Ask them to hard refresh (`Ctrl+Shift+R`). For future deploys, confirm the `Sync index.html` step uses `--cache-control "no-cache"` so the browser does not cache it at all.

**Certificate not found when creating the CloudFront distribution**

ACM certificates must be in `us-east-1` for CloudFront. If you requested the certificate in a different region (e.g., `eu-west-1`), it will not appear in the CloudFront dropdown. Request a new certificate in `us-east-1` (Step 2) and use that one instead.
