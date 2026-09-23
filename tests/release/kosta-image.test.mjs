import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseHelper = fileURLToPath(new URL('../../scripts/kosta-release.mjs', import.meta.url));
const imageHelper = fileURLToPath(new URL('../../scripts/kosta-image.mjs', import.meta.url));
const boundary = fileURLToPath(new URL('./fixtures/http-boundary.mjs', import.meta.url));
const digest = (char) => `sha256:${char.repeat(64)}`;

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kosta-image-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  let server;
  try {
    for (const path of ['cli', 'home', 'data', 'bin', 'digests']) mkdirSync(join(dir, path));
    git('init', '-b', 'master');
    git('config', 'user.name', 'Fixture author'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');
    writeFileSync(join(dir, 'cli/package.json'), '{"version":"0.9.0"}');
    git('add', 'package.json', 'cli/package.json'); git('commit', '-m', 'Upstream');
    const upstream = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/upstream-tags/v1.2.3', upstream);
    writeFileSync(join(dir, 'fork'), 'patch'); git('add', 'fork'); git('commit', '-m', 'Fork');
    const commit = git('rev-parse', 'HEAD');
    git('clone', '--bare', '.', 'remote.git'); git('remote', 'add', 'origin', join(dir, 'remote.git'));
    const tag = 'v1.2.3-kosta.1';
    const env = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: join(dir, 'home'), DATA_DIR: join(dir, 'data'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master', GITHUB_ACTOR: 'fixture',
      GH_TOKEN: 'offline-fixture', RELEASE_TAG: tag, COMMIT: commit, UPSTREAM_SHA: upstream, UPSTREAM_TAG: 'v1.2.3',
      RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), DIGEST: digest('a'),
    };
    execFileSync(process.execPath, [releaseHelper, 'publish'], { cwd: dir, stdio: 'pipe', env: {
      ...env, FORK_SHA: commit, VALIDATED_COMMIT: commit, VALIDATED_TREE: git('rev-parse', 'HEAD^{tree}'),
    } });
    const index = { digest: digest('a'), data: { manifests: ['amd64', 'arm64'].map((architecture, i) => ({
      digest: digest(i ? 'c' : 'b'), platform: { os: 'linux', architecture },
    })) } };
    const evidence = JSON.stringify(index, null, 2);
    writeFileSync(join(dir, 'version-manifest.json'), evidence);
    writeFileSync(join(dir, 'digests/amd64'), digest('b'));
    writeFileSync(join(dir, 'digests/arm64'), digest('c'));
    const dockerLog = join(dir, 'docker.jsonl');
    writeFileSync(join(dir, 'bin/docker'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
    const state = { releases: [], requests: [], failure: null, packageStatus: 200, tokenStatus: 200, manifestStatus: 200, numbered: true, labelUpstream: upstream, creates: 0, uploads: 0, deletes: 0 };
    const dockerCalls = () => existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const json = () => JSON.parse(raw);
      state.requests.push(`${req.method} ${req.url}`);
      const send = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      const fail = (phase, apply) => {
        if (state.failure?.phase !== phase) return false;
        const { mode } = state.failure; state.failure = null;
        if (mode === 'lost') { apply?.(); req.socket.destroy(); }
        else send(Number(mode) || 503, { message: 'fixture failure' });
        return true;
      };
      if (path === '/api.github.com/users/KostaGorod/packages/container/9router') return send(state.packageStatus, {});
      if (path === '/ghcr.io/token') return send(state.tokenStatus, { token: 'offline-registry' });
      const manifest = path.match(/^\/ghcr.io\/v2\/kostagorod\/9router\/manifests\/(.+)$/)?.[1];
      if (manifest) {
        if (state.manifestStatus !== 200) return send(state.manifestStatus, {});
        if (manifest === tag || manifest === 'kosta') {
          const created = dockerCalls().some((args) => args.includes(`ghcr.io/kostagorod/9router:${manifest}`));
          if ((manifest === tag && state.numbered) || created) return send(200, index.data, { 'docker-content-digest': index.digest });
          return send(404, {});
        }
        const child = index.data.manifests.find((m) => m.digest === manifest);
        if (child) return send(200, { config: { digest: digest(child.platform.architecture === 'amd64' ? 'd' : 'e') } }, { 'docker-content-digest': manifest });
      }
      const blob = path.match(/^\/ghcr.io\/v2\/kostagorod\/9router\/blobs\/(.+)$/)?.[1];
      if (blob) return send(200, { os: 'linux', architecture: blob === digest('d') ? 'amd64' : 'arm64', config: { Labels: {
        'org.opencontainers.image.revision': commit, 'org.opencontainers.image.version': tag,
        'org.opencontainers.image.source': 'https://github.com/KostaGorod/9router',
        'io.kosta.upstream.revision': state.labelUpstream, 'io.kosta.upstream.tag': 'v1.2.3',
      } } });
      const root = '/api.github.com/repos/KostaGorod/9router/releases';
      if (path === root && req.method === 'GET') {
        if (fail('list')) return;
        const page = Number(url.searchParams.get('page') || 1);
        return send(200, state.releases.slice((page - 1) * 100, page * 100));
      }
      if (path === `${root}/tags/${tag}`) {
        if (fail('published')) return;
        const release = state.releases.find((r) => r.tag_name === tag && !r.draft);
        return send(release ? 200 : 404, release || {});
      }
      if (path === root && req.method === 'POST') {
        const create = () => {
          const id = ++state.creates;
          const release = { ...json(), id, assets: [], upload_url: `https://uploads.github.com/repos/KostaGorod/9router/releases/${id}/assets{?name,label}`, html_url: `https://github.com/KostaGorod/9router/releases/tag/${tag}` };
          state.releases.push(release); return release;
        };
        if (fail('create', create)) return;
        return send(201, create());
      }
      const uploadId = path.match(/^\/uploads.github.com\/repos\/KostaGorod\/9router\/releases\/(\d+)\/assets$/)?.[1];
      if (uploadId) {
        const upload = () => {
          const asset = { id: ++state.uploads, name: url.searchParams.get('name'), state: 'uploaded', size: Buffer.byteLength(raw), content: raw };
          state.releases.find((r) => r.id === Number(uploadId)).assets.push(asset); return asset;
        };
        if (fail('upload', upload)) return;
        return send(201, upload());
      }
      const assetId = path.match(new RegExp(`^${root}/assets/(\\d+)$`))?.[1];
      if (assetId) {
        if (fail('asset')) return;
        const release = state.releases.find((r) => r.assets.some((a) => a.id === Number(assetId)));
        if (req.method === 'DELETE') { state.deletes++; release.assets = release.assets.filter((a) => a.id !== Number(assetId)); res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(release.assets.find((a) => a.id === Number(assetId)).content);
      }
      const releaseId = path.match(new RegExp(`^${root}/(\\d+)$`))?.[1];
      if (releaseId) {
        const release = state.releases.find((r) => r.id === Number(releaseId));
        if (req.method === 'PATCH') {
          const publish = () => Object.assign(release, json());
          if (fail('publish', publish)) return;
          publish();
        }
        return send(200, release);
      }
      send(500, { message: `Unexpected fixture request ${req.method} ${req.url}` });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env.FIXTURE_HTTP = `http://127.0.0.1:${server.address().port}`;
    const run = (command = 'finalize', overrides = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', boundary, imageHelper, command], { cwd: dir, env: { ...env, ...overrides }, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, output }));
    });
    await fn({ state, run, git, commit, upstream, tag, index, evidence, dockerCalls, dir });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}
const succeeds = (result) => assert.equal(result.code, 0, result.output);
const fails = (result, message) => { assert.notEqual(result.code, 0, result.output); assert.match(result.output, message); };

test('finalize resumes the exact draft after upload failure without creating a duplicate', () => fixture(async ({ state, run }) => {
  state.failure = { phase: 'upload', mode: '503' };
  fails(await run(), /upload: HTTP 503/);
  assert.equal(state.releases.length, 1);
  succeeds(await run());
  assert.equal(state.creates, 1);
  assert.equal(state.releases[0].draft, false);
  assert.equal(state.releases[0].assets.length, 1);
}));

test('image provenance rejects a new upstream SHA for an already allocated source', () => fixture(async ({ run, commit }) => {
  fails(await run('prepare', { UPSTREAM_SHA: commit }), /Release provenance mismatch/);
}));

test('finalize retries use the allocated tag commit even if upstream tags disappear', () => fixture(async ({ state, run, git }) => {
  succeeds(await run());
  const body = state.releases[0].body;
  git('update-ref', '-d', 'refs/upstream-tags/v1.2.3');
  succeeds(await run());
  assert.equal(state.releases[0].body, body);
  assert.equal(state.creates, 1);
}));

for (const [phase, mode] of [['publish', '503'], ['create', 'lost'], ['upload', 'lost'], ['publish', 'lost']]) {
  test(`finalize recovers ${phase} ${mode} with one release and reuses uploaded evidence`, () => fixture(async ({ state, run, evidence }) => {
    state.failure = { phase, mode };
    fails(await run(), mode === 'lost' ? /fetch failed/ : /HTTP 503/);
    const uploaded = state.uploads;
    succeeds(await run());
    assert.equal(state.creates, 1);
    assert.equal(state.releases[0].draft, false);
    assert.equal(state.releases[0].assets.length, 1);
    assert.equal(state.releases[0].assets[0].content, evidence);
    assert.equal(state.uploads, uploaded || 1);
    assert.equal(state.deletes, 0);
    succeeds(await run());
    assert.equal(state.creates, 1);
    assert.equal(state.uploads, 1);
  }));
}

test('draft discovery follows all authorized release pages', () => fixture(async ({ state, run }) => {
  state.failure = { phase: 'upload', mode: '503' };
  fails(await run(), /HTTP 503/);
  const draft = state.releases[0];
  state.releases.unshift(...Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `unrelated-${i}`, draft: false, assets: [] })));
  succeeds(await run());
  assert.equal(state.creates, 1);
  assert.equal(draft.draft, false);
  assert(state.requests.some((r) => r.endsWith('releases?per_page=100&page=2')));
}));

test('duplicate matching drafts fail closed instead of selecting one', () => fixture(async ({ state, run }) => {
  state.failure = { phase: 'upload', mode: '503' };
  fails(await run(), /HTTP 503/);
  state.releases.push({ ...state.releases[0], id: 2 });
  fails(await run(), /Multiple releases match/);
  assert.equal(state.creates, 1);
  assert.equal(state.uploads, 0);
}));

for (const field of ['target_commitish', 'body', 'name', 'prerelease']) {
  test(`draft identity rejects mismatching ${field} before modifying it`, () => fixture(async ({ state, run }) => {
    state.failure = { phase: 'upload', mode: '503' };
    fails(await run(), /HTTP 503/);
    state.releases[0][field] = field === 'prerelease' ? true : 'wrong';
    fails(await run(), /Existing release mismatch/);
    assert.equal(state.creates, 1);
    assert.equal(state.uploads, 0);
    assert.equal(state.deletes, 0);
  }));
}

for (const phase of ['published', 'list']) {
  for (const mode of ['401', '403', '503', 'lost', ...(phase === 'list' ? ['404'] : [])]) {
    test(`${phase} lookup ${mode} is not treated as absence`, () => fixture(async ({ state, run }) => {
      state.failure = { phase, mode };
      fails(await run(), mode === 'lost' ? /fetch failed/ : new RegExp(`HTTP ${mode}`));
      assert.equal(state.creates, 0);
      assert.equal(state.uploads, 0);
    }));
  }
}

test('creation conflict is not blindly retried or treated as a successful release', () => fixture(async ({ state, run }) => {
  state.failure = { phase: 'create', mode: '422' };
  fails(await run(), /HTTP 422/);
  assert.equal(state.creates, 0);
  assert.equal(state.requests.filter((r) => r === 'POST /api.github.com/repos/KostaGorod/9router/releases').length, 1);
}));

test('prepare distinguishes a genuinely absent numbered image from registry errors', () => fixture(async ({ state, run, dir, dockerCalls }) => {
  state.packageStatus = 404;
  succeeds(await run('prepare'));
  assert.match(readFileSync(join(dir, 'output'), 'utf8'), /existing=false/);
  state.packageStatus = 200;
  state.numbered = false;
  succeeds(await run('prepare'));
  for (const status of [401, 403, 503]) {
    state.packageStatus = status;
    fails(await run('prepare'), /Package lookup/);
    state.packageStatus = 200; state.tokenStatus = status;
    fails(await run('prepare'), /Registry authentication/);
    state.tokenStatus = 200; state.manifestStatus = status;
    fails(await run('prepare'), /Registry manifest/);
    state.manifestStatus = 200;
  }
  assert.equal(dockerCalls().length, 0);
}));

test('publish creates the numbered manifest once and verifies both platforms on retry', () => fixture(async ({ state, run, dockerCalls, dir, evidence, tag }) => {
  state.numbered = false;
  succeeds(await run('publish'));
  succeeds(await run('publish'));
  assert.equal(dockerCalls().length, 1);
  assert(dockerCalls()[0].includes(`ghcr.io/kostagorod/9router:${tag}`));
  assert.equal(readFileSync(join(dir, 'version-manifest.json'), 'utf8'), evidence);
}));

test('wrong platform labels cannot allocate a numbered image or promote stable', () => fixture(async ({ state, run, dockerCalls, commit }) => {
  state.numbered = false; state.labelUpstream = commit;
  fails(await run('publish'), /Upstream image labels mismatch/);
  state.numbered = true;
  fails(await run(), /Upstream image labels mismatch/);
  assert.equal(dockerCalls().length, 0);
  assert.equal(state.creates, 0);
}));

test('stale source and changed numbered digest cannot promote stable', () => fixture(async ({ state, run, dockerCalls, git, upstream }) => {
  fails(await run('finalize', { DIGEST: digest('f') }), /Numbered manifest changed/);
  git('--git-dir=remote.git', 'update-ref', 'refs/heads/master', upstream);
  for (const command of ['prepare', 'publish', 'finalize']) fails(await run(command), /Fork master moved/);
  assert.equal(dockerCalls().length, 0);
  assert.equal(state.creates, 0);
}));

test('incomplete draft evidence is replaced but published evidence is never overwritten', () => fixture(async ({ state, run, evidence }) => {
  state.failure = { phase: 'publish', mode: '503' };
  fails(await run(), /HTTP 503/);
  state.releases[0].assets[0].state = 'starter';
  succeeds(await run());
  assert.equal(state.creates, 1);
  assert.equal(state.deletes, 1);
  assert.equal(state.uploads, 2);
  const asset = state.releases[0].assets[0];
  assert.equal(asset.content, evidence);
  // Same length is not sufficient evidence identity.
  asset.content = 'x'.repeat(asset.content.length);
  fails(await run(), /Published release evidence differs/);
  assert.equal(state.deletes, 1);
  assert.equal(state.uploads, 2);
}));

test('asset readback errors do not trigger replacement of an existing upload', () => fixture(async ({ state, run }) => {
  state.failure = { phase: 'publish', mode: '503' };
  fails(await run(), /HTTP 503/);
  state.failure = { phase: 'asset', mode: '503' };
  fails(await run(), /evidence readback: HTTP 503/);
  assert.equal(state.creates, 1);
  assert.equal(state.deletes, 0);
  assert.equal(state.uploads, 1);
  assert.equal(state.releases[0].draft, true);
}));
