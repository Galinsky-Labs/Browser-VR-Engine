# Deployment

Engine services are not deployed. The only hosted artifact is the static example world (below); it is a demo deployment, not production or device qualification.

## Local development

Install Node 24 and npm, clone the repository, then run:

```sh
npm ci
npm run check
npm run example:sdk
```

## Planned hosted services

F08 establishes generic control/data interfaces. N08/N09 implement world routing/recovery. M07 qualifies media and TURN networking. R01 packages the service stack; R02-R08 qualify configuration, recovery and supported deployment profiles. XLR8 deployment is C25 after the engine is complete.

Deploy immutable tested artifacts. Keep service credentials out of browser bundles and Git. Use migrations with a restore or forward-repair path. Record actual domain, region, service versions and rollback evidence at deployment rather than describing an unprovisioned environment as live.

## Example world static site (Render)

`render.yaml` declares the free Render static site `browser-vr-engine` (Galinsky Laboratories workspace, auto-deploy from `main`). Build: `npm ci --ignore-scripts --no-audit --no-fund && npm run example:world:build`; publish path `examples/world-demo/dist` (the example world, `/docs/` pages rendered from the repository records, and `THIRD_PARTY_NOTICES.txt`). Node is pinned with `NODE_VERSION=24.19.0`. No secrets, accounts or server APIs are involved. Locally: `npm run example:world` serves the same build at `http://127.0.0.1:8787/`.

WebXR needs HTTPS, which Render provides. Immersive entry appears only when the browser reports an `immersive-vr` device; it has not been observed on a physical headset.
