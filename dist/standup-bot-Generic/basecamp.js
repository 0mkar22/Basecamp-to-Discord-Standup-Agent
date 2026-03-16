"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBasecampHeaders = getBasecampHeaders;
exports.fetchAllActiveProjectIds = fetchAllActiveProjectIds;
exports.fetchBasecampTasks = fetchBasecampTasks;
const dotenv = __importStar(require("dotenv"));
const rest_1 = require("@octokit/rest");
const libsodium_wrappers_1 = __importDefault(require("libsodium-wrappers"));
dotenv.config();
// ---------------------------------------------------------
// 1. CONFIG & REFRESH LOGIC
// ---------------------------------------------------------
function getBasecampHeaders() {
    return {
        "Authorization": `Bearer ${process.env.BASECAMP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "StandupBot/1.0 (obhogate48@gmail.com)"
    };
}
// Brought over from your original index.ts!
async function updateGitHubSecret(secretName, secretValue) {
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const githubToken = process.env.MY_GITHUB_PAT;
    if (!owner || !repo || !githubToken)
        return;
    const octokit = new rest_1.Octokit({ auth: githubToken });
    try {
        const { data: publicKeyData } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
        await libsodium_wrappers_1.default.ready;
        const binkey = libsodium_wrappers_1.default.from_base64(publicKeyData.key, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
        const binsec = libsodium_wrappers_1.default.from_string(secretValue);
        const encBytes = libsodium_wrappers_1.default.crypto_box_seal(binsec, binkey);
        const encryptedValue = libsodium_wrappers_1.default.to_base64(encBytes, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner, repo, secret_name: secretName, encrypted_value: encryptedValue, key_id: publicKeyData.key_id,
        });
        console.log(`🔐 Successfully updated GitHub secret: ${secretName}`);
    }
    catch (error) {
        console.error(`❌ Failed to update GitHub secret (${secretName}):`, error);
    }
}
async function refreshBasecampToken() {
    const clientId = process.env.BASECAMP_CLIENT_ID;
    const clientSecret = process.env.BASECAMP_CLIENT_SECRET;
    const refreshToken = process.env.BASECAMP_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Missing credentials for token renewal in .env.");
    }
    console.log("🔄 Basecamp token expired. Attempting to refresh...");
    const payload = new URLSearchParams({
        type: 'refresh',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
    });
    const response = await fetch('https://launchpad.37signals.com/authorization/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });
    if (!response.ok)
        throw new Error("Failed to refresh Basecamp token.");
    const data = await response.json();
    process.env.BASECAMP_ACCESS_TOKEN = data.access_token;
    await updateGitHubSecret('BASECAMP_ACCESS_TOKEN', data.access_token);
    if (data.refresh_token) {
        process.env.BASECAMP_REFRESH_TOKEN = data.refresh_token;
        await updateGitHubSecret('BASECAMP_REFRESH_TOKEN', data.refresh_token);
    }
    return data.access_token;
}
// ---------------------------------------------------------
// 2. DYNAMIC PROJECT FETCHER
// ---------------------------------------------------------
async function fetchAllActiveProjectIds() {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    if (!accountId)
        throw new Error("Missing BASECAMP_ACCOUNT_ID in .env");
    let response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });
    // 🔥 THE FIX: Catch the 401, refresh, and retry!
    if (response.status === 401) {
        console.log(`⚠️ 401 Unauthorized detected. Refreshing token...`);
        await refreshBasecampToken();
        response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
            method: 'GET',
            headers: getBasecampHeaders()
        });
    }
    if (!response.ok)
        throw new Error(`Failed to fetch projects: ${response.status} ${response.statusText}`);
    const projects = await response.json();
    return projects.map((proj) => proj.id.toString());
}
// ---------------------------------------------------------
// 3. TASK FETCHER
// ---------------------------------------------------------
async function fetchBasecampTasks(projectId) {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const baseUrl = `https://3.basecampapi.com/${accountId}/projects/${projectId}`;
    let response = await fetch(`${baseUrl}/timeline.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });
    // 🔥 Catch the 401 here too just in case!
    if (response.status === 401) {
        await refreshBasecampToken();
        response = await fetch(`${baseUrl}/timeline.json`, {
            method: 'GET',
            headers: getBasecampHeaders()
        });
    }
    if (!response.ok) {
        console.error(`⚠️ Could not fetch timeline for project ${projectId}. Skipping...`);
        return null;
    }
    const allEvents = await response.json();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const recentEvents = allEvents.filter((event) => new Date(event.created_at) >= yesterday);
    return recentEvents.length > 0 ? recentEvents : null;
}
