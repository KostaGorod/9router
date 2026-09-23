import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { git, merge, plan, guard, sha, currentHead, publishTag, ancestor } from '../../scripts/kosta-release.mjs';

const helper = fileURLToPath(new URL('../../scripts/kosta-release.mjs', import.meta.url));

function fixture(fn) {
  const cwd = process.cwd();
  const env = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'kosta-release-'));
  mkdirSync(join(dir, 'home'));
  Object.assign(process.env, { HOME: join(dir, 'home'), DATA_DIR: join(dir, 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
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
  } finally { process.chdir(cwd); process.env = env; rmSync(dir, { recursive: true, force: true }); }
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
  git('push', 'origin', `${fork}:refs/heads/master`);
  publishTag(plan(fork, upstream));
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
  const release = plan(base, base);
  publishTag(release);
  publishTag(release);
  const tagObject = git('rev-parse', release.tag);
  const next = commit('fork', 'new', 'New master');
  assert.throws(() => currentHead(next), /moved/);
  assert.throws(() => publishTag({ ...release, tag: 'v1.2.3' }), /Invalid fork tag/);
  git('push', 'origin', `${next}:refs/heads/master`);
  assert.throws(() => currentHead(base), /moved/);
  assert.throws(() => publishTag({ ...release, commit: next }), /never move/);
  assert.equal(git('ls-remote', 'origin', 'refs/tags/v1.2.3-kosta.1').split(/\s/)[0], tagObject);
  assert.equal(git('ls-remote', 'origin', 'refs/tags/v1.2.3-kosta.1^{}').split(/\s/)[0], base);
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
  assert.equal(git('ls-remote', '--tags', '--refs', 'origin').split('\n').length, 1);
}));

test('allocation survives a late upstream tag on the same upstream commit', () => fixture(({ base }) => {
  const upstream = commit('package.json', '{"version":"1.2.4"}', 'Unreleased upstream');
  const fork = commit('fork', 'patch', 'Fork patch');
  git('push', 'origin', `${fork}:refs/heads/master`);
  const allocated = plan(fork, upstream);
  execFileSync(process.execPath, [helper, 'publish'], { stdio: 'pipe', env: {
    ...process.env, GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master',
    FORK_SHA: fork, UPSTREAM_SHA: upstream, VALIDATED_COMMIT: fork, VALIDATED_TREE: git('rev-parse', 'HEAD^{tree}'),
  } });
  git('fetch', 'origin', '--tags');
  const tagObject = git('rev-parse', allocated.tag);
  git('update-ref', 'refs/upstream-tags/v1.2.4', upstream);
  assert.deepEqual(plan(fork, upstream), allocated);
  assert.equal(git('rev-parse', allocated.tag), tagObject);
  assert.equal(allocated.upstream_tag, 'v1.2.3');
  assert.notEqual(upstream, base);
}));

test('upstream catching up to contained history reuses the original allocation in a fresh clone', () => fixture(({ base, dir }) => {
  const integrated = commit('package.json', '{"version":"1.2.4"}', 'Already integrated version');
  const fork = commit('fork', 'patch', 'Fork patch');
  // Allocate with the older upstream version before upstream catches up.
  git('checkout', '--detach', base);
  const source = commit('fork-only', 'patch', 'Contained fork change');
  git('push', 'origin', `${source}:refs/heads/master`);
  const release = plan(source, base);
  publishTag(release);
  git('clone', 'remote.git', 'retry');
  process.chdir(join(dir, 'retry'));
  assert.deepEqual(plan(source, source), release);
  assert.equal(git('tag', '--list', 'v*-kosta.*'), release.tag);
  const output = execFileSync(process.execPath, [helper, 'publish'], { encoding: 'utf8', stdio: 'pipe', env: {
    ...process.env, GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master',
    FORK_SHA: source, UPSTREAM_SHA: source, VALIDATED_COMMIT: source, VALIDATED_TREE: git('rev-parse', 'HEAD^{tree}'),
  } });
  assert(output.includes(`upstream=${base}\n`));
  process.chdir(dir);
  // A changed fork source still gets its own allocation normally.
  assert.equal(plan(fork, integrated).upstream, integrated);
}));

test('legacy tags without frozen metadata fail closed without renaming or guessing', () => fixture(({ base }) => {
  git('tag', 'v1.2.3-kosta.1', base);
  assert.throws(() => plan(base, base), /lacks frozen provenance/);
  assert.equal(git('rev-parse', 'v1.2.3-kosta.1'), base);
  assert.equal(git('tag', '--list', 'v*-kosta.*'), 'v1.2.3-kosta.1');
}));

test('malformed or contradictory tag metadata cannot become release provenance', () => fixture(({ base }) => {
  const release = plan(base, base);
  const fork = commit('fork', 'patch', 'Fork patch');
  git('tag', '-a', release.tag, base, '-m', JSON.stringify({ schema: 1, ...release, commit: fork }));
  assert.throws(() => plan(base, base), /Invalid allocation identity/);
}));

test('workflow-file push rejection leaves refs untouched and explains normal-merge recovery', () => fixture(({ base, dir }) => {
  mkdirSync('.github/workflows', { recursive: true });
  const upstream = commit('.github/workflows/example.yml', 'name: fixture', 'Workflow update');
  git('checkout', '--detach', base);
  const validated = merge(base, upstream);
  git('checkout', '--detach', base);
  writeFileSync('remote.git/hooks/pre-receive', '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const summary = join(dir, 'summary');
  writeFileSync(summary, '');
  assert.throws(() => execFileSync(process.execPath, [helper, 'publish'], { stdio: 'pipe', env: {
    ...process.env, GITHUB_REPOSITORY: 'KostaGorod/9router', GITHUB_REF: 'refs/heads/master', GITHUB_STEP_SUMMARY: summary,
    FORK_SHA: base, UPSTREAM_SHA: upstream, VALIDATED_COMMIT: validated.commit, VALIDATED_TREE: validated.tree,
  } }));
  assert.match(readFileSync(summary, 'utf8'), /GITHUB_TOKEN.*workflow.*normal merge/s);
  assert.match(readFileSync(summary, 'utf8'), /\.github\/workflows\/example.yml/);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], base);
  assert.equal(git('ls-remote', '--tags', 'origin'), '');
}));
