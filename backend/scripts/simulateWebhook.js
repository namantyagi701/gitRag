/**
 * Script to simulate GitHub Webhook calls with HMAC-SHA256 signatures.
 *
 * Usage:
 *   node scripts/simulateWebhook.js --valid
 *   node scripts/simulateWebhook.js --invalid-sig
 *   node scripts/simulateWebhook.js --unregistered
 *   node scripts/simulateWebhook.js --all
 */

const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `http://localhost:${PORT}/webhook/github`;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET || "test_webhook_secret_gitrag";

function computeSignature(payloadString, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payloadString);
  return `sha256=${hmac.digest("hex")}`;
}

async function sendWebhook({ payload, signature, description }) {
  console.log(`\n==================================================`);
  console.log(`[SIMULATE] ${description}`);
  console.log(`Endpoint: ${WEBHOOK_URL}`);
  console.log(`Signature: ${signature}`);

  const payloadString = JSON.stringify(payload);

  try {
    const startTime = Date.now();
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body: payloadString,
    });
    const duration = Date.now() - startTime;

    const data = await response.json().catch(() => ({}));
    console.log(`Response Status: ${response.status} ${response.statusText} (${duration}ms)`);
    console.log(`Response Body:`, JSON.stringify(data, null, 2));

    return { status: response.status, data, duration };
  } catch (err) {
    console.error(`[SIMULATE ERROR] Request failed:`, err.message);
    return { error: err.message };
  }
}

function buildPayload({ owner, name, prNumber, baseSha, headSha }) {
  return {
    action: "opened",
    number: prNumber,
    pull_request: {
      number: prNumber,
      state: "open",
      head: {
        sha: headSha,
        repo: {
          full_name: `${owner}/${name}`,
        },
      },
      base: {
        sha: baseSha,
        repo: {
          full_name: `${owner}/${name}`,
        },
      },
    },
    repository: {
      name: name,
      full_name: `${owner}/${name}`,
      owner: {
        login: owner,
      },
      clone_url: `https://github.com/${owner}/${name}.git`,
    },
  };
}

async function testValid() {
  const payload = buildPayload({
    owner: "namantyagi701",
    name: "gitRag",
    prNumber: 99,
    baseSha: "e3b008b",
    headSha: "2c50b78",
  });
  const payloadStr = JSON.stringify(payload);
  const signature = computeSignature(payloadStr, SECRET);

  return await sendWebhook({
    payload,
    signature,
    description: "Scenario 1: Valid PR webhook for registered repo (namantyagi701/gitRag #99)",
  });
}

async function testInvalidSignature() {
  const payload = buildPayload({
    owner: "namantyagi701",
    name: "gitRag",
    prNumber: 100,
    baseSha: "e3b008b",
    headSha: "2c50b78",
  });
  const badSignature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";

  return await sendWebhook({
    payload,
    signature: badSignature,
    description: "Scenario 2: Invalid signature rejection test",
  });
}

async function testUnregisteredRepo() {
  const payload = buildPayload({
    owner: "facebook",
    name: "react",
    prNumber: 101,
    baseSha: "e3b008b",
    headSha: "2c50b78",
  });
  const payloadStr = JSON.stringify(payload);
  const signature = computeSignature(payloadStr, SECRET);

  return await sendWebhook({
    payload,
    signature,
    description: "Scenario 3: Unregistered repo skip test (facebook/react)",
  });
}

async function main() {
  const arg = process.argv[2] || "--all";

  if (arg === "--valid") {
    await testValid();
  } else if (arg === "--invalid-sig") {
    await testInvalidSignature();
  } else if (arg === "--unregistered") {
    await testUnregisteredRepo();
  } else {
    console.log("Running all webhook simulation tests...");
    await testInvalidSignature();
    await testUnregisteredRepo();
    await testValid();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  testValid,
  testInvalidSignature,
  testUnregisteredRepo,
};
