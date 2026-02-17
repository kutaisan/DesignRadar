/**
 * DesignRadar — Webhook Mode Entry Point
 * 
 * Usage:
 *   1. Start: npm run webhook
 *   2. In another terminal: ngrok http 3100
 *   3. Copy ngrok URL and run: npm run webhook:register <team_id> <ngrok_url>
 *   4. Make changes in Figma → changelog appears automatically!
 */

import 'dotenv/config';
import { loadConfig } from './config.js';
import { WebhookServer } from './webhook-server.js';

const config = loadConfig();
const server = new WebhookServer(config);

// Handle shutdown gracefully
process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
});

const port = parseInt(process.env.WEBHOOK_PORT || '3100', 10);
await server.start(port);

// If FIGMA_TEAM_ID and WEBHOOK_URL are set, auto-register
const teamId = process.env.FIGMA_TEAM_ID;
const webhookUrl = process.env.WEBHOOK_URL;

if (teamId && webhookUrl) {
    try {
        await server.registerWebhook(teamId, webhookUrl);
    } catch (err) {
        console.error('❌ Otomatik webhook kaydı başarısız:', err);
        console.log('   Manuel kayıt: npm run webhook:register <team_id> <url>');
    }
} else {
    console.log(`📌 Webhook kaydetmek için:`);
    console.log(`   1. Başka bir terminalde: ngrok http ${port}`);
    console.log(`   2. npm run webhook:register <TEAM_ID> <NGROK_URL>`);
    console.log(`   Veya .env'e FIGMA_TEAM_ID ve WEBHOOK_URL ekleyin.\n`);
}
