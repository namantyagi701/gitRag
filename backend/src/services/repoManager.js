/**
 * Repository Clone & Fetch Management Service
 *
 * Maintains a persistent local clone of repositories at a predictable path:
 * ./repo-clones/<owner>-<name>
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
 * @param {string} [params.repoUrl] - Optional clone URL
 * @param {string} [params.accessToken] - Optional GitHub access token for private repos
 * @returns {Promise<string>} Absolute filesystem path to local clone directory
 */
async function ensureLocalClone({ owner, name, repoUrl, accessToken }) {
  if (!owner || !name) {
    throw new Error("Missing required owner or name parameter in ensureLocalClone");
  }

  const authenticatedUrl = accessToken
    ? `https://x-access-token:${accessToken}@github.com/${owner}/${name}.git`
    : `https://github.com/${owner}/${name}.git`;
  const targetUrl = repoUrl || authenticatedUrl;
  const clonesDir = path.resolve(__dirname, "../../../repo-clones");
  const clonePath = path.join(clonesDir, `${owner}-${name}`);

  if (!fs.existsSync(clonesDir)) {
    fs.mkdirSync(clonesDir, { recursive: true });
  }

  if (fs.existsSync(path.join(clonePath, ".git"))) {
    console.log(`[repoManager] Updating existing clone at ${clonePath}...`);
    const git = simpleGit(clonePath);
    if (accessToken) {
      // Keep remote URL authenticated for subsequent fetches
      try {
        await git.remote(["set-url", "origin", authenticatedUrl]);
      } catch (_) {}
    }
    await git.fetch(["--all"]);
    console.log(`[repoManager] Fetch completed for ${owner}/${name}`);
  } else {
    console.log(`[repoManager] Cloning ${owner}/${name} to ${clonePath}...`);
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
    const git = simpleGit();
    await git.clone(targetUrl, clonePath);
    console.log(`[repoManager] Clone completed for ${owner}/${name}`);
  }

  return clonePath;
}

module.exports = {
  ensureLocalClone
};
