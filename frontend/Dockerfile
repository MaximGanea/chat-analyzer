# ---- Base (Node) ----
FROM node:22-alpine AS base

WORKDIR /app

COPY package*.json .
RUN npm ci

# ---- Development ----
FROM base AS dev

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev"]

# The production build runs on the GitHub Actions runner and is synced to S3
# (see .github/workflows/cd.yml). No image is built for the frontend.
