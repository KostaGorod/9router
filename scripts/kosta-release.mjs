// Trusted workflow helper: run this file from the workflow checkout, with cwd
// set to the source checkout. Never execute merged source in a write-token job.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'KostaGorod/9router';
export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function sha(value) {
  assert(/^[a-f0-9]{40}$/.test(value || ''), 'Expected full commit SHA');
  assert(git('rev-parse', `${value}^{commit}`) === value, 'Expected commit object');
  return value;
}
export function ancestor(parent, child) {
  try { git('merge-base', '--is-ancestor', parent, child); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
export function guard(repository, ref) {
  assert(repository === REPOSITORY, 'Fork repository required');
  assert(ref === 'refs/heads/master', 'Only master may publish');
}
export function currentHead(expected) {
  sha(expected);
  const remote = git('ls-remote', '--exit-code', 'origin', 'refs/heads/master').split(/\s/)[0];
  assert(remote === expected, 'Fork master moved; refusing stale publication');
}
export function merge(fork, upstream) {
  sha(fork); sha(upstream);
  assert(git('rev-parse', 'HEAD') === fork, 'Checkout does not match fork head');
  assert(!git('status', '--porcelain', '--untracked-files=no'), 'Source checkout is dirty');
  if (!ancestor(upstream, fork)) {
    // Both jobs produce exactly the same commit, not merely the same tree.
    const date = Math.max(Number(git('show', '-s', '--format=%ct', fork)), Number(git('show', '-s', '--format=%ct', upstream))) + 1;
    const previous = { ...process.env };
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000`,
    });
    try { git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', `Merge upstream ${upstream}`, upstream); }
    catch (error) {
      const conflicts = git('diff', '--name-only', '--diff-filter=U');
      git('merge', '--abort');
      const message = `Merge blocked; no refs pushed. Resolve conflicts locally and rerun:\n${conflicts || error.message}`;
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Merge blocked\n${message}\n`);
      throw new Error(message);
    } finally { process.env = previous; }
  }
  const commit = git('rev-parse', 'HEAD');
  assert(ancestor(fork, commit) && ancestor(upstream, commit), 'Merge lost history');
  return { fork, upstream, commit, tree: git('rev-parse', 'HEAD^{tree}') };
}
export function upstreamTag(upstream) {
  sha(upstream);
  const tags = git('for-each-ref', '--sort=-version:refname', '--format=%(refname)', 'refs/upstream-tags/').split('\n');
  const ref = tags.find((ref) => /^refs\/upstream-tags\/v\d+\.\d+\.\d+$/.test(ref) && ancestor(`${ref}^{commit}`, upstream));
  assert(ref, 'No upstream stable version tag is ancestral to upstream master');
  return ref.slice('refs/upstream-tags/'.length);
}
export function plan(commit, upstream) {
  sha(commit); sha(upstream);
  assert(ancestor(upstream, commit), 'Source does not contain upstream');
  const base = upstreamTag(upstream);
  // Root and CLI versions belong to upstream and need not equal each other or
  // the last release tag (master may already contain unreleased commits).
  for (const file of ['package.json', 'cli/package.json']) {
    const version = JSON.parse(git('show', `${commit}:${file}`)).version;
    assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), `Invalid ${file} version`);
    assert(version === JSON.parse(git('show', `${upstream}:${file}`)).version, `Fork changed upstream-owned ${file} version`);
  }
  const tags = git('tag', '--list', 'v*-kosta.*').split('\n').filter(Boolean);
  let next = 1;
  let existing;
  for (const tag of tags) {
    const match = /^v\d+\.\d+\.\d+-kosta\.([1-9]\d*)$/.exec(tag);
    assert(match, `Malformed fork release tag: ${tag}`);
    if (git('rev-parse', `${tag}^{commit}`) === commit) {
      assert(!existing, 'Multiple release tags already point at this commit');
      existing = tag;
    }
    if (tag.startsWith(`${base}-kosta.`)) next = Math.max(next, Number(match[1]) + 1);
  }
  assert(Number.isSafeInteger(next), 'Release sequence exceeds safe integer range');
  if (existing) assert(existing.startsWith(`${base}-kosta.`), 'Existing release has different upstream version');
  return { tag: existing || `${base}-kosta.${next}`, commit, upstream, upstream_tag: base };
}
function output(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
export function publishTag(tag, commit) {
  assert(/^v\d+\.\d+\.\d+-kosta\.[1-9]\d*$/.test(tag), 'Invalid fork tag');
  sha(commit); currentHead(commit);
  const refs = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  if (refs) {
    const lines = refs.split('\n');
    const resolved = (lines.find((line) => line.endsWith('^{}')) || lines[0]).split(/\s/)[0];
    assert(resolved === commit, 'Existing tag points to another commit; never move it');
  } else {
    git('-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `${commit}:refs/tags/${tag}`);
    assert(git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).split(/\s/)[0] === commit, 'Tag readback mismatch');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  guard(process.env.GITHUB_REPOSITORY, process.env.GITHUB_REF);
  const [command] = process.argv.slice(2);
  if (command === 'merge') output(merge(process.env.FORK_SHA, process.env.UPSTREAM_SHA));
  else if (command === 'publish') {
    currentHead(process.env.FORK_SHA);
    const result = merge(process.env.FORK_SHA, process.env.UPSTREAM_SHA);
    assert(result.commit === process.env.VALIDATED_COMMIT && result.tree === process.env.VALIDATED_TREE, 'Validated commit/tree mismatch');
    const release = plan(result.commit, result.upstream);
    git('-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `${result.commit}:refs/heads/master`);
    currentHead(result.commit);
    publishTag(release.tag, release.commit);
    output(release);
  } else throw new Error('Unknown command');
}
