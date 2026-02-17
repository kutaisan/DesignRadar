/**
 * AI Changelog Generator
 * Modular LLM support: Gemini and OpenAI
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import type { DesignChange } from './differ.js';
import { formatChangesForLLM } from './differ.js';
import type { LLMProvider } from './config.js';

const SYSTEM_PROMPT = `Sen bir tasarım değişikliği analizcisisin. Sana bir Figma dosyasındaki tasarım değişiklikleri verilecek.

Görevin:
- Değişiklikleri developer'lar için anlaşılır, kısa ve öz bir changelog'a dönüştür
- Her değişikliği madde işareti ile listele
- Teknik detayları (hex renk kodları, piksel değerleri) insanların anlayacağı şekilde açıkla
- Önemsiz değişiklikleri (1-2 piksellik kaymalar) atla
- Türkçe yaz

Örnek giriş:
[Home Page]
  ~ Header / Login Button: fills: #3366E5 → #FF0000
  + Header / New Badge: "New Badge" (FRAME) added
  ~ Content / Hero Text: characters: "Hoşgeldiniz" → "Merhaba"

Örnek çıktı:
📋 **Home Page**
• 🎨 Login butonu rengi maviden kırmızıya değiştirildi
• ✨ Header'a yeni bir "New Badge" bileşeni eklendi
• ✏️ Ana sayfa karşılama metni "Merhaba" olarak güncellendi

Sadece changelog'u döndür, başka açıklama yapma.`;

// ─── Provider Interface ───

interface LLMClient {
    generate(userPrompt: string): Promise<string>;
}

// ─── Gemini Provider ───

class GeminiClient implements LLMClient {
    private model;

    constructor(apiKey: string, modelName: string) {
        const genAI = new GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: SYSTEM_PROMPT,
        });
    }

    async generate(userPrompt: string): Promise<string> {
        const result = await this.model.generateContent(userPrompt);
        return result.response.text();
    }
}

// ─── OpenAI Provider ───

class OpenAIClient implements LLMClient {
    private client: OpenAI;
    private model: string;

    constructor(apiKey: string, model: string) {
        this.client = new OpenAI({ apiKey });
        this.model = model;
    }

    async generate(userPrompt: string): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 1000,
        });
        return response.choices[0]?.message?.content?.trim() || '';
    }
}

// ─── Factory ───

function createLLMClient(provider: LLMProvider, apiKey: string, model: string): LLMClient {
    switch (provider) {
        case 'gemini':
            return new GeminiClient(apiKey, model);
        case 'openai':
            return new OpenAIClient(apiKey, model);
        default:
            throw new Error(`Unknown LLM provider: ${provider}`);
    }
}

// ─── Public API ───

export class AIChangelog {
    private client: LLMClient;
    private provider: LLMProvider;

    constructor(provider: LLMProvider, apiKey: string, model: string) {
        this.provider = provider;
        this.client = createLLMClient(provider, apiKey, model);
    }

    async generateChangelog(
        fileName: string,
        changes: DesignChange[]
    ): Promise<string> {
        if (changes.length === 0) return '';

        const diffText = formatChangesForLLM(changes);
        const userPrompt = `Dosya: "${fileName}"\n\nDeğişiklikler:\n${diffText}`;

        try {
            const result = await this.client.generate(userPrompt);
            return result || fallbackChangelog(fileName, changes);
        } catch (error) {
            console.error(`LLM error (${this.provider}), using fallback:`, error);
            return fallbackChangelog(fileName, changes);
        }
    }
}

// ─── Rule-based fallback if LLM fails ───

function fallbackChangelog(fileName: string, changes: DesignChange[]): string {
    const lines: string[] = [`📋 **${fileName}** — ${changes.length} değişiklik algılandı`];

    const byPage = new Map<string, DesignChange[]>();
    for (const c of changes) {
        const existing = byPage.get(c.page) || [];
        existing.push(c);
        byPage.set(c.page, existing);
    }

    for (const [page, pageChanges] of byPage) {
        if (byPage.size > 1) lines.push(`\n**${page}**`);
        for (const c of pageChanges.slice(0, 20)) {
            const icon = c.kind === 'ADDED' ? '✨' : c.kind === 'REMOVED' ? '🗑️' : '🔄';
            lines.push(`• ${icon} ${c.path}: ${c.summary}`);
        }
        if (pageChanges.length > 20) {
            lines.push(`  ...ve ${pageChanges.length - 20} değişiklik daha`);
        }
    }

    return lines.join('\n');
}
