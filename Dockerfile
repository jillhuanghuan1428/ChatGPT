FROM node:24-slim
WORKDIR /app
COPY package.json build.mjs ./
COPY .openai/hosting.json ./.openai/hosting.json
COPY worker ./worker
COPY migrations ./migrations
COPY drizzle ./drizzle
RUN node build.mjs
COPY serve.mjs ./serve.mjs
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DB_PATH=/data/borrowed-moon.sqlite
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "serve.mjs"]
