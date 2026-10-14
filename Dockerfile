FROM node:20-slim

WORKDIR /app

# Copy dependency manifests first (better layer caching)
COPY package*.json ./

# Install ALL dependencies — devDependencies (vite, esbuild, tsx) are needed for the build step
RUN npm install

# Copy the rest of the source
COPY . .

# Runs: vite build && esbuild server/index.ts ... --outfile=dist/server.cjs
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Runs: node dist/server.cjs
CMD ["npm", "start"]
