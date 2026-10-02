# OpenBot computer services

OpenDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

Local Compose tags them `opendots-computer:b6932d3` and `opendots-supervisor:b6932d3-dot-auth` (see `compose.computers.yml`). Softnetics GHCR publishes the same recipes as:

- `ghcr.io/softnetics/opendots-computer` (tags include `b6932d3`, plus semver/sha variants)
- `ghcr.io/softnetics/opendots-supervisor` (tags include `b6932d3-dot-auth`, plus semver/sha variants)

Workflow: [`.github/workflows/publish-computer-images.yml`](../../.github/workflows/publish-computer-images.yml) (`v*` tags and `workflow_dispatch`). Digests appear in the Actions job summary for GitOps pinning. **Always deploy a supervisor image with the computer image revision it expects** (same OpenBot pin / preferably the same publish run). Set supervisor env `COMPUTER_IMAGE` to the published computer digest (for example `ghcr.io/softnetics/opendots-computer@sha256:…`).

The computer service is unchanged. The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies one fail-closed patch to child environment construction: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
