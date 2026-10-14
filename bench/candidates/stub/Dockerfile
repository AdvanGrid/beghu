FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY . .
ENV NODE_NO_WARNINGS=1
EXPOSE 8080
CMD ["node", "server.mjs"]
