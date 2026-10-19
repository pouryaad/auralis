FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/.cache && chown node:node /app/.cache
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "serve.js", "--daemon"]
