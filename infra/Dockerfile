FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build

FROM node:24-bookworm-slim
ARG KUBECTL_VERSION=v1.34.1
# Seed HTTPS trust from Node's bundled public roots before installing system CAs.
RUN mkdir -p /etc/ssl/certs \
 && node -e "require('fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('tls').rootCertificates.join('\\n'))" \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" \
 && cd /tmp && printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum --check \
 && install -m 0755 kubectl /usr/local/bin/kubectl \
 && rm -rf /var/lib/apt/lists/* /tmp/kubectl*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 1000:1000
CMD ["node", "dist/packages/cloud/src/main.js"]
