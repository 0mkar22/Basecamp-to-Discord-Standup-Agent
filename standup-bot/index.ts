import * as dotenv from 'dotenv';
import { getModel, complete, Context } from '@mariozechner/pi-ai';

// Load environment variables from the .env file
dotenv.config();

// Helper function to handle Basecamp's strict header requirements
function getBasecampHeaders() {
    return {
        "Authorization": `Bearer ${process.env.BASECAMP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        // Basecamp STRICTLY requires a User-Agent with contact info, or they block the request.
        "User-Agent": "StandupBot/1.0 (your-email@yourcompany.com)" 
    };
}

async function fetchBasecampTasks() {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const projectId = process.env.BASECAMP_PROJECT_ID;

    if (!accountId || !projectId || !process.env.BASECAMP_ACCESS_TOKEN) {
        throw new Error("Missing Basecamp environment variables in .env file.");
    }

    // Basecamp 3 API URL structure
    const baseUrl = `https://3.basecampapi.com/${accountId}/buckets/${projectId}`;

    // Fetch the project's recent events (this includes completed tasks, new tasks, etc.)
    const response = await fetch(`${baseUrl}/events.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });

    if (!response.ok) {
        throw new Error(`Basecamp API Error: ${response.status} ${response.statusText}`);
    }

    const allEvents = await response.json();

    // Filter for events that happened in the last 24 hours
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const recentEvents = allEvents.filter((event: any) => {
        return new Date(event.created_at) >= yesterday;
    });

    console.log(`📥 Fetched ${recentEvents.length} events from the last 24 hours.`);
    
    // We return this raw data object so the AI can read it in Step 3
    return {
        report_date: new Date().toISOString(),
        events: recentEvents
    };
}

async function generateStandupSummary(basecampData: any) {
    // 1. Select the model. You can change this to 'anthropic' and 'claude-3-5-sonnet' if preferred!
    const model = getModel('google', 'gemini-2.5-flash');

    // 2. Build the context and instructions for the AI
    const context: Context = {
        systemPrompt: `You are an upbeat, highly organized engineering project manager. 
        Your job is to read raw JSON event data from Basecamp and write a daily standup summary for the team's Discord channel.
        Ignore minor events like formatting changes or document tweaks.
        Focus strictly on:
        1. Tasks that were COMPLETED yesterday.
        2. Tasks that are DUE today or were newly ASSIGNED.

        Format the output in clean, readable Discord Markdown (using bolding and emojis). 
        Keep it concise and friendly. Do not include any introductory fluff or JSON blocks in your final output.`,
        messages: [
            { 
                role: 'user', 
                content: `Here is the raw Basecamp data for the last 24 hours: \n\n${JSON.stringify(basecampData, null, 2)}`,
                timestamp: Date.now()
            }
        ]
    };

    // 3. Send the context to the model and await the complete response
    const response = await complete(model, context);

    // 4. Extract the generated text from the response blocks
    let summaryText = "";
    for (const block of response.content) {
        if (block.type === 'text') {
            summaryText += block.text;
        }
    }

    if (!summaryText) {
         throw new Error("The AI model returned an empty summary.");
    }

    console.log(`🧠 AI processing complete. Generated ${summaryText.length} characters of Markdown.`);
    return summaryText;
}

async function postToDiscord(summaryMarkdown: string) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
        throw new Error("Missing DISCORD_WEBHOOK_URL in .env file.");
    }

    // Discord expects a JSON payload with a "content" field
    const payload = {
        content: `**🌞 Good morning, team! Here is your daily standup:**\n\n${summaryMarkdown}`,
        // Optional: You can change the username and avatar of the bot here
        username: "Basecamp Standup Bot", 
        avatar_url: "https://i.imgur.com/8nLFCVP.png" // Replace with your company logo URL
    };

    console.log("📤 Sending summary to Discord...");

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
         throw new Error(`Discord API Error: ${response.status} ${response.statusText}`);
    }

    console.log("✅ Message successfully delivered to Discord!");
}

// Main execution function
async function main() {
    console.log("🚀 Starting Daily Standup Agent...");

    try {
        console.log("1️⃣ Fetching data from Basecamp...");
        const rawData = await fetchBasecampTasks();

        console.log("2️⃣ Processing data with AI...");
        const summary = await generateStandupSummary(rawData);

        console.log("3️⃣ Broadcasting to Discord...");
        await postToDiscord(summary);

        console.log("✅ Standup posted successfully!");
    } catch (error) {
        console.error("❌ Fatal Error in Standup Agent:", error);
        process.exit(1);
    }
}

// Execute the script
main();