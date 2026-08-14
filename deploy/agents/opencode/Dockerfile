FROM node:22.23.1-alpine3.23

ARG OPENCODE_VERSION=1.18.18
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /var/lib/opencode /workspace \
    && chown -R node:node /var/lib/opencode /workspace

COPY --chown=node:node opencode.json /etc/opencode/opencode.json
COPY --chmod=755 entrypoint.sh /usr/local/bin/opencode-entrypoint
COPY --chmod=755 healthcheck.js /usr/local/bin/opencode-healthcheck

ENV HOME=/var/lib/opencode \
    OPENCODE_CONFIG=/etc/opencode/opencode.json
VOLUME ["/var/lib/opencode"]
WORKDIR /workspace
USER node
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
