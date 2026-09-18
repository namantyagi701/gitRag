/**
 * GitHub PR Commenter Service
 *
 * NOTE: For v1, this service authenticates using a GitHub Personal Access Token (PAT)
 * specified via GITHUB_TOKEN. In a full production setup, a GitHub App using
 * installation tokens (scoped per-repo rather than a static token with broad access)
 * would be used instead, but that is out of scope for v1.
 */

const { Octokit } = require("@octokit/rest");

/**
 * Post a markdown comment to a GitHub Pull Request (using the Issues API).
 *
 * @param {Object} params
 * @param {string} params.owner - Repository owner
 * @param {string} params.name - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {string} params.markdownBody - Comment body in Markdown
 * @returns {Promise<{ success: boolean, url?: string, error?: string }>}
 */
async function postImpactComment({ owner, name, prNumber, markdownBody }) {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    const errorMsg = "GITHUB_TOKEN is not configured in environment; skipping comment posting.";
    console.warn(`[githubCommenter WARN] ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  try {
    const octokit = new Octokit({ auth: token });

    console.log(`[githubCommenter] Posting impact analysis comment to ${owner}/${name} #${prNumber}...`);

    const response = await octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: prNumber,
      body: markdownBody
    });

    const htmlUrl = response.data?.html_url;
    console.log(`[githubCommenter] Comment successfully posted: ${htmlUrl}`);

    return {
      success: true,
      url: htmlUrl
    };
  } catch (err) {
    console.error(`[githubCommenter ERROR] Failed to post comment to ${owner}/${name} #${prNumber}:`, err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  postImpactComment
};
