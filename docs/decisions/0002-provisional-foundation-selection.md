# 0002 Provisional foundation selection (owner-deferred)

Date: 2026-11-15. Status: **provisional, owner-deferred decision — pending physical-headset verification.** This is not accepted F04/F05/F06 evidence.

## Context

F04 (Hubs/Spoke) and F05 (Babylon/VRSpace) remain blocked: neither has physical headset/controller/audio or target-device evidence, and F04's Hubs runtime diagnostic still needs a signed-in manual dispatch. The owner is unavailable and, through the delegated work brief of 2026-11-15, directed that work continue:

- physical-headset evidence cannot be produced here and must not be fabricated;
- the foundation selection (F06–F08) proceeds on the comparison evidence already in this repository, choosing the option the evidence favours and marking it provisional pending headset verification;
- ready World/Networking/Media/Assets/Runtime units continue where they need no paid provider.

## Decision

Select **Babylon.js 9.30.0** (rendering, WebXR, loaders, serializers) with **Rapier 0.21.0** physics as the provisional runtime foundation. VRSpace remains an evaluated reference for presence/pose and is not a production dependency. The Hubs/Spoke production path is retired; its evaluation tooling and evidence remain in `evaluations/hubs-spoke/` unchanged.

## Evidence that favours Babylon/VRSpace (all recorded before this decision)

| Criterion | Hubs/Spoke (F04) | Babylon/VRSpace (F05) |
| --- | --- | --- |
| Hosted browser checks | Spoke editor subset 13 checks (local); Hubs runtime/backend never executed | Desktop 19/19, emulated XR 10/10, portable world 9/9 on PR and main (`docs/evidence/F05-XR.md`, `F05-portable-readiness.md`) |
| Dependency health | Upstream Hubs audit fails: 106 entries, 14 critical / 64 high (`docs/evidence/F04.md`) | Required audits pass in CI |
| Multiuser | Reticulum/Dialog stack not run | Released VRSpace two-browser presence/pose/reconnect passed (`F05-service.md`) |
| Operations | Four-service stack (Hubs, Reticulum, Dialog, PostgreSQL) | Static client + optional released server; client runs without services |
| Portable worlds / roundtrip | Native Spoke project reload of mapped properties | Fresh-context authored-world reconstruction with colliders, animation and media bindings |
| Maintainability | Legacy graph needs patching before production | Current pinned packages, typed ESM, NullEngine for headless tests |

## Explicit gaps carried forward

- No physical headset, controller, spatial-audio or target-device performance observation exists for either candidate. `R08` and `M23/M26` keep these gates; until then the selection can be reversed.
- F04/F05 stay `blocked` in `docs/progress.json`; F06/F07 are marked `implemented` (code and records merged) with a provisional blocker, never `verified` or `accepted`.
- Reversal trigger: a failed physical-headset or device-workload qualification that Babylon cannot remedy with less sustainable work than adopting Hubs subsystems.

## Mapping and obligations

- Every remaining plan card is assigned reuse/adapt/implement in [`docs/foundation/capability-map.json`](../foundation/capability-map.json), validated by `scripts/check-foundation.mjs` against the full plan and dependency graph.
- Selected upstream versions, licenses and update ownership are pinned in [`docs/foundation/upstream-pins.json`](../foundation/upstream-pins.json) (F07). No source fork is needed at this stage. Babylon.js and Rapier are Apache-2.0; their notices ship with the example build (`legalComments: linked`).
- The engine boundary is unchanged: no package imports XLR8 or encodes conference roles.
