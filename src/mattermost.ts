/**
 * Mattermost Notifier + Terminal Output
 * Posts changelog to Mattermost webhook or prints to terminal
 */

export interface NotifierConfig {
    mode: 'terminal' | 'mattermost';
    mattermostWebhookUrl?: string;
}

export class Notifier {
    private config: NotifierConfig;

    constructor(config: NotifierConfig) {
        this.config = config;
        if (config.mode === 'mattermost' && !config.mattermostWebhookUrl) {
            throw new Error('MATTERMOST_WEBHOOK_URL is required when OUTPUT_MODE=mattermost');
        }
    }

    async send(changelog: string, fileName: string): Promise<void> {
        if (!changelog || changelog.trim() === '') return;

        if (this.config.mode === 'terminal') {
            this.printToTerminal(changelog, fileName);
        } else {
            await this.postToMattermost(changelog, fileName);
        }
    }

    private printToTerminal(changelog: string, fileName: string): void {
        const divider = '═'.repeat(60);
        console.log(`\n${divider}`);
        console.log(`🎯 DesignRadar — ${fileName}`);
        console.log(`📅 ${new Date().toLocaleString('tr-TR')}`);
        console.log(divider);
        console.log(changelog);
        console.log(`${divider}\n`);
    }

    private async postToMattermost(changelog: string, fileName: string): Promise<void> {
        const message = `### 🎯 DesignRadar — ${fileName}\n_${new Date().toLocaleString('tr-TR')}_\n\n${changelog}`;

        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(this.config.mattermostWebhookUrl!, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: message,
                        username: 'DesignRadar',
                        icon_emoji: ':art:',
                    }),
                });

                if (res.ok) {
                    console.log(`✅ Mattermost'a gönderildi: ${fileName}`);
                    return;
                }

                console.error(`Mattermost error (attempt ${attempt}): ${res.status} ${await res.text()}`);
            } catch (error) {
                console.error(`Mattermost connection error (attempt ${attempt}):`, error);
            }

            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }

        // Fallback: print to terminal if Mattermost fails
        console.warn('⚠️ Mattermost\'a gönderilemedi, terminal\'e yazdırılıyor:');
        this.printToTerminal(changelog, fileName);
    }
}
