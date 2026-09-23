import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { git, merge, plan, guard, sha, currentHead, publishTag, ancestor } from '../../scripts/kosta-release.mjs';

const helper = fileURLToPath(new URL('../../scripts/kosta-release.mjs', import.meta.url));

function fixture(fn) {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'kosta-release-'));
  process.chdir(dir);
  try {
    git('init', '-b', 'master');
    git('config', 'user.name', 'Fixture author');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync('cli');
    writeFileSync('package.json', '{"version":"1.2.3"}');
    writeFileSync('cli/package.json', '{"version":"0.9.0"}');
    writeFileSync('shared', 'base\n');
    git('add', '.'); git('commit', '-m', 'Original base');
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/upstream-tags/v1.2.3', base);
    git('clone', '--bare', '.', 'remote.git');
    git('remote', 'add', 'origin', join(dir, 'remote.git'));
    fn({ base, dir });
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
}
function commit(file, value, message) {
  writeFileSync(file, value); git('add', file); git('commit', '-m', message);
  return git('rev-parse', 'HEAD');
}
test('normal merge preserves original commits, authors and messages and reproduces exact SHA', () => fixture(({ base }) => {
  const fork = commit('fork', 'fork patch', 'Original fork patch');
  git('checkout', '--detach', base);
  const upstream = commit('upstream', 'upstream change', 'Original upstream patch');
  const original = git('show', '-s', '--format=fuller', upstream);
  git('checkout', '--detach', fork);
  const merged = merge(fork, upstream);
  assert(ancestor(fork, merged.commit)); assert(ancestor(upstream, merged.commit));
  assert.equal(git('show', '-s', '--format=%P', merged.commit), `${fork} ${upstream}`);
  assert.equal(git('show', '-s', '--format=fuller', upstream), original);
  git('checkout', '--detach', fork);
  assert.deepEqual(merge(fork, upstream), merged);
  assert.equal(merge(merged.commit, upstream).commit, merged.commit);
}));
test('conflicts abort without push and preserve actionable filenames', () => fixture(({ base }) => {
  const fork = commit('shared', 'fork\n', 'Fork conflict');
  git('checkout', '--detach', base);
  const upstream = commit('shared', 'upstream\n', 'Upstream conflict');
  git('checkout', '--detach', fork);
  assert.throws(() => merge(fork, upstream), /shared/);
  assert.equal(git('rev-parse', 'HEAD'), fork);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], base);
  assert.equal(git('diff', '--name-only', '--diff-filter=U'), '');
}));
test('ancestor version, independent package versions, no-op and partial retry reuse tags', () => fixture(({ base }) => {
  const upstream = commit('new-upstream', 'after release', 'Unreleased upstream');
  git('update-ref', 'refs/upstream-tags/v99.0.0', 'HEAD');
  // A newer tag on an unrelated branch must not name this release.
  git('checkout', '--detach', base);
  const unrelated = commit('unrelated', 'x', 'Other branch');
  git('update-ref', 'refs/upstream-tags/v99.0.0', unrelated);
  git('checkout', '--detach', upstream);
  const fork = commit('fork', 'x', 'Fork patch');
  assert.equal(plan(fork, upstream).tag, 'v1.2.3-kosta.1');
  git('tag', 'v1.2.3-kosta.1', fork);
  assert.equal(plan(fork, upstream).tag, 'v1.2.3-kosta.1');
  const next = commit('fork', 'new', 'Next fork patch');
  assert.equal(plan(next, upstream).tag, 'v1.2.3-kosta.2');
  commit('package.json', '{"version":"1.2.4"}', 'Wrong fork bump');
  assert.throws(() => plan(git('rev-parse', 'HEAD'), upstream), /upstream-owned/);
}));
test('immutable remote tags, stale head and bad ref/repository guards', () => fixture(({ base }) => {
  guard('KostaGorod/9router', 'refs/heads/master');
  assert.throws(() => guard('decolua/9router', 'refs/heads/master'), /Fork repository/);
  assert.throws(() => guard('KostaGorod/9router', 'refs/tags/v1.2.3'), /Only master/);
  for (const value of ['HEAD', '--all', '', 'a'.repeat(40)]) assert.throws(() => sha(value));
  currentHead(base);
  publishTag('v1.2.3-kosta.1', base);
  publishTag('v1.2.3-kosta.1', base);
  const next = commit('fork', 'new', 'New master');
  assert.throws(() => currentHead(next), /moved/);
  assert.throws(() => publishTag('v1.2.3', base), /Invalid fork tag/);
  git('push', 'origin', `${next}:refs/heads/master`);
  assert.throws(() => currentHead(base), /moved/);
  assert.throws(() => publishTag('v1.2.3-kosta.1', next), /never move/);
  assert.equal(git('ls-remote', 'origin', 'refs/tags/v1.2.3-kosta.1').split(/\s/)[0], base);
}));

test('write-job CLI rejects an unvalidated tree before pushing', () => fixture(({ base }) => {
  const upstream = commit('new-upstream', 'new', 'Upstream');
  git('checkout', '--detach', base);
  const validated = merge(base, upstream);
  git('checkout', '--detach', base);
  assert.throws(() => execFileSync(process.execPath, [helper, 'publish'], {
    encoding: 'utf8', stdio: 'pipe', env: {
      ...process.env, GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master',
      FORK_SHA: base, UPSTREAM_SHA: upstream, VALIDATED_COMMIT: validated.commit, VALIDATED_TREE: '0'.repeat(40),
    },
  }), /Validated commit\/tree mismatch/);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], base);
}));

test('write-job CLI publishes exact validated commit and resumes without another tag', () => fixture(({ base }) => {
  const upstream = commit('new-upstream', 'new', 'Upstream');
  git('checkout', '--detach', base);
  const validated = merge(base, upstream);
  git('checkout', '--detach', base);
  const env = {
    ...process.env, GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master',
    FORK_SHA: base, UPSTREAM_SHA: upstream, VALIDATED_COMMIT: validated.commit, VALIDATED_TREE: validated.tree,
  };
  execFileSync(process.execPath, [helper, 'publish'], { env, stdio: 'pipe' });
  assert.equal(git('ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], validated.commit);
  git('fetch', 'origin', '--tags');
  execFileSync(process.execPath, [helper, 'publish'], { env: { ...env, FORK_SHA: validated.commit }, stdio: 'pipe' });
  assert.equal(git('ls-remote', '--tags', 'origin').split('\n').length, 1);
}));
