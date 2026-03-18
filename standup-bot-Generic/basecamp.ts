import * as dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

dotenv.config();

// ---------------------------------------------------------
// 1. CONFIG & REFRESH LOGIC
// ---------------------------------------------------------
export function getBasecampHeaders() {
    return {
        "Authorization": `Bearer ${process.env.BASECAMP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "StandupBot/1.0 (obhogate48@gmail.com)"
    };
}

// Brought over from your original index.ts!
async function updateGitHubSecret(secretName: string, secretValue: string) {
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const githubToken = process.env.MY_GITHUB_PAT;

    if (!owner || !repo || !githubToken) return;

    const octokit = new Octokit({ auth: githubToken });
    try {
        const { data: publicKeyData } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
        await sodium.ready;
        const binkey = sodium.from_base64(publicKeyData.key, sodium.base64_variants.ORIGINAL);
        const binsec = sodium.from_string(secretValue);
        const encBytes = sodium.crypto_box_seal(binsec, binkey);
        const encryptedValue = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner, repo, secret_name: secretName, encrypted_value: encryptedValue, key_id: publicKeyData.key_id,
        });
        console.log(`🔐 Successfully updated GitHub secret: ${secretName}`);
    } catch (error) {
        console.error(`❌ Failed to update GitHub secret (${secretName}):`, error);
    }
}

async function refreshBasecampToken(): Promise<string> {
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

    if (!response.ok) throw new Error("Failed to refresh Basecamp token.");

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
export async function fetchAllActiveProjectIds(): Promise<string[]> {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    if (!accountId) throw new Error("Missing BASECAMP_ACCOUNT_ID in .env");

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

    if (!response.ok) throw new Error(`Failed to fetch projects: ${response.status} ${response.statusText}`);
    
    const projects = await response.json();
    return projects.map((proj: any) => proj.id.toString());
}

// ---------------------------------------------------------
// 3. TASK FETCHER
// ---------------------------------------------------------
export async function fetchBasecampTasks(projectId: string) {
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

    const recentEvents = allEvents.filter((event: any) => new Date(event.created_at) >= yesterday);
    return recentEvents.length > 0 ? recentEvents : null;
}

// ---------------------------------------------------------
// 4. AI TOOLS (Phase 4 Adapter)
// ---------------------------------------------------------

/**
 * BASECAMP ADAPTER: Updates a Basecamp project with GitHub commit details.
 */
export async function syncCommitToTask_Basecamp(projectName: string, commitMessage: string, developerName: string) {
    console.log(`\n⚙️ --- BASECAMP ADAPTER EXECUTED --- ⚙️`);
    console.log(`🎯 Searching Basecamp for Project: '${projectName}'...`);

    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    // We re-use the header function you wrote in Phase 1!
    const headers = getBasecampHeaders();

    try {
        // 1. Fetch all projects to find the matching ID
        const projRes = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, { headers });
        const projects = await projRes.json();

        // Match the name exactly as it is written in config.json
        const targetProject = projects.find((p: any) => p.name === projectName);

        if (!targetProject) {
            console.log(`❌ Project '${projectName}' not found in Basecamp.`);
            return `Failed: Could not find Basecamp project named ${projectName}.`;
        }

        console.log(`✅ Found Project ID: ${targetProject.id}`);

        // 2. Find the project's Campfire (Chat room) API endpoint
        const campfire = targetProject.dock.find((tool: any) => tool.name === 'chat' || tool.name === 'campfire');

        if (!campfire) {
             console.log(`⚠️ No Campfire found for this project.`);
             return "Failed: This Basecamp project does not have a Campfire chat room.";
        }

        // 3. Post the commit message to the Campfire!
        const postUrl = campfire.url.replace('.json', '/lines.json');
        
        const messagePayload = {
            // We removed the HTML tags and used standard line breaks (\n)
            content: `🚀 ${developerName} just pushed code via GitHub:\n\n"${commitMessage}"`
        };

        const postRes = await fetch(postUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(messagePayload)
        });

        if (postRes.ok) {
            console.log(`✅ Status: Successfully dropped commit log into Basecamp Campfire!`);
            console.log(`------------------------------\n`);
            return "Successfully updated Basecamp.";
        } else {
            console.log(`❌ Failed to post to Basecamp API.`);
            return "Failed to post message to Basecamp Campfire.";
        }

    } catch (error) {
        console.error("❌ Basecamp API Error:", error);
        return "Failed to sync to Basecamp due to a server error.";
    }
}

export async function completeTask_Basecamp(projectId: string, taskId: string): Promise<boolean> {
    console.log(`\n⚙️ --- BASECAMP ADAPTER: COMPLETING TASK --- ⚙️`);
    console.log(`🎯 Target Project ID: ${projectId}`);
    console.log(`✅ Target Task ID: ${taskId}`);

    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const token = process.env.BASECAMP_ACCESS_TOKEN; // Or however you authenticate with Basecamp

    try {
        const response = await fetch(`https://3.basecampapi.com/${accountId}/buckets/${projectId}/todos/${taskId}/completion.json`, {
            method: 'POST', // Basecamp uses POST to complete a task
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Tron Automation Agent (obhogate48@gmail.com)'
            }
        });

        if (response.ok) {
            console.log(`✅ Status: Task ${taskId} successfully marked as completed in Basecamp!`);
            return true;
        } else {
            console.error(`❌ Basecamp API returned status: ${response.status}`);
            return false;
        }
    } catch (error: any) {
        console.error(`❌ Failed to complete Basecamp task: ${error.message}`);
        return false;
    }
}

export async function searchBasecampProject(targetProjectName: string): Promise<string | null> {
    console.log(`\n🎯 Searching Basecamp for Project: '${targetProjectName}'...`);
    
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const token = process.env.BASECAMP_ACCESS_TOKEN; // Or however you authenticate

    if (!accountId || !token) {
        console.error("❌ Missing BASECAMP_ACCOUNT_ID or BASECAMP_ACCESS_TOKEN in .env");
        return null;
    }

    try {
        // Fetch all projects this Basecamp account has access to
        const response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Tron Automation Agent (your@email.com)'
            }
        });

        if (!response.ok) {
            console.error(`❌ Failed to fetch Basecamp projects. API Status: ${response.status}`);
            return null;
        }

        const projects = await response.json();
        
        // Loop through the projects and find the exact match (case-insensitive just in case)
        const matchedProject = projects.find((p: any) => 
            p.name.toLowerCase() === targetProjectName.toLowerCase()
        );

        if (matchedProject) {
            console.log(`✅ Found Basecamp Project! ID: ${matchedProject.id}`);
            return matchedProject.id.toString(); // Return the ID so server.ts can use it!
        } else {
            console.error(`❌ Project '${targetProjectName}' not found in Basecamp.`);
            return null;
        }

    } catch (error: any) {
        console.error(`❌ Error searching Basecamp projects: ${error.message}`);
        return null;
    }
}