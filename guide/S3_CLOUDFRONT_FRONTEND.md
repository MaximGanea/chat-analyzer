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
curl -I https://temple-project.net/assets/index-abc123.js
# look for: X-Cache: Hit from cloudfront (second request)
# look for: Cache-Control: public, max-age=31536000, immutable
```

---

## Step 1 — Create the S3 bucket

1. AWS Console → **S3** → **Create bucket**
2. Bucket name: `chat-analyzer-frontend`
3. Region: same region as your EC2 instance (e.g., `eu-central-1`)
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
   - `temple-project.net`
   - `www.temple-project.net`
5. Validation method: **DNS validation** → **Request**

### Why DNS validation over email validation?

Email validation sends a confirmation email to addresses like `admin@temple-project.net` — you have to click a link, and you have to do it again every time the cert renews. DNS validation works by adding a CNAME record to your domain once. ACM checks the record exists and renews the certificate automatically for as long as the record is there. You add the record once and never touch it again.

### Add the validation CNAME records

After requesting the certificate, ACM shows a table of CNAME records it needs you to create.

Since the domain is in Route 53, ACM can write them itself: open the certificate → **Create records in Route 53** → confirm. It adds one CNAME per domain to the hosted zone. Note that the certificate lives in `us-east-1` while the hosted zone is global — ACM handles that, no region switching needed.

Doing it by hand instead (for each domain in the table):

1. Copy the **CNAME name** and **CNAME value**
2. Route 53 → your hosted zone → **Create record** → type CNAME, with those exact values
3. TTL: 300 seconds

Wait 5–10 minutes. Refresh the ACM page. Status changes from **Pending validation** to **Issued**.

Note the **Certificate ARN** once it is issued — you will select this certificate when creating the CloudFront distribution.

---

## Step 3 — Origin Access Control (usually automatic)

OAC is the mechanism that lets CloudFront access your private S3 bucket. **The current console creates it for you** — the distribution wizard has a `Grant CloudFront access to origin` setting that generates an OAC and writes the S3 bucket policy automatically. If that is what you see in Step 4, skip this step entirely.

Create one manually only if your wizard has no such setting, or if you want a named OAC to reuse across distributions:

1. AWS Console → **CloudFront** → left sidebar → **Origin access**
2. **Create control setting**
3. Name: `chat-analyzer-frontend-oac`
4. Origin type: **S3**
5. Signing behavior: **Sign requests (recommended)**
6. **Create**

An OAC is just a named signing configuration — there is nothing unique about one you create by hand versus one the wizard generates. If you created one and the wizard made its own anyway, delete the unused one in **Origin access** (it is free and harmless either way).

---

## Step 4 — Create the CloudFront distribution

The distribution is the CloudFront configuration that ties together your two origins (S3 and EC2) and the routing rules between them.

> **Read this before you start.** The creation wizard configures **one origin and one behavior, and nothing else**. The second origin (EC2), the `/api/*` behavior, SPA routing, the custom domain and the default root object are all added *after* the distribution exists, by editing it. That is not a mistake in your setup — the wizard simply does not expose those fields. Sections 4.1 and 4.2 are the wizard; 4.3 onward are post-creation edits.
>
> Every post-creation edit puts the distribution into **Deploying** for a few minutes. You do not need to wait between edits — queue them all and let the last one settle.

### 4.1 Run the creation wizard

CloudFront → **Create distribution**, then work through the wizard steps:

**Get started** — Distribution name: `chat-analyzer-frontend`. Leave the billing plan on the **free** tier; Origin Shield, mutual TLS and Layer 7 DDoS protection are paid-plan features you do not need.

**Specify origin** — pick the bucket from the dropdown, do not type the domain by hand. Typing it makes CloudFront treat the bucket as a generic custom origin, and the private-access option disappears.

| Field | Value |
|---|---|
| Origin domain | Select `chat-analyzer-frontend.s3.eu-central-1.amazonaws.com` from the dropdown |
| Grant CloudFront access to origin | **Yes** — creates an OAC and writes the S3 bucket policy for you |
| Origin settings | **Use recommended origin settings** — the defaults (3 attempts, 10s connect, 30s response) are correct for S3 |

If your console shows an explicit `Origin access` radio with an OAC dropdown instead, choose **Origin access control settings (recommended)** and select `chat-analyzer-frontend-oac` from Step 3. If it shows neither, create the distribution as-is and attach the OAC afterwards: **Origins** tab → S3 origin → **Edit** → `Origin access`.

**Enable security** — this is AWS WAF. On the free plan the basic protections are included at no extra charge, so leave them **Enabled**, but turn **`Use monitor mode` on**.

> **Why monitor mode?** In monitor mode WAF counts requests it *would* block instead of blocking them. Managed rule sets sometimes reject legitimate traffic, and everything sensitive in this app goes through `/api/*` — JSON POST bodies, the `Authorization` header, the refresh-token cookie. If a rule matches a login request in blocking mode you get intermittent 403s that look exactly like a backend bug. Run in monitor mode until Step 12 passes, check the WAF console for would-be blocks, then turn monitor mode off to start actually blocking.

**Custom domain / TLS certificate** — if the wizard offers these, fill them in per section 4.4. If it does not, or your ACM certificate is not `Issued` yet, skip it and add it later.

**Review and create** — the summary should read: billing free, `Grant CloudFront access to origin: Yes`, security protections enabled with monitor mode on. Create it.

CloudFront takes **5–15 minutes** to deploy globally. Note the **Distribution domain name** (`d1234abcdef8.cloudfront.net`) and the **Distribution ID** (`E1A2B3C4D5E6F7`) — you need the first for DNS in Step 9 and the second for IAM and GitHub secrets in Steps 6 and 7.

### 4.2 Verify the default cache behavior

Distribution → **Behaviors** tab → `Default (*)` → **Edit**:

| Field | Value |
|---|---|
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Cache policy | **CachingOptimized** (AWS managed — caches based on the `Cache-Control` headers your CD pipeline sets on the S3 objects) |

The wizard usually picks both correctly for an S3 origin. Confirm rather than assume.

### 4.3 Set the default root object

Distribution → **General** tab → **Settings** → **Edit** → `Default root object`: `index.html`

Without it, a request to `https://temple-project.net/` asks S3 for the bucket root rather than a file, and returns an error instead of your app.

### 4.4 Add the custom domain and certificate

Same panel — **General** → **Settings** → **Edit**:

| Field | Value |
|---|---|
| Alternate domain names (CNAMEs) | Add `temple-project.net` and `www.temple-project.net` |
| Custom SSL certificate | Select the ACM certificate from Step 2 |

If the certificate does not appear in the dropdown, it is not in `us-east-1` — see the last entry in Troubleshooting.

### 4.5 Configure SPA routing (important)

React Router resolves routes client-side. As long as the user navigates inside the app nothing is requested from the network — Router just rewrites the URL. But a hard refresh on `https://temple-project.net/dashboard`, or opening that link from a bookmark, makes the browser ask CloudFront for the literal path `/dashboard`, and there is no such object in S3.

S3 answers **403, not 404**. The bucket policy grants CloudFront `s3:GetObject` but not `s3:ListBucket`, and without list permission S3 is not allowed to reveal whether an object exists — that would leak the bucket's contents. So every missing key comes back as `AccessDenied`, and the user sees raw XML instead of the app.

The fix is to rewrite route-shaped requests to `/index.html` before they ever reach S3, using a CloudFront Function attached to the default behavior only.

1. CloudFront → left sidebar → **Functions** → **Create function**
2. Name: `spa-router`, runtime: `cloudfront-js-2.0`
3. Paste:

```js
function handler(event) {
    var request = event.request;
    if (!request.uri.includes('.')) {
        request.uri = '/index.html';
    }
    return request;
}
```

4. **Save changes** → **Publish** tab → **Publish function**
5. Distribution → **Behaviors** → `Default (*)` → **Edit** → **Function associations** → Viewer request → select `spa-router` → save

A path with no dot is a route (`/dashboard`, `/admin/users`) and gets rewritten. A path with a dot is a file (`/assets/index-abc123.js`, `/favicon.ico`) and passes through untouched. S3 only ever receives requests for files that exist, so no 403 is generated in the first place.

> **Why not custom error responses (403/404 → `/index.html` with status 200)?** That is the older recipe and it works for a pure static site, but it breaks this app. **Custom error responses are distribution-wide, not per-behavior** — they also rewrite error responses coming back from your backend through `/api/*`. An admin endpoint returning 403 to a non-admin user, or a genuine 404 from the API, would reach the frontend as a 200 containing HTML, and axios would try to parse your `index.html` as JSON. A CloudFront Function is attached to one behavior, so `/api/*` is never touched.
>
> As a bonus, a genuinely missing asset stays an error instead of silently returning `index.html` with a 200, which makes broken deploys far easier to spot.
>
> CloudFront Functions bill per invocation with a large free tier — at this project's traffic the cost is zero.

### 4.6 Add the EC2 origin

**CloudFront does not accept a raw IP address as an origin domain** — it rejects it with *"Origin domain cannot be an IP address"*. You need a DNS name that resolves to your Elastic IP.

First, create the record. Route 53 → **Hosted zones** → your zone → **Create record**:

| Field | Value |
|---|---|
| Record name | `origin` |
| Record type | **A** |
| Alias | **off** — this is a plain A record to a real IP |
| Value | Your Elastic IP (e.g. `1.2.3.4`) |
| TTL | 300 |
| Routing policy | Simple routing |

This subdomain is the direct path to EC2, deliberately bypassing CloudFront. It stays pointed at the Elastic IP forever, and it must **not** be added to the distribution's alternate domain names in 4.4.

> **No custom domain?** An EC2 instance with an Elastic IP also has a public DNS name of the form `ec2-1-2-3-4.eu-central-1.compute.amazonaws.com` (EC2 console → your instance → *Public IPv4 DNS*). It works as an origin domain and stays stable while the Elastic IP is attached. A subdomain you control is preferable — it survives an IP change.

Then: Distribution → **Origins** tab → **Create origin**

| Field | Value |
|---|---|
| Origin domain | `origin.temple-project.net` |
| Protocol | **HTTP only** |
| HTTP port | 80 |

> **Why HTTP between CloudFront and EC2?** TLS is already terminated at CloudFront — the user's connection to CloudFront is HTTPS/encrypted. The leg from CloudFront to EC2 is within AWS's private network and does not leave AWS's infrastructure, so HTTP is acceptable here. This also means you do not need to keep certbot running on EC2 for this purpose (though you can leave it — it does not hurt anything).

> **Note for later:** `origin.temple-project.net` is publicly reachable, so anyone who finds it can reach your backend directly, skipping CloudFront and WAF. Step 13 closes that off with a shared secret header. Do not set it up now — it depends on DNS already pointing at CloudFront and on nginx having been updated, and turning it on early takes the site down.

### 4.7 Add the `/api/*` behavior

Do this **after** 4.6 — the EC2 origin must exist before you can select it here.

Distribution → **Behaviors** tab → **Create behavior**

| Field | Value |
|---|---|
| Path pattern | `/api/*` |
| Origin | The `origin.temple-project.net` origin from 4.6 |
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Cache policy | **CachingDisabled** — API responses must never be cached |
| Origin request policy | **AllViewer** — forward all headers, cookies, and query strings to the backend |
| Allowed HTTP methods | **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE** — the default is read-only and would reject every login and registration |

Do **not** attach the `spa-router` function to this behavior.

> **Why `CachingDisabled` for `/api/*`?** CloudFront caches responses at the edge by default. If API responses were cached, two users could get each other's data, or a login endpoint could return a cached 200 from a previous session. Always disable caching for anything that goes to your backend.

> **Why `AllViewer` for origin request policy?** Your backend needs the real client IP (for rate limiting), the `Cookie` header (for the refresh token), and the `Authorization` header. Without `AllViewer`, CloudFront strips these and the backend receives incomplete requests.

Wait for the distribution status to return to **Enabled** before continuing.

---

## Step 5 — Verify the S3 bucket policy

CloudFront can only read from your private bucket if the bucket policy names it explicitly. If you answered **Yes** to `Grant CloudFront access to origin` in 4.1, CloudFront already wrote this policy — verify it and move on.

**S3** → `chat-analyzer-frontend` → **Permissions** tab → **Bucket policy**. You are looking for a statement with `"Service": "cloudfront.amazonaws.com"`.

If it is there, this step is done. If the policy is empty, add it manually — CloudFront generates it for you:

1. CloudFront → your distribution → **Origins** tab → click the S3 origin → **Edit**
2. You will see a banner: **"Update the S3 bucket policy"** → click **Copy policy**
3. Open a new tab → **S3** → `chat-analyzer-frontend` → **Permissions** tab → **Bucket policy** → **Edit**
4. Paste the copied policy → **Save changes**

Until this policy exists, CloudFront returns 403 on every request. That is expected, not a misconfiguration elsewhere.

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

## Step 6 — Update the IAM policy for GitHub Actions

The pipeline authenticates to AWS with **OIDC**, not access keys: `cd.yml` declares `permissions: id-token: write` and every job does `role-to-assume: ${{ secrets.AWS_ROLE_ARN }}`. GitHub presents a short-lived signed token, AWS verifies it against a trust policy and hands back temporary credentials. There is no IAM user and no long-lived secret key anywhere.

So the permissions live on a **role**, `github-actions-chat-analyzer-role`, which currently grants only ECR and SSM. It now also needs to write to S3 and invalidate the CloudFront cache.

1. IAM → **Roles** → `github-actions-chat-analyzer-role` → **Permissions** tab
2. Find the attached customer-managed policy (the name varies — whatever is listed there that is not an AWS-managed policy) → click it → **Edit** → **JSON**
3. Add two new statements to the existing `Statement` array. Replace `ACCOUNT_ID` and `DISTRIBUTION_ID` with your values (find the distribution ID on the CloudFront console — it looks like `E1A2B3C4D5E6F7`):

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

The role's **trust policy** does not change — it already allows GitHub's OIDC provider to assume the role from this repository. You are only widening what the role may do once assumed.

---

## Step 7 — Add the CloudFront distribution ID to GitHub Actions secrets

The CD workflow needs the distribution ID to run the CloudFront invalidation.

GitHub → your repo → **Settings** → **Environments** → `production` → **Add secret**

| Secret name | Value |
|---|---|
| `CLOUDFRONT_DISTRIBUTION_ID` | Your distribution ID (e.g., `E1A2B3C4D5E6F7`) |

---

## Step 8 — Replace the deploy-frontend job in cd.yml

Open `.github/workflows/cd.yml`. Find the `deploy-frontend` job and replace it entirely.

Two things to keep as they are: `environment: production`, because `AWS_ROLE_ARN` and `CLOUDFRONT_DISTRIBUTION_ID` are environment secrets and a job without it cannot read them; and the workflow-level `permissions: id-token: write`, which is what lets the job request an OIDC token at all.

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
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

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

**Leave `smoke-test` alone.** Its `needs: [deploy-backend, deploy-frontend]` is still correct — the job names did not change, and it should still wait for both deploys before checking the health endpoint.

The only dependency that changes is `deploy-frontend`'s own: `needs: build-and-push` becomes `needs: [test-backend, test-frontend]`.

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

## Step 9 — Update DNS to point to CloudFront

> **This step comes last of the AWS work, on purpose.** Steps 6 to 8 build the CD pipeline that actually puts files in the S3 bucket. Until that pipeline has run once, the bucket is empty. Cut DNS over now and CloudFront starts serving an empty bucket: the site is down until the first green pipeline run. Set up the pipeline, let it deploy once, verify through the distribution domain (below), and only then come back here.

### 9.1 Test before cutting over

The distribution has its own hostname that works without any DNS change — `*.cloudfront.net` belongs to CloudFront, so it accepts those requests regardless of the alternate domain names:

```bash
curl -I https://d1234abcdef8.cloudfront.net/
```

Open that URL in a browser and exercise everything: the app loads, direct navigation to `/dashboard` works, register and login work. The frontend is built with a relative `VITE_API_URL`, so its API calls go to the same host and land in the `/api/*` behavior — the full path through to EC2 is covered.

If that all works, the cutover below is a DNS change with nothing left to discover. If it does not, fix it here, while the live site is still being served by EC2 and users are unaffected.

### 9.2 Cut over

Route 53 → **Hosted zones** → your zone. Edit the existing `temple-project.net` and `www.temple-project.net` records (or delete and recreate them) so that each looks like:

| Field | Value |
|---|---|
| Record name | empty for the apex, `www` for the second record |
| Record type | **A** |
| Alias | **on** |
| Route traffic to | *Alias to CloudFront distribution* → select `d1234abcdef8.cloudfront.net` from the dropdown |
| Routing policy | Simple routing |

End state of the zone:

| Record | Points to |
|---|---|
| `temple-project.net` | Alias → CloudFront distribution |
| `www.temple-project.net` | Alias → CloudFront distribution |
| `origin.temple-project.net` | Elastic IP — **created in 4.6, leave it alone** |

`origin.temple-project.net` is what CloudFront itself connects to. Repointing it at CloudFront would create a loop.

> **Why alias instead of CNAME?** DNS forbids a CNAME on the apex domain (`temple-project.net` with no subdomain) — it conflicts with the SOA and NS records that must live there. Route 53 alias records solve this: they look like an A record to the outside world but resolve internally to the CloudFront distribution's current IPs. They also cost nothing to query, unlike normal Route 53 lookups.

> **The distribution is missing from the dropdown.** Route 53 only offers a distribution as an alias target if the domain you are creating is listed in that distribution's **Alternate domain names (CNAMEs)**. Go back and finish section 4.4 first.

### 9.3 Verify

Verify propagation (wait 1–5 minutes after saving):

```bash
dig +short temple-project.net
# should return a CloudFront IP, not your Elastic IP
```

The old value may still be cached by your resolver for as long as the previous record's TTL. `dig +short temple-project.net @8.8.8.8` queries a resolver that has probably never seen the old value.

Test the frontend loads through CloudFront:

```bash
curl -I https://temple-project.net
# X-Cache: Miss from cloudfront  (first request — not cached yet)
curl -I https://temple-project.net
# X-Cache: Hit from cloudfront   (second request — served from edge)
```

Test that API calls still work:

```bash
curl https://temple-project.net/api/auth/
# 404 or 405 — not a connection error
```

---

## Step 10 — Update nginx on EC2

nginx on EC2 no longer needs to serve static files. Remove the static file configuration and leave only the API proxy.

Open an SSM Session Manager terminal on EC2 (EC2 → `chat-analyzer-prod` → Connect → Session Manager → Connect):

```bash
ls /etc/nginx/conf.d/          # confirm the actual filename first
sudo nano /etc/nginx/conf.d/temple-project.net.conf
```

Replace the entire file contents with:

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

Save (`Ctrl+O`, `Enter`, `Ctrl+X`), then test and reload:

```bash
sudo nginx -t
# must print: syntax is ok / test is successful

sudo systemctl reload nginx
```

> **Why is `origin.temple-project.net` in `server_name`?** With the `AllViewer` origin request policy, CloudFront forwards the viewer's `Host` header, so nginx normally sees `temple-project.net`. Listing the origin subdomain as well means direct requests to it also match this block instead of falling through to nginx's default server — useful when debugging with `curl` straight against EC2.

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

- [ ] `https://temple-project.net` loads the app — padlock visible, no cert warning
- [ ] Second request to an asset: `curl -I https://temple-project.net/assets/index-abc123.js` shows `X-Cache: Hit from cloudfront`
- [ ] Asset response has `Cache-Control: public, max-age=31536000, immutable`
- [ ] `curl -I https://temple-project.net` shows `Cache-Control: no-cache` for `index.html`
- [ ] Full flow: register → login → hard refresh → still logged in → logout
- [ ] Direct navigation to `/dashboard` works — React Router handles the route (SPA routing via the `spa-router` CloudFront Function)
- [ ] `curl https://temple-project.net/api/auth/` returns 404 or 405 — not a connection error (API routing through CloudFront → EC2 works)
- [ ] `curl http://YOUR_ELASTIC_IP` no longer returns the React app (EC2 no longer serves static files)
- [ ] ECR image appears in ECR console tagged with the merge commit SHA
- [ ] GitHub Actions pipeline: all jobs green

Once every box above is ticked, go back to WAF: CloudFront → distribution → **Security** → review the would-be-blocked request samples from your test run. If nothing legitimate was matched, turn **`Use monitor mode` off** so the rules start actually blocking.

---

## Step 13 — Optional: lock the origin to CloudFront

**Do this only after Step 12 passes.** Everything below assumes DNS already points at CloudFront and the app works end to end. Turning it on before that takes the site down.

`origin.temple-project.net` resolves to your Elastic IP and answers to anyone. A scanner that finds it reaches your backend directly — no CloudFront, no WAF, no rate limiting at the edge. The fix is a shared secret: CloudFront attaches a header to every request it forwards, and nginx rejects anything without it.

Generate the secret on your own machine:

```bash
openssl rand -hex 32
```

**Order matters — CloudFront first, nginx second.** If nginx starts requiring the header before CloudFront sends it, every request 403s.

### 13.1 Add the header in CloudFront

CloudFront → your distribution → **Origins** tab → the `origin.temple-project.net` origin → **Edit** → **Add custom header**:

| Header name | Value |
|---|---|
| `X-Origin-Verify` | The string from `openssl rand -hex 32` |

Save, and wait for the distribution status to return to **Enabled**. Confirm the site still works before continuing — at this point CloudFront is sending the header and nginx is ignoring it, so nothing should have changed.

### 13.2 Require the header in nginx

In an SSM session, edit `/etc/nginx/conf.d/temple-project.net.conf` and add the check at the `server` level, after `server_name` and above the `location` block:

```nginx
server {
    listen 80;
    server_name temple-project.net www.temple-project.net origin.temple-project.net;

    if ($http_x_origin_verify != "YOUR_SECRET_HERE") {
        return 403;
    }

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
sudo nginx -t
sudo systemctl reload nginx
```

> **`if` in nginx?** `if` inside a `location` block is genuinely dangerous and widely warned against. `if` at the `server` level containing only `return` is the documented-safe form — `return` is one of the two directives officially supported inside `if`.

### 13.3 Verify

```bash
# through CloudFront — still works
curl -i https://temple-project.net/api/auth/
# 404 or 405

# straight to the origin — now blocked
curl -i http://origin.temple-project.net/api/auth/
# 403
```

Then run the full login flow in the browser once more.

**If you lock yourself out**, nothing is lost: SSM Session Manager connects through the AWS agent, not through nginx, so it keeps working even when nginx rejects every HTTP request. Reconnect, delete the `if` block, `sudo systemctl reload nginx`.

Treat the value as a secret — it does not go in the repo, and rotating it means updating both the CloudFront origin and the nginx config, in that order.

---

## Troubleshooting

**CloudFront returns 403 on all routes**

The S3 bucket policy was not updated (Step 5). Go to S3 → `chat-analyzer-frontend` → Permissions → Bucket policy. If it is empty or does not contain a `cloudfront.amazonaws.com` principal, go back to Step 5 and copy the policy from the CloudFront distribution's Origins tab.

**`/dashboard` shows AccessDenied XML instead of the app**

The `spa-router` function (Step 4.5) is not attached, or was saved but never published. Check:
- CloudFront → **Functions** → `spa-router` — the **Publish** tab must show it as published, not just saved
- Distribution → **Behaviors** → `Default (*)` → Edit → **Function associations** — `spa-router` must be on **Viewer request**
- Deploy takes a few minutes after saving

**API responses come back as HTML with status 200**

You have custom error responses configured (Error pages tab) in addition to, or instead of, the `spa-router` function. They apply distribution-wide and rewrite your backend's 403/404 responses too. Distribution → **Error pages** tab → delete them, and use the function from Step 4.5 instead.

**API calls return 502, 403, or time out**

The `/api/*` behavior is misconfigured. Check:
- CloudFront → distribution → **Behaviors** tab — confirm `/api/*` is listed with the EC2 origin
- Allowed HTTP methods on that behavior include POST/PUT/PATCH/DELETE — the default read-only set rejects login and registration
- The `spa-router` function is **not** attached to the `/api/*` behavior
- The EC2 origin protocol is HTTP and port is 80
- `dig +short origin.temple-project.net` returns your Elastic IP, not a CloudFront address
- If you did Step 13, the `X-Origin-Verify` value in the CloudFront origin and the one in nginx match exactly — a mismatch gives 403 on every API call
- EC2 security group allows port 80 inbound from `0.0.0.0/0` (it should — this was set in Phase 5 for certbot)
- nginx is running: in SSM terminal run `sudo systemctl status nginx`
- If the failures are intermittent and only on some requests, WAF may be blocking them: CloudFront → distribution → **Security** → check the blocked-request samples, and re-enable monitor mode while you investigate

**`aws s3 sync` fails in GitHub Actions with `AccessDenied`**

The IAM policy update in Step 6 did not save or has a typo. Go to IAM → **Roles** → `github-actions-chat-analyzer-role` → Permissions → open the attached policy → JSON tab, and confirm the `S3Frontend` and `CloudFrontInvalidate` statements are present with the correct bucket name and distribution ID.

If the error is `Not authorized to perform sts:AssumeRoleWithWebIdentity` instead, the problem is the role's *trust* policy, not its permissions — the job is missing `environment: production` (so `AWS_ROLE_ARN` resolved to an empty string) or the workflow lost `permissions: id-token: write`.

**CloudFront invalidation fails in GitHub Actions**

The `CLOUDFRONT_DISTRIBUTION_ID` secret in the GitHub `production` environment is missing or wrong (Step 7). Double check it matches the distribution ID shown in the CloudFront console (format: `E1A2B3C4D5E6F7`).

**Users still see the old frontend after a deploy**

The CloudFront invalidation for `index.html` ran but the user's browser cached it locally (not CloudFront — browser cache). Ask them to hard refresh (`Ctrl+Shift+R`). For future deploys, confirm the `Sync index.html` step uses `--cache-control "no-cache"` so the browser does not cache it at all.

**Certificate not found when creating the CloudFront distribution**

ACM certificates must be in `us-east-1` for CloudFront. If you requested the certificate in a different region (e.g., `eu-west-1`), it will not appear in the CloudFront dropdown. Request a new certificate in `us-east-1` (Step 2) and use that one instead.
