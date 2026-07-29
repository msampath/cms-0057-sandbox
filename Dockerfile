# CMS-0057-F Interoperability Simulator
#
# Single always-on container: the app needs a persistent Node process
# (file-backed JSON store, in-memory transaction log, timed pended-PA
# finalization), so classic serverless hosting does not fit. Python with
# pdfplumber is included so the live PDF extraction pipeline works in the
# deployed demo; without it the UM upload form degrades gracefully.
#
# Build and run locally:
#   docker build -t cms-0057-sandbox .
#   docker run -p 3000:3000 cms-0057-sandbox
#   open http://localhost:3000/cms-0057
#
# The container filesystem is ephemeral across redeploys. That is acceptable
# by design: lib/db.js re-seeds the rule snapshot and demo traffic on first
# touch after every boot.

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages pdfplumber

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
