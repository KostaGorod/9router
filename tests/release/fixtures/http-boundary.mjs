// Redirect only the helper's external HTTP boundaries to an isolated local server.
// All Git operations and the shipped helper run unchanged in a fresh subprocess.
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (!['api.github.com', 'uploads.github.com', 'ghcr.io'].includes(url.hostname)) {
    throw new Error(`Unexpected fixture host: ${url.hostname}`);
  }
  return fetch(`${process.env.FIXTURE_HTTP}/${url.hostname}${url.pathname}${url.search}`, options);
};
