// Optional alert delivery to a Discord webhook and/or a Telegram bot. Secrets come only from the environment.
const DISCORD = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]{20,200}$/;
const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const HOURLY_LIMIT = 30;

export function notifierConfig(env) {
  const discord = env.DISCORD_WEBHOOK_URL || '';
  const token = env.TELEGRAM_BOT_TOKEN || '', chat = env.TELEGRAM_CHAT_ID || '';
  if (discord && !DISCORD.test(discord)) throw new Error('DISCORD_WEBHOOK_URL musí být https://discord.com/api/webhooks/… adresa.');
  if (!!token !== !!chat) throw new Error('Telegram vyžaduje TELEGRAM_BOT_TOKEN i TELEGRAM_CHAT_ID.');
  if (token && !TELEGRAM_TOKEN.test(token)) throw new Error('Neplatný TELEGRAM_BOT_TOKEN.');
  if (chat && !TELEGRAM_CHAT.test(chat)) throw new Error('Neplatný TELEGRAM_CHAT_ID.');
  return { discordWebhook: discord, telegramToken: token, telegramChat: chat };
}

export class Notifier {
  constructor(config = {}, request = fetch, log = () => {}) {
    this.config = config; this.request = request; this.log = log; this.sent = [];
  }
  status() { return { discord: !!this.config.discordWebhook, telegram: !!this.config.telegramToken }; }
  configured() { const s = this.status(); return s.discord || s.telegram; }
  // Never throws; failures are logged without the webhook address or bot token.
  async send(text) {
    if (!this.configured()) return 0;
    const now = Date.now();
    this.sent = this.sent.filter(t => now - t < 3_600_000);
    if (this.sent.length >= HOURLY_LIMIT) return 0;
    this.sent.push(now);
    const message = String(text).slice(0, 1800);
    const targets = [];
    if (this.config.discordWebhook) targets.push(['Discord', this.config.discordWebhook, { content: message, allowed_mentions: { parse: [] } }]);
    if (this.config.telegramToken) targets.push(['Telegram', `https://api.telegram.org/bot${this.config.telegramToken}/sendMessage`, { chat_id: this.config.telegramChat, text: message, disable_web_page_preview: true }]);
    let delivered = 0;
    for (const [name, url, body] of targets) {
      try {
        const response = await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (response.ok) delivered++; else this.log(`${name} upozornění selhalo: HTTP ${response.status}.`);
      } catch { this.log(`${name} upozornění se nepodařilo odeslat.`); }
    }
    return delivered;
  }
}
