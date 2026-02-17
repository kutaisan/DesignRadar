import 'dotenv/config';

export interface Config {
    figma: {
        token: string;
        fileKeys: string[];
    };
    llm: {
        baseUrl: string;
        apiKey: string;
        model: string;
    };
    output: {
        mode: 'terminal' | 'mattermost';
        mattermostWebhookUrl?: string;
    };
    pollIntervalMinutes: number;
    dbPath: string;
}

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

export function loadConfig(): Config {
    return {
        figma: {
            token: requireEnv('FIGMA_TOKEN'),
            fileKeys: requireEnv('FIGMA_FILE_KEYS').split(',').map(k => k.trim()),
        },
        llm: {
            baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
            apiKey: requireEnv('LLM_API_KEY'),
            model: process.env.LLM_MODEL || 'gpt-4o-mini',
        },
        output: {
            mode: (process.env.OUTPUT_MODE as 'terminal' | 'mattermost') || 'terminal',
            mattermostWebhookUrl: process.env.MATTERMOST_WEBHOOK_URL,
        },
        pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
        dbPath: process.env.DB_PATH || './design-radar.db',
    };
}
