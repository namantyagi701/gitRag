/**
 * Repository Clone & Fetch Management Service
 *
 * Maintains a persistent local clone of repositories at a predictable path:
 * ./repo-clones/<owner>-<name>
 *
 * SECURITY:
 * GitHub access tokens are NEVER embedded into git URLs or written to .git/config on disk.
 * Authentication for private repositories is handled strictly via transient HTTP extra headers
 * passed per-command (-c http.extraheader=...), leaving .git/config completely clean.
 */

const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");

/**
 * Ensure a local clone of the repository exists and has the latest commits fetched.
 *
 * @param {Object} params
 * @param {string} params.owner - Repository owner
 * @param {string} params.name - Repository name
 * @param {string} [params.repoUrl] - Optional clone URL (will be sanitized if containing credentials)
 * @param {string} [params.accessToken] - Optional GitHub access token for private repos
 * @returns {Promise<string>} Absolute filesystem path to local clone directory
 */
async function ensureLocalClone({ owner, name, repoUrl, accessToken }) {
  if (!owner || !name) {
    throw new Error("Missing required owner or name parameter in ensureLocalClone");
  }

  // Always use a clean URL with no embedded credentials
  let targetUrl = repoUrl || `https://github.com/${owner}/${name}.git`;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      targetUrl = parsed.toString();
    }
  } catch (_) {
    // If not a standard URL, fallback to canonical GitHub https URL
    targetUrl = `https://github.com/${owner}/${name}.git`;
  }

  const clonesDir = path.resolve(__dirname, "../../../repo-clones");
  const clonePath = path.join(clonesDir, `${owner}-${name}`);

  if (!fs.existsSync(clonesDir)) {
    fs.mkdirSync(clonesDir, { recursive: true });
  }

  // Build transient basic authorization header if an access token is provided
  let authHeader = null;
  if (accessToken) {
    const credentials = Buffer.from(`x-access-token:${accessToken}`).toString("base64");
    authHeader = `AUTHORIZATION: basic ${credentials}`;
  }

  if (fs.existsSync(path.join(clonePath, ".git"))) {
    console.log(`[repoManager] Updating existing clone at ${clonePath}...`);
    const git = simpleGit(clonePath);

    // Ensure remote origin is sanitized and points to the clean URL (strip any old leaked token)
    try {
      await git.remote(["set-url", "origin", targetUrl]);
    } catch (_) {}

    if (authHeader) {
      // Use transient -c http.extraheader override; never writes token to .git/config
      await git.raw(["-c", `http.extraheader=${authHeader}`, "fetch", "--all"]);
    } else {
      await git.fetch(["--all"]);
    }
    console.log(`[repoManager] Fetch completed for ${owner}/${name}`);
  } else {
    console.log(`[repoManager] Cloning ${owner}/${name} to ${clonePath}...`);
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }

    const git = simpleGit();
    if (authHeader) {
      // Pass -c before the clone subcommand so it is transient and NOT written to .git/config
      await git.raw(["-c", `http.extraheader=${authHeader}`, "clone", targetUrl, clonePath]);
    } else {
      await git.clone(targetUrl, clonePath);
    }
    console.log(`[repoManager] Clone completed for ${owner}/${name}`);
  }

  return clonePath;
}

module.exports = {
  ensureLocalClone,
};
