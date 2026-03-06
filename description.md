# Repository Description

## What this repository is

This repository is a self-hosted web wrapper around the upstream Rivet codebase stored in `rivet/`.

Its goal is to run Rivet as a browser-based application on a private VM while preserving practical parity with the desktop workflow:

- project editing
- graph execution
- Browser and Node executor modes
- datasets
- plugins
- project references
- revisions and related tooling

The repository is intentionally structured as a wrapper rather than a fork. The upstream `rivet/` tree is treated as vendor source, while hosted-specific behavior lives in the wrapper and operations layers.

## Purpose

The purpose of this repo is to make Rivet usable through a browser without taking ownership of long-lived custom changes inside upstream Rivet.

That means:

- `rivet/` remains replaceable and updateable
- hosted adaptations live outside `rivet/`
- desktop-only assumptions are replaced with browser, API, and Docker-backed equivalents
- deployment is designed around Docker Compose on a trusted self-hosted machine

## Core architectural idea

The browser app is still fundamentally the upstream Rivet app, but it is started through a wrapper-controlled frontend build.

The wrapper changes behavior in three main ways:

- it provides a custom web entrypoint and Vite configuration
- it replaces desktop/Tauri integrations with wrapper-owned shims and overrides
- it supplies backend and executor services that the browser can talk to over HTTP and WebSocket

In short:

- upstream app UI and core logic come from `rivet/`
- hosted integration logic comes from `wrapper/`
- deployment and runtime wiring come from `ops/`

## Repository layout

### `rivet/`

Vendored upstream Rivet source.

This repo treats it as external/vendor code. Wrapper-specific behavior should not be implemented directly inside this tree.

### `wrapper/web/`

Hosted frontend layer.

This area provides:

- the browser entrypoint
- Vite configuration
- browser-safe shims for Tauri APIs
- targeted overrides for upstream modules that assume desktop behavior
- hosted environment constants and frontend wiring

The frontend still renders the upstream Rivet application, but with hosted-specific replacements where needed.

### `wrapper/api/`

Compatibility backend for hosted mode.

It provides API endpoints for things that desktop Rivet normally does through Tauri or local native access, such as:

- file operations
- project loading and saving
- project reference loading
- shell command execution
- plugin installation/loading
- environment-variable access
- app-data path resolution

### `wrapper/shared/`

Shared contracts and environment helpers used across wrapper-owned pieces.

### `ops/`

Deployment and runtime wiring.

This area contains:

- Dockerfiles
- Docker Compose configuration
- nginx proxy configuration
- executor bundling logic
- related operational scripts

### `scripts/`

Developer helpers for local and Docker-based development flows.

### `findings-and-problems.md`

Working engineering handoff document that captures discovered constraints, bugs, fixes, and current status.

## Runtime wiring

The deployed application is composed of four main services:

### `web`

Builds and serves the hosted frontend bundle.

This is the browser-facing Rivet UI, built from wrapper-controlled Vite config while loading upstream app code from `rivet/packages/app`.

### `api`

Provides hosted compatibility endpoints.

This service replaces desktop-native capabilities with server-side operations exposed over HTTP.

### `executor`

Runs the Node-side Rivet executor and debugger server.

This enables hosted Node execution mode and websocket-based remote debugging/event forwarding.

### `proxy`

nginx entrypoint for the stack.

It fronts the other services and routes:

- browser requests to the web app
- API requests to the compatibility backend
- websocket traffic to the executor/debugger

## Frontend wiring

The hosted frontend works by booting the upstream Rivet app through wrapper-owned infrastructure.

Key points:

- `wrapper/web/entry.tsx` provides browser-safe global shims before loading the upstream app
- `wrapper/web/vite.config.ts` controls aliases and overrides
- wrapper-owned overrides replace desktop-oriented upstream modules where a shim alone is not enough
- hosted runtime values such as websocket URLs are derived from browser location in `wrapper/shared/hosted-env.ts`

This lets the wrapper preserve upstream UI behavior while redirecting platform-specific behavior to hosted implementations.

## Backend wiring

The backend exists to replace Tauri-native capabilities with API-backed ones.

Typical responsibilities include:

- reading and writing project files on the server
- listing directories and files inside allowed roots
- loading referenced projects
- running allowlisted shell commands
- managing plugin installation/loading
- exposing controlled environment values to the hosted app

The browser talks to this service through wrapper shims and overrides instead of talking to the local machine directly.

## Executor wiring

Hosted Node execution is provided by the separate executor service instead of a local desktop sidecar process.

Current model:

- the browser connects to the executor/debugger over websocket
- Node-mode runs are sent to the executor service
- processor/debugger events are streamed back to the browser
- the hosted Docker executor bundle is patched in `ops/bundle-executor.cjs` for deployment-specific behavior

That patching is used for hosted concerns such as:

- Docker-friendly binding behavior
- forwarding relevant executor traces to the browser
- surfacing Node Code-node console output in browser devtools as sidecar-style logs

## Important design rules

### Vendor boundary

Do not put wrapper-owned hosted behavior inside `rivet/`.

Hosted adaptations belong in:

- `wrapper/`
- `ops/`
- repo-level docs and scripts

### Wrapper-first integration

If upstream desktop behavior depends on Tauri, local sidecars, or direct filesystem access, the hosted implementation should solve it by:

- shim
- override
- backend API
- container/service wiring

not by permanently modifying vendored upstream source.

## Current practical outcome

This repo is a hosted Rivet distribution that keeps upstream Rivet as the application core while supplying the missing hosted platform layer around it.

That platform layer includes:

- browser-safe frontend bootstrapping
- hosted replacements for desktop integrations
- API-backed filesystem and shell capabilities
- Dockerized Node executor support
- nginx-based routing for HTTP and websocket traffic

The result is a maintainable self-hosted browser deployment of Rivet with a clear separation between upstream vendor code and wrapper-owned infrastructure.
