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
exports.generateStandupSummary = generateStandupSummary;
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
// Initialize the OpenAI client to route through OpenRouter
const openai = new openai_1.default({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Standup Bot",
    }
});
async function generateStandupSummary(basecampData) {
    console.log("🧠 Sending data to OpenRouter...");
    try {
        const response = await openai.chat.completions.create({
            // 🔥 THE FIX: Use the auto-router to find ANY available free model!
            model: "openrouter/free",
            messages: [
                {
                    role: "system",
                    content: `You are an upbeat, highly organized engineering project manager. 
                    Your job is to read raw JSON event data from multiple Basecamp projects and write a combined daily standup summary for the team's Discord channel.
                    Ignore minor events like formatting changes or document tweaks.
                    Focus strictly on:
                    1. Tasks that were COMPLETED yesterday.
                    2. Tasks that are DUE today or were newly ASSIGNED.

                    Format the output in clean, readable Discord Markdown (using bolding and emojis). Group by Project.
                    Keep it concise and friendly. Do not include any introductory fluff or JSON blocks in your final output.`
                },
                {
                    role: "user",
                    content: JSON.stringify(basecampData)
                }
            ]
        });
        if (!response.choices[0].message.content) {
            throw new Error("OpenRouter returned an empty response.");
        }
        return response.choices[0].message.content;
    }
    catch (error) {
        console.error("\n❌ OPENROUTER API ERROR:");
        console.error(error.message || error);
        return "⚠️ *Standup bot failed to generate a summary due to an OpenRouter API error. Please check the server logs.*";
    }
}
