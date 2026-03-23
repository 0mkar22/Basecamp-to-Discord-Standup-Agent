// This interface forces every new PM tool to have these exact functions!
export interface PMAdapter {
    searchProject(projectName: string): Promise<string | null>;
    completeTask(projectId: string, taskId: string, isRetry?: boolean): Promise<boolean>;
    uncompleteTask(projectId: string, taskId: string, isRetry?: boolean): Promise<boolean>;
    syncCommit(projectName: string, commitMessage: string, developerName: string, isRetry?: boolean): Promise<string>;
    postPRSummary(projectName: string, prTitle: string, developerName: string, summary: string, prUrl: string, isRetry?: boolean): Promise<boolean>;
    fetchWeeklyCompletedTasks(projectId: string, isRetry?: boolean): Promise<any[]>;
}