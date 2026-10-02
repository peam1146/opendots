# OpenBot computer services

OpenDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

Local Compose tags them `opendots-computer:b6932d3` and `opendots-supervisor:b6932d3-dot-auth` (see `compose.computers.yml`). Softnetics GHCR publishes the same recipes as:

- `ghcr.io/softnetics/opendots-computer` (tags include `b6932d3`, plus semver/sha variants)
- `ghcr.io/softnetics/opendots-supervisor` (tags include `b6932d3-dot-auth`, plus semver/sha variants)

Workflow: [`.github/workflows/publish-computer-images.yml`](../../.github/workflows/publish-computer-images.yml) (`v*` tags and `workflow_dispatch`). Digests appear in the Actions job summary for GitOps pinning. **Always deploy a supervisor image with the computer image revision it expects** (same OpenBot pin / preferably the same publish run). Set supervisor env `COMPUTER_IMAGE` to the published computer digest (for example `ghcr.io/softnetics/opendots-computer@sha256:…`).

The computer service is unchanged. The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies fail-closed patches:

1. **Per-Dot credentials:** each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.
2. **Missing image pull:** on ensure’s create path, if `COMPUTER_IMAGE` is not present in the supervisor’s Docker Engine, the supervisor pulls it before `createContainer`. Upstream OpenBot assumes the image is already local (Compose builds it first); DinD often does not. Pulls use the engine’s configured registry credentials — this patch does not embed secrets. Private GHCR images still need DinD auth (for example a pull secret / `docker login`); anonymous pull only works when the registry allows it.
3. **Clearer ensure failures:** missing image / pull failures return `ImageUnavailableError` with an explicit message (still HTTP 503). The OpenDots app forwards that body to the UI instead of a bare status code.
4. **Cluster publish (option B):** when `COMPUTER_ACCESS_HOST` is set, ensure publishes each computer’s `4100` on `0.0.0.0` at a deterministic host port in `COMPUTER_PUBLISH_PORT_BASE`+`SPAN` and returns `http://{COMPUTER_ACCESS_HOST}:{port}` so an app Pod on the cluster CNI can reach it via Service DNS. This avoids co-locating the web app with privileged DinD and avoids a reverse-proxy sidecar as the primary design. See [Kubernetes / DinD](../../docs/COMPUTERS.md#kubernetes--dind-cluster-reachable-computers).

If the pinned upstream line changes, the patch refuses to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and this patch together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
