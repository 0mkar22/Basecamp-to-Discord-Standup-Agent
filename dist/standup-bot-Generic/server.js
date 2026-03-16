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
const express_1 = __importDefault(require("express"));
const dotenv = __importStar(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const basecamp_1 = require("./basecamp");
const ai_1 = require("./ai");
const discord_1 = require("./discord");
dotenv.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use(express_1.default.json());
// 🛡️ PHASE 3: Load our Address Book (The Bouncer)
const rawConfig = fs_1.default.readFileSync('./config.json', 'utf-8');
const config = JSON.parse(rawConfig);
app.get('/', (req, res) => {
    res.send('🤖 Tron DevOps Automation Engine is Online.');
});
// ROUTE 1: The Daily Standup Generator
app.post('/webhook', async (req, res) => {
    console.log('\n📥 ALERT: Received a manual webhook to generate daily standup!');
    res.status(200).send('Webhook received, processing in background...');
    try {
        const allProjectIds = await (0, basecamp_1.fetchAllActiveProjectIds)();
        const allProjectsData = {};
        for (const projectId of allProjectIds) {
            const data = await (0, basecamp_1.fetchBasecampTasks)(projectId);
            if (data)
                allProjectsData[`Project_${projectId}`] = data;
        }
        if (Object.keys(allProjectsData).length === 0)
            return;
        const summaryMarkdown = await (0, ai_1.generateStandupSummary)(allProjectsData);
        await (0, discord_1.postToDiscord)(summaryMarkdown);
    }
    catch (error) {
        console.error("❌ Error:", error);
    }
});
// ROUTE 2: GitHub Listening Ear (Dev -> PM Flow)
app.post('/github-webhook', async (req, res) => {
    res.status(200).send('OK');
    const githubEvent = req.headers['x-github-event'];
    if (githubEvent === 'push') {
        const repoName = req.body.repository.name;
        const pusherName = req.body.pusher.name;
        const commits = req.body.commits || [];
        console.log(`\n🐙 [GITHUB EVENT] Push received from ${pusherName} in repo: ${repoName}`);
        // 🛡️ THE SECURITY GUARD: Check if repo is in config.json
        const mapping = config.authorized_repos.find((m) => m.githubRepo === repoName);
        if (mapping) {
            console.log(`✅ Authorized Repo matched! Associated Basecamp Project: ${mapping.basecampProjectName}`);
            // Only format and send to Discord because it passed the security check!
            let message = `🚀 **${pusherName}** just pushed **${commits.length}** commit(s) to the authorized repo \`${repoName}\`:\n`;
            for (const commit of commits) {
                message += `- ${commit.message} ([View Code](${commit.url}))\n`;
            }
            await (0, discord_1.postToDiscord)(message);
        }
        else {
            // 🛑 UNAUTHORIZED! Block it!
            console.log(`⚠️ UNAUTHORIZED REPO (${repoName}). Tron blocked this and will NOT send to Discord.`);
        }
    }
});
// ROUTE 3: Basecamp Listening Ear (PM -> Dev Flow)
app.post('/basecamp-webhook', (req, res) => {
    res.status(200).send('OK');
    const kind = req.body.kind;
    const creator = req.body.creator?.name || "Someone";
    console.log(`\n🏕️ [BASECAMP EVENT] Event type '${kind}' triggered by ${creator}`);
});
app.listen(PORT, () => {
    console.log(`🚀 Tron Engine is awake at http://localhost:${PORT}`);
    console.log(`👂 Listening for GitHub events at /github-webhook`);
    console.log(`👂 Listening for Basecamp events at /basecamp-webhook`);
});
