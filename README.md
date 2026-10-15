# Vanity bot

Телеграм-бот Team Vanity: статистика игроков с FACEIT. Работает на Cloudflare Workers.

Секреты в Cloudflare (Settings → Variables and Secrets): `BOT_TOKEN`, `FACEIT_KEY`, `WEBHOOK_SECRET`.
После деплоя открыть `https://<адрес воркера>/setup?secret=<WEBHOOK_SECRET>`.
