# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV ALL_PROXY=$ALL_PROXY
ENV NO_PROXY=$NO_PROXY
ENV http_proxy=$http_proxy
ENV https_proxy=$https_proxy
ENV all_proxy=$all_proxy
ENV no_proxy=$no_proxy

RUN apk add --no-cache git
RUN npm install -g pnpm

WORKDIR /app

COPY ops/proxy-bootstrap/ /opt/proxy-bootstrap/
RUN --mount=type=cache,target=/root/.npm npm --prefix /opt/proxy-bootstrap ci

COPY wrapper/api/ wrapper/api/
COPY wrapper/shared/ wrapper/shared/

WORKDIR /app/wrapper/api
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build

FROM node:24-alpine

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV ALL_PROXY=$ALL_PROXY
ENV NO_PROXY=$NO_PROXY
ENV http_proxy=$http_proxy
ENV https_proxy=$https_proxy
ENV all_proxy=$all_proxy
ENV no_proxy=$no_proxy

RUN apk add --no-cache git && \
    npm install -g pnpm && \
    addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /workspace /workflows /data/rivet-app/plugins /data/rivet-app/logs /data/runtime-libraries /home/rivet /opt/rivet/lib && \
    chown -R 10001:10001 /workspace /workflows /data /home/rivet /opt/rivet

WORKDIR /app/wrapper/api

COPY --from=builder --chown=10001:10001 /opt/proxy-bootstrap /opt/proxy-bootstrap
COPY --from=builder --chown=10001:10001 /app/wrapper/api /app/wrapper/api
COPY --from=builder --chown=10001:10001 /app/wrapper/shared /app/wrapper/shared
COPY --chown=10001:10001 image/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 image/lib/build-db-connection.mjs /opt/rivet/lib/build-db-connection.mjs
COPY --chown=10001:10001 image/api/entrypoint.sh /opt/rivet/api-entrypoint.sh

RUN chmod +x /opt/rivet/lib/load-env.sh /opt/rivet/api-entrypoint.sh

ENV HOME=/home/rivet
ENV PORT=8080
ENV RIVET_WORKSPACE_ROOT=/workspace
ENV RIVET_WORKFLOWS_ROOT=/workflows
ENV RIVET_APP_DATA_ROOT=/data/rivet-app
ENV RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries
ENV RIVET_RUNTIME_PROCESS_ROLE=api

EXPOSE 8080
USER 10001:10001

ENTRYPOINT ["/opt/rivet/api-entrypoint.sh"]
