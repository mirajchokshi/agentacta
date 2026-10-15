# AgentActa as the benchmark runs it: the repo's built output on Node 24.
FROM node:24-bookworm
LABEL aabench=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3
COPY dist ./dist
COPY public ./public
COPY index.js ./
ENV HOME=/data/home AGENTACTA_DB_PATH=/state/agentacta.db AGENTACTA_HOST=0.0.0.0 AGENTACTA_ALLOW_UNAUTHENTICATED_NETWORK=1 PORT=4003
EXPOSE 4003
CMD ["node", "dist/index.js"]
