# Runtime Libraries

## Layout

Runtime libraries use a simple on-disk layout:

```text
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  staging/
```

## Activation model

- install/remove jobs build a candidate set in `staging/`
- the candidate is validated before activation
- activation swaps `staging/` into `current/`
- if activation fails, the previous `current/` set is restored

## Compatibility

Startup still migrates the older `active-release` plus `releases/NNNN/` layout into `current/` if it exists.

## Resolution

- API-side code execution resolves packages from `current/node_modules`
- executor-side code execution resolves packages from the same path via the bundle patch
