import path from 'path';
import express from 'express';
import * as dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import cron from 'node-cron';
import { generateStandupSummary, processGitHubWebhookWithAI, processPMWebhookWithAI, generatePRSummary, generateWeeklyChangelog } from './ai';
import { PMAdapter } from './adapters/PMAdapter';
import { BasecampAdapter, fetchAllActiveProjectIds, fetchBasecampTasks } from './adapters/basecamp'; // ⬅️ Fixed imports!
import { JiraAdapter } from './adapters/jira';
import { postToDiscord } from './discord';
import { cleanAndTruncateDiff } from './utils';

// ---------------------------------------------------------
// 🧠 TRON'S MEMORY BANK: Idempotency Cache
// ---------------------------------------------------------
// Stores webhook IDs and the time they were received
const processedWebhooks = new Map<string, number>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (Webhooks older than 10 mins are forgotten)

function isDuplicateWebhook(webhookId: string): boolean {
    const now = Date.now();
    
    // 🧹 Self-Cleaning: Erase old memories so the server doesn't run out of RAM
    for (const [id, timestamp] of processedWebhooks.entries()) {
        if (now - timestamp > CACHE_TTL_MS) {
            processedWebhooks.delete(id);
        }
    }

    // 🛑 The Circuit Breaker: If we remember this ID, it's a duplicate!
    if (processedWebhooks.has(webhookId)) {
        return true;
    }

    // Otherwise, remember it for next time
    processedWebhooks.set(webhookId, now);
    return false;
}

// ---------------------------------------------------------
// ⏳ THE RESILIENCE ENGINE: Fetch with Exponential Backoff
// ---------------------------------------------------------
async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    let delayMs = 1000; // Start with a 1-second delay

    while (attempt < maxRetries) {
        try {
            const response = await fetch(url, options);

            // If it succeeds, or if it's a guaranteed user error (like 400 Bad Request, 401, 403, 404), 
            // do NOT retry. Only retry on server crashes (5xx) or rate limits (429).
            if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
                return response;
            }

            console.log(`⚠️ [RETRY ENGINE] API returned ${response.status}. Retrying in ${delayMs / 1000}s... (Attempt ${attempt + 1}/${maxRetries})`);
        } catch (error: any) {
            // This catches pure network disconnects (fetch failed)
            console.log(`⚠️ [RETRY ENGINE] Network failure: ${error.message}. Retrying in ${delayMs / 1000}s... (Attempt ${attempt + 1}/${maxRetries})`);
        }

        attempt++;
        if (attempt >= maxRetries) {
            console.error(`❌ [RETRY ENGINE] Max retries (${maxRetries}) reached for ${url}. Giving up.`);
            throw new Error(`Failed to fetch after ${maxRetries} attempts`);
        }

        // 🛑 Pause the execution for 'delayMs' milliseconds
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        // 📈 Exponential Backoff: Double the wait time for the next attempt (1s -> 2s -> 4s)
        delayMs *= 2; 
    }
    
    throw new Error("Unreachable");
}

// 🔌 THE PLUG-AND-PLAY REGISTRY
const adapterRegistry: Record<string, PMAdapter> = {
    'basecamp': BasecampAdapter,
    'jira': JiraAdapter,
};

dotenv.config();

// 🛡️ PRODUCTION CLEANUP 1: Fail-Fast Startup Checker
const requiredEnvVars = ['OPENROUTER_API_KEY', 'BASECAMP_ACCOUNT_ID', 'MY_GITHUB_PAT', 'DISCORD_WEBHOOK_URL'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`🚨 FATAL ERROR: Missing required environment variable: ${envVar}`);
        process.exit(1); // Kill the server immediately so it doesn't fail silently later
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// 🛡️ THE IRON GATE: We must save the raw, unformatted payload for HMAC cryptography!
app.use(express.json({
    limit: '2mb',
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

// 🛡️ PRODUCTION CLEANUP 2: Strict TypeScript Interfaces
interface RepoMapping {
    githubRepo: string;
    pmProvider: string;
    pmProjectName: string;
}

// Safely parse the config file
let config: { authorized_repos: RepoMapping[] };
try {
    // 🛡️ THE FIX: __dirname guarantees it always looks in the exact same folder as server.ts!
    const configPath = path.join(__dirname, 'config.json'); 
    const rawConfig = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(rawConfig);
} catch (error) {
    console.error(`🚨 FATAL ERROR: Could not read or parse config.json. Is the file formatted correctly?`);
    process.exit(1);
}

app.get('/', (req, res) => {
    res.send('🤖 Tron Universal DevOps Router is Online.');
});
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// 🛡️ THE IRON GATE BOUNCER FUNCTION
function verifyGitHubSignature(req: any): boolean {
    const signature = req.headers['x-hub-signature-256'];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret || !signature || !req.rawBody) {
        return false; // Automatically fail if anything is missing
    }

    // Do the exact same SHA-256 math that GitHub did
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    // Compare our math with GitHub's math safely to prevent timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature as string));
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------
// 💓 HEALTH CHECK: Google Cloud Run Heartbeat
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.status(200).send('Tron is alive, awake, and ready.');
});

// ROUTE 1: The Daily Standup Generator
app.post('/webhook', async (req, res) => {
    console.log('\n📥 ALERT: Received a manual webhook to generate daily standup!');
    res.status(200).send('Webhook received...');
    try {
        const allProjectIds = await fetchAllActiveProjectIds();
        const allProjectsData: Record<string, any> = {};
        for (const projectId of allProjectIds) {
            const data = await fetchBasecampTasks(projectId);
            if (data) allProjectsData[`Project_${projectId}`] = data;
        }
        if (Object.keys(allProjectsData).length === 0) return;
        const summaryMarkdown = await generateStandupSummary(allProjectsData);
        await postToDiscord(summaryMarkdown);
    } catch (error) {
        console.error("❌ Error:", error);
    }
});

// ---------------------------------------------------------
// 💓 HEALTH CHECK: Google Cloud Run Heartbeat
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.status(200).send('Tron is alive, awake, and ready.');
});

// ---------------------------------------------------------
// ROUTE 2: Universal Version Control Webhook (e.g. GitHub)
// ---------------------------------------------------------
app.post('/github-webhook', async (req, res) => {
    
    // 🛑 THE IRON GATE CHECK
    if (!verifyGitHubSignature(req)) {
        console.error("🚨 INTRUDER ALERT: Invalid GitHub Webhook Signature Detected!");
        return res.status(401).send("Unauthorized");
    }

    res.status(200).send('OK'); // It's legit! Acknowledge quickly.
    const githubEvent = req.headers['x-github-event'];
    
    // 🚀 SCENARIO A: A Developer Pushed Code
    if (githubEvent === 'push') {
        const repoName = req.body.repository.name;
        const pusherName = req.body.pusher.name;
        const commits = req.body.commits || []; 
        
        console.log(`\n🐙 [VCS EVENT] Push received from ${pusherName} in repo: ${repoName}`);

        const mapping = config.authorized_repos.find((m: any) => m.githubRepo === repoName);
        
        if (mapping) {
            console.log(`✅ Authorized! Routing to PM Provider: [${mapping.pmProvider.toUpperCase()}] for project: ${mapping.pmProjectName}`);
            
            try {
                console.log(`🧠 Handing commits over to Tron AI...`);
                const aiResult = await processGitHubWebhookWithAI(repoName, mapping.pmProjectName, pusherName, commits, mapping.pmProvider);
                
                let message = `🚀 **${pusherName}** just pushed **${commits.length}** commit(s) to \`${repoName}\`:\n`;
                for (const commit of commits) {
                    message += `- ${commit.message} ([View Code](${commit.url}))\n`;
                }
                message += `\n🤖 **Tron AI Status (${mapping.pmProvider}):** ${aiResult}`; 
                
                await postToDiscord(message);
            } catch (error) {
                console.error("❌ AI Processing Error:", error);
            }
            
        } else {
            console.log(`⚠️ UNAUTHORIZED REPO (${repoName}). Blocked.`);
        }
    }
    // 🎯 SCENARIO B: A Developer Closed OR Reopened an Issue
    else if (githubEvent === 'issues' && ['closed', 'reopened'].includes(req.body?.action)) {
        const action = req.body.action;
        console.log(`\n🚨 [GITHUB EVENT] Issue ${action.toUpperCase()}: ${req.body?.issue?.title}`);
        
        const issueBody = String(req.body?.issue?.body || "");
        const repoName = req.body?.repository?.name; 

        // 🛡️ THE BULLETPROOF REGEX
        const regex = /Basecamp Task ID:\s*(\d+)/i;
        const idMatch = issueBody.match(regex);

        if (idMatch !== null && idMatch[1]) {
            const pmTaskId = idMatch[1].trim(); 
            console.log(`🔗 Found tethered Task ID: ${pmTaskId}`);
            
            const mapping = config.authorized_repos.find((repo: any) => repo.githubRepo === repoName);
            
            if (mapping && mapping.pmProvider) {
                // 🔌 THE ROUTER MAGIC: Grab the correct adapter!
                const activeAdapter = adapterRegistry[mapping.pmProvider];

                if (activeAdapter) {
                    console.log(`🔍 Looking up Project ID for: '${mapping.pmProjectName}' via ${mapping.pmProvider.toUpperCase()}...`);
                    const pmProjectId = await activeAdapter.searchProject(mapping.pmProjectName);

                    if (pmProjectId) {
                        // 🔀 THE FORK IN THE ROAD
                        if (action === 'closed') {
                            await activeAdapter.completeTask(pmProjectId, pmTaskId);
                        } else if (action === 'reopened') {
                            await activeAdapter.uncompleteTask(pmProjectId, pmTaskId);
                        }
                    } else {
                        console.log(`❌ Could not find a project named ${mapping.pmProjectName} in ${mapping.pmProvider}`);
                    }
                } else {
                    console.error(`❌ Adapter for ${mapping.pmProvider} is not registered in Tron!`);
                }
            } else {
                console.log(`🤷‍♂️ Repo ${repoName} is not mapped in config.json.`);
            }
            
        } else {
            console.log(`🤷‍♂️ No hidden Task ID found in this issue. Ignoring.`);
        }
    }
    // 🎯 SCENARIO C: A Developer Opened a Pull Request
    else if (githubEvent === 'pull_request' && req.body?.action === 'opened') {
        const prTitle = req.body.pull_request.title;
        const prUrl = req.body.pull_request.html_url;
        const diffUrl = req.body.pull_request.diff_url;
        const developerName = req.body.pull_request.user.login;
        const repoName = req.body.repository.name;

        console.log(`\n🚨 [GITHUB EVENT] Pull Request Opened: ${prTitle}`);
        console.log(`📥 Fetching raw code changes from: ${diffUrl}`);

        try {
            const diffResponse = await fetch(diffUrl);
            
            if (diffResponse.ok) {
                const rawDiff = await diffResponse.text();
                console.log(`✅ Successfully downloaded PR Diff! Size: ${rawDiff.length} characters.`);
                
                const safeDiff = cleanAndTruncateDiff(rawDiff);
                const aiSummary = await generatePRSummary(prTitle, developerName, safeDiff);
                
                const finalMessage = `🚨 **New Pull Request by ${developerName}**\n**Title:** ${prTitle}\n\n**Tron's Executive Summary:**\n${aiSummary}\n\n🔗 [View PR on GitHub](${prUrl})`;
                postToDiscord(finalMessage);

                const mapping = config.authorized_repos.find((repo: any) => repo.githubRepo === repoName);
                
                if (mapping && mapping.pmProvider) {
                    // 🔌 THE ROUTER MAGIC: Grab the correct adapter!
                    const activeAdapter = adapterRegistry[mapping.pmProvider];

                    if (activeAdapter) {
                        console.log(`🔍 Routing AI Summary to ${mapping.pmProvider.toUpperCase()} Project: '${mapping.pmProjectName}'...`);
                        await activeAdapter.postPRSummary(mapping.pmProjectName, prTitle, developerName, aiSummary, prUrl);
                    } else {
                        console.error(`❌ Adapter for ${mapping.pmProvider} is not registered in Tron!`);
                    }
                } else {
                    console.log(`🤷‍♂️ Repo ${repoName} is not mapped in config.json. Skipping PM update.`);
                }
                
            } else {
                console.error(`❌ Failed to download PR Diff. Status: ${diffResponse.status}`);
            }
        } catch (error: any) {
            console.error(`❌ Error fetching PR Diff: ${error.message}`);
        }
    }
});

// ---------------------------------------------------------
// ROUTE 3: Universal PM Webhook (PM -> Dev Flow)
// ---------------------------------------------------------

// ---------------------------------------------------------
// 🐙 THE REVERSE SYNC: Direct Issue API Fetch (Bypasses Search API)
// ---------------------------------------------------------
async function syncGitHubIssueState(basecampTaskId: string, targetState: 'open' | 'closed') {
    const owner = process.env.REPO_OWNER || "0mkar22"; 
    const repo = "Basecamp-to-Discord-Standup-Agent"; 
    
    console.log(`\n🔄 [REVERSE SYNC] Fetching issues to find Basecamp ID: ${basecampTaskId}...`);

    try {
        // 1. BYPASS SEARCH API: Grab the list of issues directly from the repo.
        // We use state=all so we can find the issue whether it's currently open or closed.
        const issuesUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100`;

        const issuesRes = await fetchWithRetry(issuesUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.MY_GITHUB_PAT}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Tron-Universal-Router'
            }
        });

        if (!issuesRes.ok) {
            const errorData = await issuesRes.json();
            console.error(`❌ GitHub Issues API Error: ${issuesRes.status} - ${errorData.message}`);
            return;
        }

        const issues = await issuesRes.json();

        // 2. Perform a fast local search to hunt down the Basecamp ID
        const matchingIssue = issues.find((issue: any) => 
            issue.body && issue.body.includes(basecampTaskId)
        );

        if (!matchingIssue) {
            console.log(`🤷‍♂️ No GitHub issue found containing Basecamp ID ${basecampTaskId}. Skipping.`);
            return;
        }

        const issueNumber = matchingIssue.number;
        console.log(`🔍 Found matching GitHub Issue: #${issueNumber}. Setting state to '${targetState}'...`);

        // 3. Patch the issue with the new state
        const patchRes = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${process.env.MY_GITHUB_PAT}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ state: targetState })
        });

        if (patchRes.ok) {
            console.log(`✅ [REVERSE SYNC] Successfully marked GitHub Issue #${issueNumber} as ${targetState.toUpperCase()}!`);
        } else {
            console.error(`❌ Failed to update GitHub issue. Status: ${patchRes.status}`);
        }

    } catch (error: any) {
        console.error(`❌ Error during Reverse Sync: ${error.message}`);
    }
}

// ---------------------------------------------------------
// 💓 HEALTH CHECK: Google Cloud Run Heartbeat
// ---------------------------------------------------------
app.get('/health', (req, res) => {
    res.status(200).send('Tron is alive, awake, and ready.');
});

app.post('/pm-webhook/:provider', async (req, res) => {
    
    // 🛑 THE UNIVERSAL IRON GATE
    const providedToken = req.query.token;
    const expectedToken = process.env.UNIVERSAL_WEBHOOK_SECRET;

    // Print exact values with single quotes around them to catch invisible spaces!
    // console.log(`🕵️ DEBUG: Basecamp sent: '${providedToken}' | Tron expected: '${expectedToken}'`);

    if (!providedToken || providedToken !== expectedToken) {
        console.error(`🚨 INTRUDER ALERT: Unauthorized access attempt to /pm-webhook/${req.params.provider}`);
        return res.status(401).send("Unauthorized");
    }

    res.status(200).send('Webhook received'); // Acknowledge quickly

    // ---------------------------------------------------------
    // 🛑 CIRCUIT BREAKER: Trap Duplicate Webhooks
    // ---------------------------------------------------------
    let uniqueDeliveryId = "";

    if (req.params.provider === 'github') {
        // GitHub sends a guaranteed unique delivery ID in the headers
        uniqueDeliveryId = req.headers['x-github-delivery'] as string || `gh_${Date.now()}`;
    } else if (req.params.provider === 'basecamp') {
        // Basecamp doesn't send a header ID, so we create a unique fingerprint
        // based on the task ID, the event kind, and the project ID
        const taskId = req.body.recording?.id || "unknown";
        const kind = req.body.kind || "unknown";
        const projectId = req.body.bucket?.id || "unknown";
        uniqueDeliveryId = `bc_${projectId}_${taskId}_${kind}`;
    }

    // Check the memory bank!
    if (isDuplicateWebhook(uniqueDeliveryId)) {
        console.log(`\n🛡️ [CIRCUIT BREAKER] Blocked duplicate webhook delivery: ${uniqueDeliveryId}`);
        return res.status(200).send("Duplicate ignored"); // Tell the provider "We got it" so they stop retrying
    }

    const provider = req.params.provider; 
    const kind = req.body.kind || "unknown_event";
    const creator = req.body.creator?.name || req.body.creator || "Someone";
    
    // 🛑 THE GHOST ECHO FILTER
    if (creator === "Tron Automation Agent" || creator === "YOUR_BOTS_BASECAMP_NAME") {
        console.log(`👻 Ghost Echo detected: Ignoring webhook triggered by Tron.`);
        return res.status(200).send("Ignored Bot Event");
    }
    const projectName = req.body.recording?.bucket?.name || req.body.projectName;
    const taskContent = req.body.recording?.title || req.body.recording?.content || req.body.taskContent || "New item created";
    const taskId = req.body.recording?.id || "unknown_id";

    // ---------------------------------------------------------
    // 🔄 REVERSE SYNC INTERCEPTOR: Basecamp -> GitHub
    // ---------------------------------------------------------
    if (req.params.provider === 'basecamp' && (req.body.kind === 'todo_completed' || req.body.kind === 'todo_uncompleted')) {
        const taskTitle = req.body.recording?.content || "Unknown Task";
        const basecampTaskId = req.body.recording?.id; 
        
        // 🎛️ Map the Basecamp event to the GitHub state
        const targetState = req.body.kind === 'todo_completed' ? 'closed' : 'open';
        
        console.log(`\n🎯 [BASECAMP EVENT] Task ${targetState === 'closed' ? 'Checked' : 'Un-checked'}: ${taskTitle} (ID: ${basecampTaskId})`);
        
        if (basecampTaskId) {
            // Pass the ID and the dynamic state to our function!
            await syncGitHubIssueState(basecampTaskId.toString(), targetState);
        } else {
            console.log(`🤷‍♂️ Basecamp payload did not contain a task ID. Skipping.`);
        }
        
        // 🛑 THE FOOLPROOF EXPRESS FIX
        if (!res.headersSent) {
            res.status(200).send("Reverse sync processed"); 
        }
        return; 
    }
    
    // 🛡️ THE BOUNCER: Ignore everything except actual task creations!
    if (provider === "basecamp" && kind !== "todo_created") {
        console.log(`\n🙈 [PM EVENT] Ignoring background Basecamp event: ${kind}`);
        return; // Stop running the code!
    }

    console.log(`\n📋 [PM EVENT] Received webhook from provider: [${provider.toUpperCase()}]`);
    console.log(`↳ Extracted Project: ${projectName} | Task: ${taskContent}`);

    // 🔄 REVERSE LOOKUP: Find the GitHub repo linked to this PM project!
    const mapping = config.authorized_repos.find((m: any) => m.pmProvider === provider && m.pmProjectName === projectName);

    if (mapping) {
        console.log(`✅ Authorized PM Project matched! Associated GitHub Repo: ${mapping.githubRepo}`);
        
        try {
            console.log(`🧠 Handing PM event over to Tron AI...`);
            
            const aiResult = await processPMWebhookWithAI(
                taskContent,        // 1st
                mapping.githubRepo, // 2nd
                taskId,             // 3rd
                provider,           // 4th
                creator,            // 5th
                taskContent         // 6th (using taskContent for eventDetails here)
            );
            
            let message = `📋 **${creator}** created a new task in **${projectName}** (${provider}).\n`;
            message += `🤖 **Tron AI Status:** ${aiResult}`; 
            
            await postToDiscord(message);
        } catch (error) {
            console.error("❌ AI Processing Error:", error);
        }
    } else {
        console.log(`⚠️ UNAUTHORIZED OR UNMAPPED PM PROJECT (${projectName}). Blocked.`);
    }
});

// ---------------------------------------------------------
// ⏰ THE WEEKLY AGGREGATION ENGINE (Cron Job)
// ---------------------------------------------------------

cron.schedule('0 17 * * 5', async () => {
    console.log('\n⏰ [CRON] Executing Weekly Aggregation Engine...');
    
    // 1. Get a unique list of all PM projects from our config file
    const uniqueProjects = [...new Set(config.authorized_repos.map(r => JSON.stringify({ provider: r.pmProvider, name: r.pmProjectName })))].map(s => JSON.parse(s));

    for (const proj of uniqueProjects) {
        const activeAdapter = adapterRegistry[proj.provider];
        if (!activeAdapter) continue;

        console.log(`🔍 [CRON] Processing Project: ${proj.name} (${proj.provider})`);
        
        // 2. Look up the project ID
        const projectId = await activeAdapter.searchProject(proj.name);
        
        if (projectId) {
            // 3. Fetch the 7-day data
            const weeklyTasks = await activeAdapter.fetchWeeklyCompletedTasks(projectId);
            
            // 4. Send to the AI Chief of Staff
            const summary = await generateWeeklyChangelog(proj.name, weeklyTasks);
            
            // 5. Post the Newsletter to Discord!
            const finalMessage = `📢 **Weekly Velocity Report: ${proj.name}**\n\n${summary}`;
            await postToDiscord(finalMessage);
        }
    }
}, {
    timezone: "Asia/Kolkata"
});

const server = app.listen(PORT, () => {
    console.log(`🚀 Tron Universal Router is awake at http://localhost:${PORT}`);
    console.log(`👂 Listening for VCS events at /github-webhook`);
    console.log(`👂 Listening for PM events at /pm-webhook/:provider`);
    console.log(`🛡️  Iron Gate Security: ENABLED`);
    console.log(`🧠 Circuit Breaker: ACTIVE`);
    console.log(`⏳ Resilience Engine: ONLINE`);
});

// 🛟 GLOBAL SAFETY NET: Prevent the server from crashing if an unknown error occurs
process.on('uncaughtException', (error) => {
    console.error('🚨 [CRITICAL] Uncaught Exception caught! Server stays alive.', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [CRITICAL] Unhandled Promise Rejection caught! Server stays alive.', reason);
});

// 🛑 GRACEFUL SHUTDOWN: Cloud Run Scale-to-Zero Handler
// When Google Cloud Run scales down to save money, it sends a SIGTERM signal.
process.on('SIGTERM', () => {
    console.log('☁️ [CLOUD RUN] SIGTERM signal received. Initiating graceful shutdown...');
    server.close(() => {
        console.log('💤 Server connection closed. All tasks completed.');
        process.exit(0);
    });
});