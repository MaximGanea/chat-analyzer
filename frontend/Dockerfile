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

# ---- Build ----
FROM base AS build

COPY . .
RUN npm run build

# ---- Production (nginx) ----
FROM nginx:1.27-alpine AS prod

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
