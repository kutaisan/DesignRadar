/**
 * Webhook Registration CLI
 * Usage: npm run webhook:register <team_id> <public_url>
 */

import 'dotenv/config';
import { loadConfig } from './config.js';
import { WebhookServer } from './webhook-server.js';

const args = process.argv.slice(2);

if (args.length < 2) {
    console.log('Kullanım: npm run webhook:register <TEAM_ID> <PUBLIC_URL>');
    console.log('Örnek:    npm run webhook:register 123456789 https://abc123.ngrok.io');
    console.log('\nTeam ID\'nizi bulmak için: Figma → Team sayfası → URL\'deki sayı');
    process.exit(1);
}

const [teamId, publicUrl] = args;

const config = loadConfig();
const server = new WebhookServer(config);

try {
    // First, list existing webhooks
    console.log(`\n📋 Mevcut webhook'lar kontrol ediliyor...`);
    const existing = await server.listWebhooks(teamId);

    const drWebhooks = existing.filter((w: any) =>
        w.description?.includes('DesignRadar') || w.endpoint?.includes(publicUrl)
    );

    if (drWebhooks.length > 0) {
        console.log(`   ⚠️  ${drWebhooks.length} eski DesignRadar webhook'u bulundu, siliniyor...`);
        for (const w of drWebhooks) {
            await server.deleteWebhook(w.id);
        }
    }

    // Register new webhook
    await server.registerWebhook(teamId, publicUrl);

    console.log(`\n✅ Webhook hazır! Şimdi webhook server'ı çalıştırın:`);
    console.log(`   npm run webhook\n`);
} catch (err) {
    console.error('❌ Hata:', err);
    process.exit(1);
}
