// adapters/jira.ts
import { PMAdapter } from './PMAdapter';

// Notice how it "implements PMAdapter". TypeScript will throw an error if we miss a function!
export const JiraAdapter: PMAdapter = {

    async fetchWeeklyCompletedTasks(projectId: string): Promise<any[]> {
        console.log(`[JIRA] Fetching 7-day completed tasks...`);
        return []; // Dummy return for now
    },

    async searchProject(projectName: string): Promise<string | null> {
        console.log(`[JIRA] Searching for project: ${projectName}`);
        // TODO: Add Jira API fetch logic here
        return "JIRA_PROJECT_123"; 
    },

    async completeTask(projectId: string, taskId: string): Promise<boolean> {
        console.log(`[JIRA] Transitioning issue ${taskId} to 'Done'`);
        // TODO: Add Jira Issue Transition API here
        return true;
    },

    async uncompleteTask(projectId: string, taskId: string): Promise<boolean> {
        console.log(`[JIRA] Transitioning issue ${taskId} back to 'In Progress'`);
        // TODO: Add Jira API logic here
        return true;
    },

    async syncCommit(projectName: string, commitMessage: string, developerName: string): Promise<string> {
        console.log(`[JIRA] Adding commit comment to Jira Project...`);
        // TODO: Add Jira API logic here
        return "Success";
    },

    async postPRSummary(projectName: string, prTitle: string, developerName: string, summary: string, prUrl: string): Promise<boolean> {
        console.log(`[JIRA] Posting PR Summary to Jira board...`);
        // TODO: Add Jira API logic here
        return true;
    }
};