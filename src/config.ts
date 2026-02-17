import 'dotenv/config';

export type LLMProvider = 'gemini' | 'openai';

export interface Config {
    figma: {
        token: string;
        fileKeys: string[];
    };
    llm: {
        provider: LLMProvider;
        apiKey: string;
        model: string;
    };
    output: {
        mode: 'terminal' | 'mattermost';
        mattermostWebhookUrl?: string;
    };
    pollIntervalMinutes: number;
    dbPath: string;
    webhookPasscode?: string;
}

function requireEnv(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

function resolveProvider(): LLMProvider {
    const explicit = process.env.LLM_PROVIDER?.toLowerCase();
    if (explicit === 'gemini' || explicit === 'openai') return explicit;
    // Auto-detect from available keys
    if (process.env.GEMINI_API_KEY) return 'gemini';
    if (process.env.OPENAI_API_KEY) return 'openai';
    throw new Error('Set LLM_PROVIDER=gemini|openai or provide GEMINI_API_KEY / OPENAI_API_KEY');
}

const PROVIDER_DEFAULTS: Record<LLMProvider, { model: string }> = {
    gemini: { model: 'gemini-2.0-flash' },
    openai: { model: 'gpt-4o-mini' },
};

export function loadConfig(): Config {
    const provider = resolveProvider();
    const apiKey = provider === 'gemini'
        ? requireEnv('GEMINI_API_KEY')
        : requireEnv('OPENAI_API_KEY');

    return {
        figma: {
            token: requireEnv('FIGMA_TOKEN'),
            fileKeys: requireEnv('FIGMA_FILE_KEYS').split(',').map(k => k.trim()),
        },
        llm: {
            provider,
            apiKey,
            model: process.env.LLM_MODEL || PROVIDER_DEFAULTS[provider].model,
        },
        output: {
            mode: (process.env.OUTPUT_MODE as 'terminal' | 'mattermost') || 'terminal',
            mattermostWebhookUrl: process.env.MATTERMOST_WEBHOOK_URL,
        },
        pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
        dbPath: process.env.DB_PATH || './design-radar.db',
        webhookPasscode: process.env.WEBHOOK_PASSCODE,
    };
}
