// Телеграм-бот Team Vanity: статистика игроков с FACEIT.
// Работает на Cloudflare Workers. Переменные окружения (Settings → Variables and Secrets):
//   BOT_TOKEN       — токен от @BotFather
//   FACEIT_KEY      — серверный API-ключ FACEIT (Server-side)
//   WEBHOOK_SECRET  — любая придуманная строка из латинских букв и цифр
//   TEAM_ID         — необязательно, по умолчанию Team Vanity

const DEFAULT_TEAM_ID = "75436928-a806-406b-840e-5fdae1a7b202";
const FACEIT = "https://open.faceit.com/data/v4";
const CACHE_SECONDS = 600; // данные FACEIT кэшируются на 10 минут
const VERSION = "1.7 · 15 октября";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Одноразовая настройка: открыть в браузере /setup?secret=WEBHOOK_SECRET
    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("Неверный secret", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "start", description: "Выбрать игрока" },
          { command: "team", description: "Сводка по всей команде" },
          { command: "help", description: "Что умеет бот" }
        ]
      });
      return new Response(hook.ok ? "Готово! Бот подключён. Напишите ему /start в Телеграме." : "Ошибка: " + JSON.stringify(hook), {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    // Диагностика: /status?secret=WEBHOOK_SECRET
    if (url.pathname === "/status") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("Неверный secret", { status: 403 });
      const info = await tg(env, "getWebhookInfo", {});
      let faceitCheck;
      try { const t = await faceit(env, `/teams/${env.TEAM_ID || DEFAULT_TEAM_ID}`); faceitCheck = `ок, команда «${t.name}», игроков: ${(t.members || []).length}`; }
      catch (e) { faceitCheck = e.message; }
      const lines = [
        `BOT_TOKEN: ${env.BOT_TOKEN ? "есть" : "НЕТ"}`,
        `FACEIT_KEY: ${env.FACEIT_KEY ? "есть" : "НЕТ"}`,
        `WEBHOOK_SECRET: ${env.WEBHOOK_SECRET ? "есть" : "НЕТ"}`,
        `Телеграм: ${info.ok ? "токен рабочий" : "ошибка " + info.description}`,
        `Вебхук: ${info.result?.url || "не установлен"}`,
        `Версия бота: ${VERSION}`,
        `Сообщений в очереди: ${info.result?.pending_update_count ?? "?"}`,
        `Последняя ошибка доставки: ${info.result?.last_error_message || "нет"}`,
        `FACEIT: ${faceitCheck}`
      ];
      return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      // Отвечаем Телеграму сразу, работу доделываем в фоне
      ctx.waitUntil(handle(update, env).catch(async e => {
        console.error(e);
        const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        if (chat) await tg(env, "sendMessage", { chat_id: chat, text: "⚠️ Ошибка: " + e.message });
      }));
      return new Response("ok");
    }

    return new Response("Team Vanity bot работает", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

// ---------- обработка сообщений ----------
async function handle(update, env) {
  if (update.message?.text) {
    const chat = update.message.chat.id;
    const cmd = update.message.text.split(/[\s@]/)[0];
    if (cmd === "/team") return sendTeam(env, chat);
    if (cmd === "/help") return sendHelp(env, chat);
    return sendMenu(env, chat); // /start и любое другое сообщение
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const chat = q.message.chat.id, msg = q.message.message_id;
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    if (q.data === "menu") return sendMenu(env, chat, msg);
    if (q.data === "team") return sendTeam(env, chat, msg);
    if (q.data === "help") return sendHelp(env, chat, msg);
    if (q.data.startsWith("p:")) return sendPlayer(env, chat, q.data.slice(2), msg);
    if (q.data.startsWith("m:")) {
      const [, id, off] = q.data.split(":");
      return sendMatches(env, chat, id, Number(off) || 0, msg);
    }
  }
}

async function getTeam(env) {
  return faceit(env, `/teams/${env.TEAM_ID || DEFAULT_TEAM_ID}`);
}

async function sendMenu(env, chat, editId) {
  const team = await getTeam(env);
  const members = team.members || [];
  const rows = [];
  for (let i = 0; i < members.length; i += 2) {
    rows.push(members.slice(i, i + 2).map(m => ({ text: m.nickname, callback_data: "p:" + m.user_id })));
  }
  rows.push([{ text: "📊 Вся команда", callback_data: "team" }, { text: "❓ Помощь", callback_data: "help" }]);
  const text = `<b>${esc(team.name || team.nickname || "Team Vanity")}</b>\nВыберите игрока, чтобы посмотреть его статистику на FACEIT.\n\n<i>Версия бота ${VERSION}</i>`;
  return reply(env, chat, text, rows, editId);
}

async function sendPlayer(env, chat, playerId, editId) {
  const [p, s, recent] = await Promise.all([
    faceit(env, `/players/${playerId}`),
    faceit(env, `/players/${playerId}/stats/cs2`).catch(() => null),
    faceit(env, `/players/${playerId}/games/cs2/stats?limit=${FORM_WINDOW}`).catch(() => null)
  ]);
  const text = playerCard(p, s, recent);
  const keyboard = [
    [{ text: "📋 Последние матчи", callback_data: `m:${playerId}:0` }],
    [{ text: "Профиль на FACEIT ↗", url: `https://www.faceit.com/ru/players/${encodeURIComponent(p.nickname)}` }],
    [{ text: "← Ко всем игрокам", callback_data: "menu" }]
  ];
  return reply(env, chat, text, keyboard, editId, p.avatar || null);
}

// ---------- статистика по каждому матчу ----------
const PAGE = 10;

async function sendMatches(env, chat, playerId, offset, editId) {
  const [p, res] = await Promise.all([
    faceit(env, `/players/${playerId}`),
    faceit(env, `/players/${playerId}/games/cs2/stats?limit=${PAGE}&offset=${offset}`).catch(() => null)
  ]);
  const items = (res?.items || []).slice(0, PAGE).map(i => i.stats || {});
  const out = [`<b>${esc(p.nickname)}</b> · матчи ${offset + 1}–${offset + items.length}`];

  if (!items.length) {
    out.push("", offset ? "Больше матчей нет." : "FACEIT не отдал статистику по матчам этого игрока.");
  }

  for (const s of items) {
    const n = k => (s[k] != null && s[k] !== "" ? Number(s[k]) : null);
    const win = String(s["Result"]) === "1";
    const kills = n("Kills"), deaths = n("Deaths"), assists = n("Assists");
    const kd = n("K/D Ratio") ?? (kills != null && deaths ? kills / deaths : null);
    const adr = n("ADR"), hs = n("Headshots %");
    const when = matchDate(s);
    const map = s["Map"] ? s["Map"].replace(/^de_/, "").replace(/^./, c => c.toUpperCase()) : "Карта ?";
    const score = s["Score"] ? String(s["Score"]).replace(/\s*\/\s*/, ":") : "";
    const id = s["Match Id"];

    const head = `${win ? "🟢" : "🔴"} <b>${esc(map)}</b>${score ? " " + esc(score) : ""}${when ? " · " + when : ""}`;
    const kda = kills != null ? `${kills}/${deaths ?? "?"}/${assists ?? "?"}` : "—";
    const parts = [
      `K/D/A ${kda}`,
      kd != null && `K/D ${kd.toFixed(2)}`,
      adr != null && `ADR ${adr.toFixed(0)}`,
      hs != null && `HS ${hs.toFixed(0)}%`
    ].filter(Boolean);
    const extra = [
      n("Penta Kills") > 0 && `эйсов: ${n("Penta Kills")}`,
      n("Quadro Kills") > 0 && `4k: ${n("Quadro Kills")}`,
      n("MVPs") > 0 && `MVP: ${n("MVPs")}`
    ].filter(Boolean);

    out.push("");
    out.push(id ? `<a href="https://www.faceit.com/ru/cs2/room/${encodeURIComponent(id)}">${head}</a>` : head);
    out.push("    " + parts.join(" · "));
    if (extra.length) out.push("    " + extra.join(" · "));
  }

  const nav = [];
  if (offset > 0) nav.push({ text: "← Новее", callback_data: `m:${playerId}:${Math.max(0, offset - PAGE)}` });
  if (items.length === PAGE) nav.push({ text: "Старее →", callback_data: `m:${playerId}:${offset + PAGE}` });
  const keyboard = [];
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "← К игроку", callback_data: `p:${playerId}` }]);
  return reply(env, chat, out.join("\n"), keyboard, editId);
}

function matchDate(s) {
  const raw = s["Match Finished At"] ?? s["Updated At"] ?? s["Created At"];
  if (raw == null) return "";
  const d = /^\d+$/.test(String(raw)) ? new Date(Number(raw)) : new Date(raw);
  if (isNaN(d)) return "";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

async function sendTeam(env, chat, editId) {
  const team = await getTeam(env);
  const members = team.members || [];
  const data = await Promise.all(members.map(async m => {
    const [p, s] = await Promise.all([
      faceit(env, `/players/${m.user_id}`).catch(() => null),
      faceit(env, `/players/${m.user_id}/stats/cs2`).catch(() => null)
    ]);
    const cs = p?.games?.cs2 || {};
    const lt = s?.lifetime || {};
    return {
      nick: m.nickname,
      country: p?.country,
      level: cs.skill_level,
      elo: Number(cs.faceit_elo) || 0,
      kd: lt["Average K/D Ratio"],
      wr: lt["Win Rate %"]
    };
  }));
  data.sort((a, b) => b.elo - a.elo);

  const lines = data.map((d, i) =>
    `${i + 1}. ${flag(d.country)} <b>${esc(d.nick)}</b>\n` +
    `    ${d.level ? `ур. ${d.level} · ` : ""}${d.elo || "—"} ELO · K/D ${d.kd ?? "—"} · победы ${d.wr != null ? d.wr + "%" : "—"}`
  );
  const avg = data.filter(d => d.elo).reduce((s, d, _, a) => s + d.elo / a.length, 0);
  const text =
    `<b>📊 ${esc(team.name || "Team Vanity")}</b>\n` +
    (avg ? `Средний ELO: <b>${Math.round(avg)}</b>\n` : "") +
    `\n${lines.join("\n\n")}`;
  return reply(env, chat, text, [[{ text: "← Ко всем игрокам", callback_data: "menu" }]], editId);
}

async function sendHelp(env, chat, editId) {
  const text = [
    "<b>Что умеет бот</b>",
    "",
    "/start — список игроков Team Vanity",
    "/team — сводка по всей команде, по убыванию ELO",
    "/help — эта подсказка",
    "",
    "<b>В карточке игрока</b>",
    "• уровень и ELO на FACEIT",
    "• статистика за всё время и форма за 30 матчей",
    "• 🎯 сколько убийств нужно в следующей игре, чтобы удержать или поднять среднее",
    "• 📋 Последние матчи — K/D/A, ADR и HS% в каждом матче",
    "",
    "Данные FACEIT обновляются раз в 10 минут.",
    `<i>Версия ${VERSION}</i>`
  ].join("\n");
  return reply(env, chat, text, [[{ text: "← Ко всем игрокам", callback_data: "menu" }]], editId);
}

// ---------- карточка игрока ----------
function playerCard(p, s, recent) {
  const cs = p.games?.cs2 || {};
  const lt = s?.lifetime || {};
  const out = [];

  out.push(`${flag(p.country)} <b>${esc(p.nickname)}</b>`);
  if (cs.skill_level || cs.faceit_elo) {
    out.push(`${levelBadge(cs.skill_level)} Уровень ${cs.skill_level ?? "—"} · <b>${cs.faceit_elo ?? "—"}</b> ELO`);
  }

  if (s) {
    out.push("");
    out.push("<b>За всё время</b>");
    out.push(`Матчей: ${lt["Matches"] ?? "—"} · Побед: ${lt["Win Rate %"] != null ? lt["Win Rate %"] + "%" : "—"}`);
    const line2 = [
      lt["Average K/D Ratio"] != null && `K/D: ${lt["Average K/D Ratio"]}`,
      lt["Average Headshots %"] != null && `HS: ${lt["Average Headshots %"]}%`,
      lt["ADR"] != null && `ADR: ${lt["ADR"]}`
    ].filter(Boolean);
    if (line2.length) out.push(line2.join(" · "));
    if (lt["Longest Win Streak"] != null) out.push(`Лучшая серия: ${lt["Longest Win Streak"]} побед подряд`);
    if (Array.isArray(lt["Recent Results"]) && lt["Recent Results"].length) {
      out.push(`Последние: ${lt["Recent Results"].map(r => (String(r) === "1" ? "🟢" : "🔴")).join("")}`);
    }
  } else {
    out.push("", "Статистика CS2 на FACEIT пока недоступна.");
  }

  // Форма за последние 30 матчей, если FACEIT отдал детали
  const items = (recent?.items || []).map(i => i.stats || {}).filter(x => x["Kills"] != null);
  if (items.length >= 3) {
    const num = k => items.map(x => Number(x[k])).filter(n => !isNaN(n));
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const kills = num("Kills"), deaths = num("Deaths"), adr = num("ADR"), hs = num("Headshots %");
    const wins = items.filter(x => String(x["Result"]) === "1").length;
    const kd = deaths.length ? kills.reduce((a, b) => a + b, 0) / Math.max(1, deaths.reduce((a, b) => a + b, 0)) : null;
    out.push("");
    out.push(`<b>Форма: последние ${items.length} матчей</b>`);
    out.push(`Побед: ${Math.round(wins / items.length * 100)}% · K/D: ${kd != null ? kd.toFixed(2) : "—"}`);
    const extra = [
      avg(kills) != null && `Avg kills: <b>${Math.round(avg(kills))}</b>`,
      avg(adr) != null && `ADR: ${avg(adr).toFixed(0)}`,
      avg(hs) != null && `HS: ${avg(hs).toFixed(0)}%`
    ].filter(Boolean);
    if (extra.length) out.push(extra.join(" · "));

    const maps = {};
    for (const x of items) if (x["Map"]) maps[x["Map"]] = (maps[x["Map"]] || 0) + 1;
    const top = Object.entries(maps).sort((a, b) => b[1] - a[1])[0];
    if (top) out.push(`Чаще всего играет: ${esc(top[0].replace(/^de_/, "").replace(/^./, c => c.toUpperCase()))} (${top[1]})`);

    const goal = killsGoal(items.map(x => Number(x["Kills"]) || 0));
    if (goal) {
      out.push("");
      out.push("<b>🎯 Цель на следующую игру</b>");
      out.push(`Удержать avg ${goal.shown}: <b>${goal.keep}+</b> убийств`);
      out.push(`Поднять avg до ${goal.upShown}: <b>${goal.up}+</b> убийств`);
      if (goal.drop != null) out.push(`<i>Из окна ${FORM_WINDOW} матчей выпадет игра с ${goal.drop} убийствами</i>`);
    }
  }

  return out.join("\n");
}

// Сколько убийств нужно в следующей игре, чтобы среднее за окно не упало и чтобы выросло.
// Матчи идут от новых к старым. Если окно заполнено, самый старый матч выпадает.
const FORM_WINDOW = 30;
export function killsGoal(kills) {
  if (kills.length < 3) return null;
  const win = kills.slice(0, FORM_WINDOW);
  const full = win.length === FORM_WINDOW;
  const drop = full ? win[win.length - 1] : null;
  const rest = win.reduce((a, b) => a + b, 0) - (drop ?? 0); // что останется в окне
  const n = full ? FORM_WINDOW : win.length + 1;            // размер окна после игры
  const avg = win.reduce((a, b) => a + b, 0) / win.length;
  const shown = Math.round(avg);                            // среднее округляется до целого: 19.4 → 19, 19.6 → 20
  // минимум убийств, чтобы округлённое среднее стало не меньше target
  const need = target => Math.max(0, Math.ceil((target - 0.5) * n - rest - 1e-9));
  const keep = need(shown);
  const upShown = shown + 1;
  const up = need(upShown);
  return { shown, keep, up, upShown, drop };
}

const levelBadge = lvl => (lvl >= 10 ? "🔴" : lvl >= 8 ? "🟠" : lvl >= 4 ? "🟡" : lvl >= 2 ? "🟢" : "⚪");

function flag(code) {
  if (!code || code.length !== 2) return "🏳️";
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- API ----------
async function faceit(env, path) {
  const url = FACEIT + path;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.FACEIT_KEY}` } });
  if (!r.ok) {
    const hint = r.status === 401 || r.status === 403
      ? " — ключ FACEIT не подошёл: проверьте FACEIT_KEY (нужен тип Server-side)"
      : r.status === 404 ? " — не найдено на FACEIT (проверьте TEAM_ID)" : "";
    throw new Error(`FACEIT ответил ${r.status}${hint}`);
  }
  const body = await r.text();
  if (cache) {
    await cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` } }));
  }
  return JSON.parse(body);
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json();
}

// image — ссылка на картинку: Телеграм покажет её над текстом как превью ссылки,
// поэтому сообщение остаётся текстовым и его можно редактировать кнопками.
async function reply(env, chat, text, keyboard, editId, image) {
  const payload = {
    chat_id: chat, text, parse_mode: "HTML",
    link_preview_options: image
      ? { url: image, show_above_text: true, prefer_large_media: true }
      : { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard }
  };
  if (editId) {
    const res = await tg(env, "editMessageText", { ...payload, message_id: editId });
    if (res.ok || String(res.description || "").includes("not modified")) return res;
  }
  return tg(env, "sendMessage", payload);
}
