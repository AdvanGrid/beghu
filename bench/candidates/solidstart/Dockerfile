FROM docker.io/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY --from=build /app/.output .output
ENV NODE_NO_WARNINGS=1 NODE_ENV=production
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
