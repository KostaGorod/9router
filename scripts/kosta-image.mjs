import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, guard, sha, ancestor, currentHead, git, plan } from './kosta-release.mjs';

const image = 'ghcr.io/kostagorod/9router';
const { RELEASE_TAG: tag, COMMIT: commit, UPSTREAM_SHA: upstream, UPSTREAM_TAG: upstreamTag } = process.env;
guard(process.env.GITHUB_REPOSITORY, process.env.GITHUB_REF);
sha(commit); sha(upstream);
assert(/^v\d+\.\d+\.\d+-kosta\.[1-9]\d*$/.test(tag || ''), 'Invalid fork tag');
assert(git('rev-parse', `${tag}^{commit}`) === commit, 'Tag/commit mismatch');
assert(ancestor(upstream, commit), 'Missing upstream ancestry');
const planned = plan(commit, upstream);
assert(planned.tag === tag && planned.upstream === upstream && planned.upstream_tag === upstreamTag, 'Release provenance mismatch');

async function api(path, options = {}, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/KostaGorod/9router/${path}`, {
    ...options, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', ...options.headers },
  });
  if (allowMissing && response.status === 404) return null;
  assert(response.ok, `GitHub ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function findRelease() {
  // The tag endpoint excludes drafts. An authorized, paginated listing must
  // succeed before absence is established, including after a lost POST response.
  const published = await api(`releases/tags/${tag}`, {}, true);
  const matches = new Map(published ? [[published.id, published]] : []);
  for (let page = 1; ; page++) {
    const releases = await api(`releases?per_page=100&page=${page}`);
    assert(Array.isArray(releases), 'Invalid release listing');
    for (const release of releases) {
      if (release.tag_name === tag) matches.set(release.id, release);
    }
    if (releases.length < 100) break;
  }
  assert(matches.size <= 1, 'Multiple releases match this tag; operator recovery required');
  return matches.values().next().value;
}
async function evidenceMatches(asset, evidence) {
  if (asset.state !== 'uploaded' || asset.size !== evidence.length) return false;
  const response = await fetch(`https://api.github.com/repos/KostaGorod/9router/releases/assets/${asset.id}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/octet-stream' },
  });
  assert(response.ok, `Release evidence readback: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).equals(evidence);
}
const packageResponse = await fetch('https://api.github.com/users/KostaGorod/packages/container/9router', {
  headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
});
assert(packageResponse.ok || packageResponse.status === 404, `Package lookup: HTTP ${packageResponse.status}`);
const packageMissing = packageResponse.status === 404;
let token;
if (!packageMissing) {
const tokenResponse = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:kostagorod/9router:pull', {
  headers: { Authorization: `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64')}` },
});
assert(tokenResponse.ok, `Registry authentication failed: HTTP ${tokenResponse.status}`);
({ token } = await tokenResponse.json());
}
async function manifest(ref, missing = false) {
  if (packageMissing && missing) return null;
  assert(!packageMissing, 'GHCR package is missing');
  const response = await fetch(`https://ghcr.io/v2/kostagorod/9router/manifests/${ref}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
  });
  if (missing && response.status === 404) return null;
  assert(response.ok, `Registry manifest ${ref}: HTTP ${response.status}`);
  const digest = response.headers.get('docker-content-digest');
  assert(/^sha256:[a-f0-9]{64}$/.test(digest || ''), 'Invalid registry digest');
  return { digest, data: await response.json() };
}
async function verify(index) {
  assert(index?.data.manifests?.length === 2, 'Exactly two platform manifests required');
  assert(index.data.manifests.map((m) => `${m.platform?.os}/${m.platform?.architecture}`).sort().join(',') === 'linux/amd64,linux/arm64', 'Wrong image platforms');
  for (const child of index.data.manifests) {
    const value = await manifest(child.digest);
    const response = await fetch(`https://ghcr.io/v2/kostagorod/9router/blobs/${value.data.config.digest}`, { headers: { Authorization: `Bearer ${token}` } });
    assert(response.ok, `Registry config: HTTP ${response.status}`);
    const config = await response.json();
    const labels = config.config?.Labels;
    assert(config.os === child.platform.os && config.architecture === child.platform.architecture, 'Platform config mismatch');
    assert(labels?.['org.opencontainers.image.revision'] === commit && labels?.['org.opencontainers.image.version'] === tag && labels?.['org.opencontainers.image.source'] === 'https://github.com/KostaGorod/9router', 'Image provenance mismatch');
    assert(labels?.['io.kosta.upstream.revision'] === upstream && labels?.['io.kosta.upstream.tag'] === upstreamTag, 'Upstream image labels mismatch');
  }
}
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim(); }
function output(key, value) { appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); }
const command = process.argv[2];
if (command === 'prepare') {
  currentHead(commit);
  const existing = await manifest(tag, true);
  if (existing) await verify(existing);
  output('existing', existing ? 'true' : 'false');
  output('digest', existing?.digest || '');
} else if (command === 'publish') {
  currentHead(commit);
  let index = await manifest(tag, true);
  if (!index) {
    const digests = ['amd64', 'arm64'].map((arch) => readFileSync(`${process.env.RUNNER_TEMP}/digests/${arch}`, 'utf8').trim());
    assert(digests.every((d) => /^sha256:[a-f0-9]{64}$/.test(d)) && new Set(digests).size === 2, 'Invalid platform digests');
    // Validate before allocating the immutable numbered registry tag.
    await verify({ data: { manifests: digests.map((digest, i) => ({ digest, platform: { os: 'linux', architecture: ['amd64', 'arm64'][i] } })) } });
    docker('buildx', 'imagetools', 'create', '--tag', `${image}:${tag}`, ...digests.map((d) => `${image}@${d}`));
    index = await manifest(tag);
  }
  await verify(index);
  writeFileSync(`${process.env.RUNNER_TEMP}/version-manifest.json`, JSON.stringify(index, null, 2));
  output('digest', index.digest);
} else if (command === 'finalize') {
  const index = await manifest(tag);
  await verify(index);
  assert(index.digest === process.env.DIGEST, 'Numbered manifest changed after smoke tests');
  currentHead(commit);
  // All publishing enters via the serialized parent workflow; manual older
  // tags cannot bypass the current-master check and move this alias backwards.
  docker('buildx', 'imagetools', 'create', '--tag', `${image}:kosta`, `${image}@${index.digest}`);
  assert((await manifest('kosta')).digest === index.digest, 'Stable alias readback mismatch');
  const forkLog = git('log', '--format=- %h %s', `${upstream}..${commit}`);
  const upstreamLog = git('log', '--format=- %h %s', `${planned.upstream_tag_commit}..${upstream}`);
  const body = `Fork commit: ${commit}\nUpstream master: ${upstream}\nUpstream tag: ${upstreamTag}\nRegistry: ${image}:${tag}\nDigest: ${index.digest}\nStable alias: ${image}:kosta\n\n## Fork commits\n${forkLog}\n\n## Upstream changes since ${upstreamTag}\n${upstreamLog || 'None (tagged upstream head).'}\n\nUpstream changelog: https://github.com/decolua/9router/blob/${upstream}/CHANGELOG.md\n\nBoth native linux/amd64 and linux/arm64 images passed /api/health checks. Package versions remain upstream-owned. Watchtower is not configured.\n`;
  let release = await findRelease();
  if (!release) release = await api('releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: tag, body, draft: true, prerelease: false }) });
  assert(Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === tag && release.target_commitish === commit && release.name === tag && !release.prerelease && release.body === body, 'Existing release mismatch');
  const evidence = Buffer.from(JSON.stringify(index, null, 2));
  const assets = release.assets.filter((a) => a.name === 'version-manifest.json');
  const reusable = assets.length === 1 && await evidenceMatches(assets[0], evidence);
  if (!release.draft) {
    assert(reusable, 'Published release evidence differs; refusing overwrite');
  } else {
    // A lost upload response may have committed the asset. Reuse verified bytes;
    // only incomplete/mismatching draft evidence can be replaced.
    if (!reusable) {
      for (const asset of assets) await api(`releases/assets/${asset.id}`, { method: 'DELETE' });
      const upload = await fetch(`https://uploads.github.com/repos/KostaGorod/9router/releases/${release.id}/assets?name=version-manifest.json`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/json' }, body: evidence,
      });
      assert(upload.ok, `Release evidence upload: HTTP ${upload.status}`);
    }
    await api(`releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ name: tag, body, draft: false, prerelease: false, make_latest: 'true' }) });
  }
  const verified = await api(`releases/tags/${tag}`);
  assert(verified.id === release.id && verified.tag_name === tag && verified.target_commitish === commit && !verified.draft && !verified.prerelease && verified.body === body, 'Release readback failed');
  const verifiedAssets = verified.assets.filter((a) => a.name === 'version-manifest.json');
  assert(verifiedAssets.length === 1 && await evidenceMatches(verifiedAssets[0], evidence), 'Release evidence readback failed');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Published Kosta release\n${verified.html_url}\n\n${image}@${index.digest}\n`);
} else throw new Error('Unknown image command');
