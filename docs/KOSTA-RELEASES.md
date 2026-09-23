# Kosta fork releases

Only `KostaGorod/9router` publishes this pipeline. The daily upstream merge workflow runs at 03:17 UTC and can be run manually on `master`. It fetches every upstream master commit, not the GitHub releases feed. Normal merge commits preserve upstream and fork commit identities. Conflicts stop before any push and list the affected paths in the job summary.

The read-only validation job builds and tests the integrated source. A separate write job reproduces the exact deterministic commit and tree, rejects a moved fork head, and uses a normal fast-forward push. The same workflow then calls the image workflow. It does not rely on a GITHUB_TOKEN push triggering another workflow.

## Naming and retry behavior

Release tags are `v<upstream-version>-kosta.<N>`, for example `v0.5.86-kosta.1`. The version is the highest stable upstream tag ancestral to the selected upstream master commit. Tags are fetched into a separate namespace to distinguish upstream tags from fork tags. Untagged upstream commits still produce releases. Both package versions remain upstream-owned and are checked independently against upstream master. They do not need to equal each other or the release tag.

An existing fork tag for the exact commit is reused. Otherwise the next number under that upstream version is allocated. Each new tag is annotated with versioned JSON provenance containing the fork commit, upstream SHA, upstream tag name and that upstream tag's resolved commit. Retries read this immutable annotation before consulting upstream refs. A late upstream tag or an upstream advance into already-contained history cannot rename the release or change its image labels, commit lists or upstream identity. A tag is never moved. Fork-only commits can produce the next number without a new upstream version. No-op runs validate and resume the same release rather than allocating another number.

Legacy lightweight tags or annotations without valid provenance stop publication. Their original upstream SHA cannot be inferred safely from current refs. Do not replace the tag, relabel a published image or allocate another number for unchanged source. An operator must recover and verify the original provenance from durable publication evidence before designing an explicit migration. This pipeline does not guess or automatically migrate legacy allocations.

Publication is serialized by the parent workflow. There is no direct tag-push or manual image-publish trigger. Imported upstream `v*` tags cannot publish unbranded images. A stale job must still match current fork master before tag allocation, manifest creation and stable promotion.

## Images and releases

The only image repository is `ghcr.io/kostagorod/9router`:

- `v0.5.86-kosta.1` is an immutable numbered manifest.
- `kosta` is the stable alias.
- This workflow does not publish `latest`, Docker Hub images or npm packages.

The upstream Dockerfile remains unchanged, including official registry defaults. Native amd64 and arm64 jobs build by digest and check `/api/health` before publishing a numbered manifest. A retry reuses an existing numbered manifest after verifying both platforms and OCI provenance, then health-checks it on both native runners again. The resolved multi-platform manifest receives another health check before stable promotion.

GitHub releases are stable, not prereleases, despite the suffix. They contain the exact fork commit, upstream master SHA/tag, fork commit list, upstream changelog link and registry digest. `version-manifest.json` is attached to the release and also retained as an Actions artifact. A draft release holds uploaded evidence until publication finishes. Retries inspect the published release and every page of the authorized release listing, which includes drafts. The exact matching draft ID and verified uploaded evidence are reused after upload/publication failure or a lost response, including a lost draft-creation response. Multiple matches or conflicting identity stop publication instead of creating another draft. Incomplete draft evidence can be replaced; published evidence cannot. Asset bytes are read back against the verified manifest.

Partial failures are retried through the daily workflow; an existing numbered image or completed release is not silently replaced. Authentication, network and non-404 API failures stop the job. A 404 from the published-only tag endpoint alone does not prove absence; the authorized listing must succeed. A listing error, including 404, stops the job. The parent workflow's serialization is required to prevent concurrent creation.

PR CI builds the exact PR head, runs release fixtures and model regressions, and builds/health-checks both native container platforms without registry publication. Release fixtures execute the shipped helpers with temporary Git remotes, a local HTTP server implementing the GitHub/registry boundary, and a recording Docker executable. They cover partial failures and retries but do not prove real GitHub/GHCR permissions or live publication. PRs never receive publishing permissions. Merge the integration PR with a normal merge commit, never squash or rebase, so the imported upstream and fork SHAs remain ancestors of master.

## Workflow-file sync permission failures

The built-in `GITHUB_TOKEN` has `contents:write`, not workflow-file write permission. Sync can fail when upstream changes `.github/workflows/*`. The failed push stops tag allocation and image/release publication; the job summary names the changed workflow files. Other push failures also remain fatal. No broader token or secret is configured automatically.

For recovery, an authorized operator must fetch the current fork `master` and upstream `master`, create a branch from fork master, and perform a normal `git merge --no-ff` of the exact upstream SHA. Resolve conflicts while retaining the fork publication guards and native smoke checks. Review the merge and run the release fixtures, model regressions and build on that exact source. Land it through a reviewed PR with a normal merge commit using the operator's existing authorized workflow-change path, never squash, rebase or force-push. If the operator lacks permission, stop and request repository-owner action rather than broadening secrets. Then rerun the daily workflow on current master. It revalidates the source and allocates or resumes the immutable release; do not manually mint a replacement tag.

## One-time GHCR visibility

A newly created GHCR package may be private. For anonymous pulls, the owner must open the GitHub profile's Packages page, select the `9router` container package, open Package settings, then Change visibility in the Danger Zone and select Public. Confirm the package name when GitHub requests it. Repository visibility does not automatically change package visibility.

Alternatively, consumers need an authenticated package pull with `read:packages`. This pipeline does not create or broaden credentials. Authenticated Actions manifest verification and the attached digest evidence remain available when anonymous reads are denied.

Watchtower installation, credentials, schedules and live service changes are outside this change. Nothing here deploys the image.

## Local verification

```sh
npm install --ignore-scripts --no-package-lock
npm --prefix tests install --ignore-scripts --no-package-lock
node --test tests/release/*.test.mjs
(cd tests && npx vitest run unit/custom-model-v1-list.test.js unit/custom-model-limits-route.test.js unit/model-token-limits.test.js unit/combo-context-marker.test.js unit/combo-capabilities.test.js)
npm run build
mise exec aqua:rhysd/actionlint@1.7.12 aqua:koalaman/shellcheck@0.11.0 -- actionlint .github/workflows/auto-rebase.yml .github/workflows/docker-publish.yml .github/workflows/fork-ci.yml
```
