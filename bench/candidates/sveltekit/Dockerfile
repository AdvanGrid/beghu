FROM docker.io/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY --from=build /app/build build
COPY --from=build /app/node_modules node_modules
COPY package.json ./
ENV NODE_ENV=production NODE_NO_WARNINGS=1
EXPOSE 8080
CMD ["node", "build"]
