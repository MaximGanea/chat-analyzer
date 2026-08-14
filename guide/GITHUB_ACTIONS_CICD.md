# GitHub Actions CI/CD Guide

Automate testing and deployment so every PR runs tests and every merge to main ships to production without a manual step.

**Prerequisites:** Phase 5 complete (EC2 + RDS + nginx running) · GitHub repo with the project · AWS account

---

## What changes from the manual deploy

Before this guide, deploying looked like this:

```
You → SSM Session Manager browser terminal → EC2 → git pull → docker build → docker run
```

After this guide:

```
You → git push / open PR
         │
         ▼
   GitHub Actions CI
   ├── test-backend  (pytest + real PostgreSQL)
   └── test-frontend (vitest)
         │  (both must pass — nothing deploys if tests fail)
         ▼
   GitHub Actions CD
   ├── build-and-push → ECR (image tagged with git SHA)
   ├── migrate        → SSM → EC2 → alembic upgrade head
   ├── deploy-backend → SSM → EC2 → docker pull + restart
   ├── deploy-frontend→ SSM → EC2 → git pull + npm build + copy
   └── smoke-test     → curl https://yourdomain.com/api/health
```

**Why ECR instead of building on EC2?**
Building a Docker image on a t3.small is slow (~3–5 minutes) and consumes CPU that the running app also needs. Building in GitHub Actions (fast multi-core runners) and pushing to ECR means EC2 only runs `docker pull` — seconds, not minutes. ECR also gives you an image history: every SHA-tagged image can be re-deployed in seconds for rollback.

**Why ECR instead of Docker Hub?**
ECR is private by default and uses the same IAM credentials you already have — no separate Docker Hub account needed. ECR pulls from EC2 go over AWS's private network, not the public internet, so there are no rate limits and no bandwidth cost.

---

## Quick reference

After setup, deployment is fully automatic. Check pipeline status:

```
GitHub → your repo → Actions tab
```

To trigger a deploy manually without a code change (e.g., re-run a failed deploy):

```
GitHub → Actions → CD → Run workflow → Branch: main
```

To check why an SSM command failed from a CD job — open **AWS Console → Systems Manager → Run Command → Command history**, find the Command ID printed in the job log, click it, and read the **Output** tab.

---

## Step 1 — Create the ECR repository

ECR (Elastic Container Registry) is a private Docker registry inside your AWS account.

1. AWS Console → **ECR** → **Get started** (or **Create repository**)
2. Visibility: **Private**
3. Repository name: `temple-project-backend`
4. **Image tag mutability:** leave as **Mutable** (default) — this lets the `:latest` tag be overwritten on each push, which is what the CD workflow does
5. **Encryption:** leave as **AES-256** (default)
6. → **Create repository**

> **Image scanning note:** AWS has moved CVE scanning from per-repository settings to a registry-level configuration. If you want it, go to ECR → **Private registry** → **Scanning** after repository creation and configure it there. It is not required for the pipeline to function.

After creation, click the repository name. In the top right, note the **URI** — it looks like:

```
123456789012.dkr.ecr.eu-central-1.amazonaws.com/temple-project-backend
```

The part before the first `/` (`123456789012.dkr.ecr.eu-central-1.amazonaws.com`) is your **registry URL**. You will need it in later steps.

---

## Step 2 — Set up OIDC federation and create the deployment role

Instead of creating long-term AWS access keys, GitHub Actions will use OIDC (OpenID Connect) to get short-lived credentials. Each workflow job requests a token from GitHub's identity provider, exchanges it for temporary AWS credentials valid only for that job's duration, and those credentials expire automatically when the job ends. Nothing to store, nothing to rotate, nothing to leak.

### 2.1 Create the GitHub OIDC identity provider

IAM → **Identity providers** → **Add provider**

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com` (AWS fetches the thumbprint automatically when you enter the URL)
- Audience: `sts.amazonaws.com`

→ **Add provider**

> You only need to do this once per AWS account. If you have set it up before for another project, skip this step — check by looking for `token.actions.githubusercontent.com` in IAM → Identity providers.

### 2.2 Create the permissions policy

IAM → **Policies** → **Create policy** → **JSON** tab.

Replace `ACCOUNT_ID` with your 12-digit AWS account ID (visible in the top-right corner of the console, click your username) and `INSTANCE_ID` with your EC2 instance ID (EC2 → Instances → click your instance → copy the Instance ID starting with `i-`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ECRPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeRepositories"
      ],
      "Resource": "arn:aws:ecr:eu-central-1:ACCOUNT_ID:repository/temple-project-backend"
    },
    {
      "Sid": "SSMSend",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:eu-central-1::document/AWS-RunShellScript",
        "arn:aws:ec2:eu-central-1:ACCOUNT_ID:instance/INSTANCE_ID"
      ]
    },
    {
      "Sid": "SSMPoll",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

→ **Next** → Name: `github-actions-temple-project-policy` → **Create policy**

**Why are both resource ARNs needed in `SSMDeploy`?**
AWS SSM requires you to grant permission on both the SSM document being used (`AWS-RunShellScript`) and the specific EC2 instance. Without both, the command is denied. Listing the exact instance ID also means these credentials cannot be used to run commands on any other instance in your account.

**Why is `ECRPush` scoped to one repository?**
If these credentials are ever compromised, an attacker can only push to `temple-project-backend`. They cannot touch other ECR repos, cannot reach RDS, cannot access S3 — nothing outside what is listed here.

### 2.3 Create the IAM role

IAM → **Roles** → **Create role**

1. Trusted entity type: **Web identity**
2. Identity provider: `token.actions.githubusercontent.com`
3. Audience: `sts.amazonaws.com`
4. Fill in the GitHub fields:
   - **GitHub organization:** your GitHub username (for personal accounts this is just your username, e.g. `MaximGanea`)
   - **GitHub repository:** `temple-project`
   - **GitHub branch:** leave blank (allows all branches and PR events)
5. → **Next** → search for `github-actions-temple-project-policy` → check it → **Next**
6. Role name: `github-actions-temple-project-role` → **Create role**

After creation, click the role name and copy the **ARN** shown at the top of the page — it looks like `arn:aws:iam::123456789012:role/github-actions-temple-project-role`. You will need it in Step 5.

**Why fill in the repository?**
AWS uses these fields to build a trust condition scoped to your specific repo. Without it, any GitHub Actions workflow in any repository on GitHub could assume this role and push images to your ECR. Leaving branch blank is intentional — it allows both push-to-main (CD) and pull-request (CI) events.

---

## Step 3 — Grant EC2 permission to pull from ECR

When GitHub Actions tells EC2 to run `docker pull`, EC2 authenticates with ECR using its IAM role (`temple-project-ec2-ssm-role`). You need to add ECR read permission to that role.

1. IAM → **Roles** → search for `temple-project-ec2-ssm-role` → click it
2. **Add permissions** → **Attach policies**
3. Search for `AmazonEC2ContainerRegistryReadOnly` → check it → **Add permissions**

Verify both policies are now listed under **Permissions policies**:
- `AmazonSSMManagedInstanceCore`
- `AmazonEC2ContainerRegistryReadOnly`

---

## Step 4 — Verify EC2 can authenticate with ECR

Before wiring this into GitHub Actions, confirm EC2 can actually reach ECR. Do this from the SSM Session Manager browser terminal — the same way you deployed in Phase 5.

EC2 → Instances → `temple-project-prod` → **Connect** → **Session Manager** → **Connect**

In the terminal:

```bash
# Replace with your registry URL from Step 1
REGISTRY=123456789012.dkr.ecr.eu-central-1.amazonaws.com

aws ecr get-login-password --region eu-central-1 | \
  docker login --username AWS --password-stdin $REGISTRY
```

Expected output:

```
Login Succeeded
```

If you see `An error occurred (AccessDeniedException)` — the `AmazonEC2ContainerRegistryReadOnly` policy from Step 3 is not attached. Go back and verify.

If you see `no basic auth credentials` — wait 30 seconds after attaching the policy and try again. IAM changes propagate within seconds but the instance metadata cache can briefly lag.

---

## Step 5 — Create the GitHub Actions Environment

**Environments vs. repository secrets — what is the difference?**

- **Repository secrets** are available to every workflow in the repo by default, including workflows triggered by PRs from forks.
- **Environment secrets** are scoped to a named environment (e.g., `production`). Only jobs that explicitly declare `environment: production` can read them. You can also add **protection rules** — for example, requiring a manual approval before any deploy job is allowed to access the environment and its secrets. This means a broken PR cannot accidentally trigger a production deploy.

### 5.1 Create the environment

GitHub → your repo → **Settings** → **Environments** → **New environment**

Name: `production` → **Configure environment**

**Optional but recommended while you are learning the pipeline:** under **Deployment protection rules**, check **Required reviewers** and add yourself. This adds a manual approval gate — every deploy pauses and waits for you to click Approve before the deploy jobs run. Once you have seen the pipeline succeed a few times and trust it, remove the rule so deploys are fully automatic.

### 5.2 Add environment secrets

Still on the `production` environment page, scroll to **Environment secrets** → **Add secret** — add both:

| Secret name | Value |
|---|---|
| `AWS_ROLE_ARN` | The role ARN from Step 2.3 (e.g., `arn:aws:iam::123456789012:role/github-actions-temple-project-role`) |
| `EC2_INSTANCE_ID` | Your EC2 instance ID (e.g., `i-0abc123def456`) |

Find your instance ID: EC2 → Instances → click `temple-project-prod` → **Instance ID** field.

---

## Step 6 — Create the CI workflow

The CI workflow runs on every pull request. It must pass before the PR can merge. It does not deploy anything.

Create the directory and file: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  test-backend:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_pass
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: pip
          cache-dependency-path: backend/requirements-test.txt

      - name: Install dependencies
        run: pip install -r requirements-test.txt
        working-directory: backend

      - name: Run pytest
        env:
          TEST_DATABASE_URL: postgresql+asyncpg://test_user:test_pass@localhost:5432/test_db
          JWT_SECRET_KEY: ci-secret-not-for-production
          ENVIRONMENT: test
        run: pytest
        working-directory: backend

  test-frontend:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install dependencies
        run: npm ci
        working-directory: frontend

      - name: Run vitest
        run: npm run test:run
        working-directory: frontend
```

**What is a service container?**
The `services:` block tells GitHub Actions to start a real PostgreSQL 17 container alongside the test runner job. The `options:` health check block makes the job wait until PostgreSQL is accepting connections before the tests start — so there is no race condition where tests run before the database is ready. The database is reachable at `localhost:5432` from within the job.

**Why `ENVIRONMENT: test`?**
`pydantic-settings` reads settings from environment variables. Setting `ENVIRONMENT=test` prevents any validators that check for `production` from enforcing production-only rules during the test run.

**Why `cache: pip` and `cache: npm`?**
These tell the setup actions to store the downloaded packages bRun IMAGE="$REGISTRY/$ECR_REPO:$SHA"
SSM command ID: 415bfb98-a960-4a1c-a1e8-52f74f153631

Error: RROR]: Waiter CommandExecuted failed: An error occurred (AccessDeniedException): User: arn:aws:sts::047719659761:assumed-role/github-actions-temple-project-role/GitHubActions is not authorized to perform: ssm:GetCommandInvocation on resource: arn:aws:ssm:eu-central-1:047719659761:* because no identity-based policy allows the ssm:GetCommandInvocation action
Error: Process completed with exit code 255.etween runs. When `requirements-test.txt` or `package-lock.json` has not changed, packages are restored from cache instead of re-downloaded. Saves 30–60 seconds per run.

---

## Step 7 — Create the CD workflow

The CD workflow runs on every push to main (which happens automatically when a PR is merged). It re-runs the same tests, then deploys if they pass.

Create `.github/workflows/cd.yml`:

```yaml
name: CD

on:
  push:
    branches: [main]

env:
  AWS_REGION: eu-central-1
  ECR_REPO: temple-project-backend

permissions:
  id-token: write   # required for OIDC token request
  contents: read    # required for actions/checkout

jobs:
  # ── Tests ──────────────────────────────────────────────────────────────────
  # Run again on push to main. The merged commit may differ from the PR branch
  # if two PRs merged at the same time — that combined state was never tested
  # by CI. Never deploy untested code.

  test-backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_pass
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: pip
          cache-dependency-path: backend/requirements-test.txt
      - run: pip install -r requirements-test.txt
        working-directory: backend
      - name: Run pytest
        env:
          TEST_DATABASE_URL: postgresql+asyncpg://test_user:test_pass@localhost:5432/test_db
          JWT_SECRET_KEY: ci-secret-not-for-production
          ENVIRONMENT: test
        run: pytest
        working-directory: backend

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npm run test:run
        working-directory: frontend

  # ── Build ──────────────────────────────────────────────────────────────────

  build-and-push:
    needs: [test-backend, test-frontend]
    runs-on: ubuntu-latest
    environment: production
    outputs:
      registry: ${{ steps.login-ecr.outputs.registry }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Log in to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          SHA: ${{ github.sha }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPO:$SHA"

          docker build \
            -t "$IMAGE" \
            -t "$REGISTRY/$ECR_REPO:latest" \
            ./backend --target prod

          docker push "$IMAGE"
          docker push "$REGISTRY/$ECR_REPO:latest"

          echo "Pushed: $IMAGE"

  # ── Migrate ────────────────────────────────────────────────────────────────
  # Runs BEFORE replacing the running container. New code always expects the
  # new schema. If you swap the container first and the migration has not run,
  # the first requests hit new code against the old schema → 500 errors.

  migrate:
    needs: build-and-push
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Run alembic upgrade head on EC2
        env:
          REGISTRY: ${{ needs.build-and-push.outputs.registry }}
          SHA: ${{ github.sha }}
          INSTANCE_ID: ${{ secrets.EC2_INSTANCE_ID }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPO:$SHA"

          cat > /tmp/ssm-migrate.json << ENDJSON
          {
            "InstanceIds": ["${INSTANCE_ID}"],
            "DocumentName": "AWS-RunShellScript",
            "Parameters": {
              "commands": [
                "set -e",
                "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${REGISTRY}",
                "docker pull ${IMAGE}",
                "docker run --rm --env-file /opt/temple-project/repo/backend/.env ${IMAGE} alembic upgrade head"
              ]
            }
          }
          ENDJSON

          COMMAND_ID=$(aws ssm send-command \
            --cli-input-json "file:///tmp/ssm-migrate.json" \
            --query 'Command.CommandId' --output text)

          echo "SSM command ID: $COMMAND_ID"

          aws ssm wait command-executed \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" || true

          STATUS=$(aws ssm get-command-invocation \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' --output text)

          echo "Migration status: $STATUS"

          if [ "$STATUS" != "Success" ]; then
            echo "--- stderr from EC2 ---"
            aws ssm get-command-invocation \
              --command-id "$COMMAND_ID" \
              --instance-id "$INSTANCE_ID" \
              --query 'StandardErrorContent' --output text
            exit 1
          fi

  # ── Deploy backend ─────────────────────────────────────────────────────────

  deploy-backend:
    needs: [build-and-push, migrate]
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Replace backend container on EC2
        env:
          REGISTRY: ${{ needs.build-and-push.outputs.registry }}
          SHA: ${{ github.sha }}
          INSTANCE_ID: ${{ secrets.EC2_INSTANCE_ID }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPO:$SHA"

          cat > /tmp/ssm-deploy-backend.json << ENDJSON
          {
            "InstanceIds": ["${INSTANCE_ID}"],
            "DocumentName": "AWS-RunShellScript",
            "Parameters": {
              "commands": [
                "set -e",
                "docker stop temple-project-backend || true",
                "docker rm temple-project-backend || true",
                "docker run -d --name temple-project-backend --restart unless-stopped --env-file /opt/temple-project/repo/backend/.env -p 127.0.0.1:8000:8000 ${IMAGE}"
              ]
            }
          }
          ENDJSON

          COMMAND_ID=$(aws ssm send-command \
            --cli-input-json "file:///tmp/ssm-deploy-backend.json" \
            --query 'Command.CommandId' --output text)

          echo "SSM command ID: $COMMAND_ID"

          aws ssm wait command-executed \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" || true

          STATUS=$(aws ssm get-command-invocation \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' --output text)

          echo "Deploy status: $STATUS"

          if [ "$STATUS" != "Success" ]; then
            echo "--- stderr from EC2 ---"
            aws ssm get-command-invocation \
              --command-id "$COMMAND_ID" \
              --instance-id "$INSTANCE_ID" \
              --query 'StandardErrorContent' --output text
            exit 1
          fi

  # ── Deploy frontend ────────────────────────────────────────────────────────
  # Runs in parallel with migrate + deploy-backend — frontend and backend are
  # independent. Both must finish before the smoke test runs.
  # Note: this step will be replaced by S3 + CloudFront in Phase 7.

  deploy-frontend:
    needs: build-and-push
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Build and copy frontend on EC2
        env:
          INSTANCE_ID: ${{ secrets.EC2_INSTANCE_ID }}
        run: |
          cat > /tmp/ssm-deploy-frontend.json << ENDJSON
          {
            "InstanceIds": ["${INSTANCE_ID}"],
            "DocumentName": "AWS-RunShellScript",
            "Parameters": {
              "commands": [
                "set -e",
                "export HOME=/root",
                "git config --global --add safe.directory /opt/temple-project/repo",
                "cd /opt/temple-project/repo",
                "git pull",
                "cd frontend",
                "npm ci",
                "VITE_API_URL= npm run build",
                "rm -rf /var/www/html/*",
                "cp -r dist/. /var/www/html/",
                "chown -R nginx:nginx /var/www/html",
                "chmod -R 755 /var/www/html"
              ]
            }
          }
          ENDJSON

          COMMAND_ID=$(aws ssm send-command \
            --cli-input-json "file:///tmp/ssm-deploy-frontend.json" \
            --query 'Command.CommandId' --output text)

          echo "SSM command ID: $COMMAND_ID"

          aws ssm wait command-executed \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" || true

          STATUS=$(aws ssm get-command-invocation \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' --output text)

          echo "Frontend deploy status: $STATUS"

          if [ "$STATUS" != "Success" ]; then
            echo "--- stderr from EC2 ---"
            aws ssm get-command-invocation \
              --command-id "$COMMAND_ID" \
              --instance-id "$INSTANCE_ID" \
              --query 'StandardErrorContent' --output text
            exit 1
          fi

  # ── Smoke test ─────────────────────────────────────────────────────────────
  # Polls the health endpoint after both deploys finish. If the backend did not
  # come up, the pipeline fails here and you are notified before any user hits
  # a broken state.

  smoke-test:
    needs: [deploy-backend, deploy-frontend]
    runs-on: ubuntu-latest

    steps:
      - name: Wait for container to start
        run: sleep 5

      - name: Health check
        run: |
          for i in $(seq 1 6); do
            STATUS=$(curl -sf https://yourdomain.com/api/health \
              | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null \
              || echo "")

            if [ "$STATUS" = "ok" ]; then
              echo "Health check passed on attempt $i"
              exit 0
            fi

            echo "Attempt $i: not ready (got: '$STATUS'), retrying in 10s..."
            sleep 10
          done

          echo "ERROR: health check failed after 6 attempts"
          exit 1
```

**What is `aws-actions/configure-aws-credentials`?**
This is an official GitHub Action published by AWS. It takes the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment secrets and makes them available to all subsequent `aws` CLI calls in that job. The `aws` CLI is pre-installed on all GitHub Actions `ubuntu-latest` runners — you do not install it yourself.

**What is `aws-actions/amazon-ecr-login`?**
Another official AWS action. It runs `docker login` against your ECR registry using the credentials from `configure-aws-credentials`. After this step, all `docker push` and `docker pull` commands in the job can reach your ECR registry. Its `outputs.registry` gives you the registry URL without having to hardcode your account ID.

**What does `aws ssm send-command` do and why is it in the workflow?**
`aws ssm send-command` tells the SSM agent running on your EC2 instance to execute a shell script — without SSH, without opening any port. It is how the GitHub Actions runner (running on GitHub's servers) tells your EC2 instance to run `docker pull`, `docker run`, etc. This is the same SSM mechanism you used for Phase 5 manually, but automated. The `aws ssm wait command-executed` line blocks the job until the script finishes, and `aws ssm get-command-invocation` retrieves the exit status. If the script failed, the stderr output is printed to the job log and the job fails.

**Why chain commands with `&&` in a single string?**
`AWS-RunShellScript` runs each element of the `commands` array independently. If one element fails, subsequent elements still run. Using `&&` within a single string means the whole chain stops at the first failure — a failed `docker pull` will not be followed by an attempt to `docker run` the image that wasn't pulled.

**Why tag with `github.sha`?**
Every image is permanently tagged with the exact git commit that produced it. To roll back, you only need the previous SHA from git log — pull that specific image and run it. No rebuilding required. The `:latest` tag is a convenience alias for the most recent push; the SHA tag is the stable, immutable reference.

**Job dependency diagram:**

```
test-backend ──┐
               ├──► build-and-push ──► migrate ──► deploy-backend ──┐
test-frontend ─┘                  └──────────────► deploy-frontend ──┴──► smoke-test
```

---

## Step 8 — Push the workflows and trigger your first deploy

```bash
mkdir -p .github/workflows
# create ci.yml and cd.yml as above
git add .github/workflows/ci.yml .github/workflows/cd.yml
git commit -m "add CI/CD workflows"
```

**Test CI before triggering a production deploy — push to a branch, not main:**

```bash
git checkout -b add-cicd
git push -u origin add-cicd
```

Open a PR from `add-cicd` → `main` on GitHub. Both `test-backend` and `test-frontend` jobs appear in the PR within seconds. Watch them pass. If they fail, the log shows exactly which test failed and why.

Once CI passes, merge the PR. The push to main triggers the CD workflow. Go to **Actions** tab and watch it run through all 6 jobs in sequence.

> **Private repository note:** The `deploy-frontend` job runs `git pull` on EC2. If your repo is private, EC2 needs credentials to pull from GitHub. The quickest fix: generate a GitHub Personal Access Token (read-only, `repo` scope) and update the remote in the SSM terminal:
>
> ```bash
> cd /opt/temple-project/repo
> git remote set-url origin https://YOUR_PAT@github.com/youruser/temple-project.git
> ```

---

## Step 9 — How to roll back a broken deploy

Each deploy is tagged with its git SHA. If the new deploy breaks something, you can revert in two ways:

**Option 1 — Roll back the backend container immediately** (fastest, ~30 seconds):

Open SSM Session Manager on EC2 and run:

```bash
# Find the previous SHA
cd /opt/temple-project/repo
git log --oneline -5

# Replace PREV_SHA with the commit before the broken one
REGISTRY=123456789012.dkr.ecr.eu-central-1.amazonaws.com
PREV_SHA=abc1234

docker stop temple-project-backend
docker rm temple-project-backend
docker pull $REGISTRY/temple-project-backend:$PREV_SHA
docker run -d --name temple-project-backend --restart unless-stopped \
  --env-file /opt/temple-project/repo/backend/.env \
  -p 127.0.0.1:8000:8000 \
  $REGISTRY/temple-project-backend:$PREV_SHA
```

This works because the previous image is still in ECR with its SHA tag. No rebuild needed.

**Option 2 — Revert the commit and re-deploy through the pipeline** (cleaner history):

```bash
git revert HEAD
git push origin main
# CD pipeline triggers automatically and deploys the reverted state
```

Option 2 keeps the git history honest — there is a record of what broke and when it was reverted. Prefer it unless you need to recover in under a minute.

---

## Step 10 — Validation checklist

Run this after the first successful pipeline run:

- [ ] Open a PR on a feature branch → both CI jobs appear and pass → PR unblocked
- [ ] Break a test intentionally on a branch → CI fails → PR cannot merge
- [ ] Merge the PR → CD pipeline triggers → all 6 jobs pass
- [ ] ECR console shows the image tagged with the merge commit SHA: ECR → `temple-project-backend` → Images
- [ ] In SSM session on EC2: `docker ps` shows `temple-project-backend` running the new SHA-tagged image
- [ ] Smoke test in the pipeline passes: health endpoint returns `{"status":"ok"}`
- [ ] Full flow from your phone: register → login → hard refresh → logout

---

## Troubleshooting

**CD job fails with `Could not assume role` or `Error: Credentials could not be loaded`**

The OIDC trust is misconfigured. Check two things:
1. The OIDC identity provider exists in IAM → Identity providers — the URL must be exactly `https://token.actions.githubusercontent.com`.
2. The trust policy on `github-actions-temple-project-role` has the correct `sub` condition. Go to IAM → Roles → the role → **Trust relationships** → **Edit trust policy** and verify the `StringLike` value matches your actual GitHub username and repo name (`repo:YOURUSER/temple-project:*`). A typo here means the role refuses every request.

**SSM command in CD job shows `AccessDenied`**

The IAM role policy is missing the `ec2:instance/INSTANCE_ID` or `ssm:document/AWS-RunShellScript` resource ARN. Go to IAM → Roles → `github-actions-temple-project-role` → Permissions → click the policy → Edit → verify both ARNs in the `SSMDeploy` statement match your actual account ID and instance ID.

**`docker pull` fails on EC2 (migration or deploy job)**

EC2 cannot authenticate with ECR. Check that `AmazonEC2ContainerRegistryReadOnly` is attached to `temple-project-ec2-ssm-role` (IAM → Roles → the role → Permissions tab). Open an SSM session and re-run the Step 4 verification command.

**`git pull` fails in `deploy-frontend` (private repo)**

EC2 has no GitHub credentials. Set the remote URL with a PAT as described in Step 8. The PAT needs `repo` scope (read-only is enough for `git pull`).

**SSM command status is `Failed` but I can not see the error in the job log**

The stderr is printed by the `if [ "$STATUS" != "Success" ]` block in the workflow. If you need more detail, go to **AWS Console → Systems Manager → Run Command → Command history**, find the Command ID printed near the top of the failed job step, click it, select the instance, and read the **Output** tab — it shows the full stdout and stderr of every command.

**Migration step fails with `could not connect to server`**

The migration container cannot reach RDS. The `--env-file` path in the `docker run` command points to `/opt/temple-project/repo/backend/.env` — verify that file exists on EC2:

```bash
# In SSM session on EC2
ls -la /opt/temple-project/repo/backend/.env
```

If the file exists, check that `DATABASE_URL` in it still has the correct RDS endpoint.

**Smoke test fails but the app seems fine**

The health endpoint URL in the workflow is hardcoded as `https://yourdomain.com/api/health`. Replace `yourdomain.com` with your actual domain. Also verify the endpoint manually:

```bash
curl https://yourdomain.com/api/health
```

If the endpoint returns `{"status":"ok"}` but the smoke test still fails, the container may need more than 5 seconds to start. Increase `sleep 5` to `sleep 15`.

**GitHub Actions job is waiting for approval before deploy jobs run**

You added a required reviewer to the `production` environment in Step 5. Go to **Actions** → click the running workflow → click **Review deployments** → **Approve and deploy**. Once you trust the pipeline, remove the protection rule: GitHub → Settings → Environments → production → delete the reviewer rule.
