const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `http://localhost:${PORT}/webhook/github`;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function computeSignature(payloadString, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payloadString);
  return `sha256=${hmac.digest("hex")}`;
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

async function sendRequest(payload, signature) {
  const payloadString = JSON.stringify(payload);
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature,
    },
    body: payloadString,
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  console.log(`HTTP ${response.status} ${response.statusText}`);
  console.log(JSON.stringify(parsed, null, 2));
}

async function main() {
  const mode = process.argv[2] || "1";

  if (mode === "1" || mode === "real") {
    // Scenario 1: Real GitHub PR
    const payload = buildPayload({
      owner: "namantyagi701",
      name: "gitRag",
      prNumber: 1,
      baseSha: "7d4b4cd5e79c685f7b4a66a06109c6c24f48f615",
      headSha: "e6250093b22b8d6517ecd6e184d61cff65c8c7e5",
    });
    const payloadString = JSON.stringify(payload);
    const signature = computeSignature(payloadString, SECRET);
    await sendRequest(payload, signature);
  } else if (mode === "2") {
    // Scenario 2: Signature rejection
    const payload = buildPayload({
      owner: "namantyagi701",
      name: "gitRag",
      prNumber: 106,
      baseSha: "e3b008b",
      headSha: "2c50b78",
    });
    const badSignature = "sha256=" + "0".repeat(64);
    await sendRequest(payload, badSignature);
  } else if (mode === "3") {
    // Scenario 3: Unregistered repo
    const payload = buildPayload({
      owner: "facebook",
      name: "react",
      prNumber: 107,
      baseSha: "e3b008b",
      headSha: "2c50b78",
    });
    const payloadString = JSON.stringify(payload);
    const signature = computeSignature(payloadString, SECRET);
  } else if (mode === "fail") {
    // Failure path test: PR 108 with valid signature but invalid GITHUB_TOKEN
    const payload = buildPayload({
      owner: "namantyagi701",
      name: "gitRag",
      prNumber: 108,
      baseSha: "e3b008b",
      headSha: "2c50b78",
    });
    const payloadString = JSON.stringify(payload);
    const signature = computeSignature(payloadString, SECRET);
    await sendRequest(payload, signature);
  }
}

main().catch(console.error);
