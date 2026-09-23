# Kosta fork releases

Only `KostaGorod/9router` publishes this pipeline. The daily upstream merge workflow runs at 03:17 UTC and can be run manually on `master`. It fetches every upstream master commit, not the GitHub releases feed. Normal merge commits preserve upstream and fork commit identities. Conflicts stop before any push and list the affected paths in the job summary.

The read-only validation job builds and tests the integrated source. A separate write job reproduces the exact deterministic commit and tree, rejects a moved fork head, and uses a normal fast-forward push. The same workflow then calls the image workflow. It does not rely on a GITHUB_TOKEN push triggering another workflow.

## Naming and retry behavior

Release tags are `v<upstream-version>-kosta.<N>`, for example `v0.5.86-kosta.1`. The version is the highest stable upstream tag ancestral to the selected upstream master commit. Tags are fetched into a separate namespace to distinguish upstream tags from fork tags. Untagged upstream commits still produce releases. Both package versions remain upstream-owned and are checked independently against upstream master. They do not need to equal each other or the release tag.

An existing fork tag for the exact commit is reused. Otherwise the next number under that upstream version is allocated. A tag is never moved. Fork-only commits can therefore produce the next number without a new upstream version. No-op runs validate and resume the same release rather than allocating another number.

Publication is serialized by the parent workflow. There is no direct tag-push or manual image-publish trigger. Imported upstream `v*` tags cannot publish unbranded images. A stale job must still match current fork master before tag allocation, manifest creation and stable promotion.

## Images and releases

The only image repository is `ghcr.io/kostagorod/9router`:

- `v0.5.86-kosta.1` is an immutable numbered manifest.
- `kosta` is the stable alias.
- This workflow does not publish `latest`, Docker Hub images or npm packages.

The upstream Dockerfile remains unchanged, including official registry defaults. Native amd64 and arm64 jobs build by digest and check `/api/health` before publishing a numbered manifest. A retry reuses an existing numbered manifest after verifying both platforms and OCI provenance, then health-checks it on both native runners again. The resolved multi-platform manifest receives another health check before stable promotion.

GitHub releases are stable, not prereleases, despite the suffix. They contain the exact fork commit, upstream master SHA/tag, fork commit list, upstream changelog link and registry digest. `version-manifest.json` is attached to the release and also retained as an Actions artifact. A draft release holds uploaded evidence until publication finishes. Partial failures are retried through the daily workflow; an existing numbered image or completed release is not silently replaced. Authentication, network and non-404 API failures stop the job.

PR CI builds the exact PR head, runs release fixtures and model regressions, and builds/health-checks both native container platforms without registry publication. PRs never receive publishing permissions. Merge the integration PR with a normal merge commit, never squash or rebase, so the imported upstream and fork SHAs remain ancestors of master.

## One-time GHCR visibility

A newly created GHCR package may be private. For anonymous pulls, the owner must open the GitHub profile's Packages page, select the `9router` container package, open Package settings, then Change visibility in the Danger Zone and select Public. Confirm the package name when GitHub requests it. Repository visibility does not automatically change package visibility.

Alternatively, consumers need an authenticated package pull with `read:packages`. This pipeline does not create or broaden credentials. Authenticated Actions manifest verification and the attached digest evidence remain available when anonymous reads are denied.

Watchtower installation, credentials, schedules and live service changes are outside this change. Nothing here deploys the image.

## Local verification

```sh
npm install --ignore-scripts --no-package-lock
npm --prefix tests install --ignore-scripts --no-package-lock
node --test tests/release/kosta-release.test.mjs
(cd tests && npx vitest run unit/custom-model-v1-list.test.js unit/custom-model-limits-route.test.js unit/model-token-limits.test.js unit/combo-context-marker.test.js unit/combo-capabilities.test.js)
npm run build
mise exec aqua:rhysd/actionlint@1.7.12 aqua:koalaman/shellcheck@0.11.0 -- actionlint .github/workflows/auto-rebase.yml .github/workflows/docker-publish.yml .github/workflows/fork-ci.yml
```
