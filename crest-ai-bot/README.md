# Crest AI — a personal Telegram assistant bot

A single-file Python Telegram bot (stdlib only, no dependencies) that works as a
personal crypto + daily-life assistant. It answers in Indonesian, remembers the
last 20 messages for context, and is locked to one owner.

Built by Mohamad Ikhsan (@xenon-d62). Live since 2026-11-15 as
[@crest_ai_simple_bot](https://t.me/crest_ai_simple_bot).

## What it does

29 commands, grouped by what they answer:

- **Crypto prices & markets** — `/harga <coin>` (any CoinGecko coin, with a
  search fallback and symbol aliases), `/analisa <coin>`, `/rsi <coin>`
  (RSI-14 Wilder + MA7/MA30), `/chart <coin>` (7-day chart image),
  `/convert <amount> <coin> <currency>`, `/top`, `/gainers`, `/trending`,
  `/fear` (Fear & Greed index), `/dominance`, `/gas` (ETH + BSC gas in Gwei)
- **Wallet (read-only)** — `/saldo <address>` (native ETH/BSC balance plus
  USDT/USDC), `/tx <hash>` (transaction lookup)
- **Portfolio & alerts** — `/tambah` / `/kurang` / `/portofolio` (local
  holdings, stored as JSON), `/alert` / `/alerts` / `/hapus_alert` (price
  alerts, checked every 10 minutes by `check-alerts.py`)
- **Daily life** — `/cuaca <city>` (weather), `/kurs` (USD/IDR), `/waktu`
  (time in any timezone), `/berita` (crypto news), math expressions
- **Notes & memory** — `/inget` / `/catatan` / `/hapus` (local notes)
- **Free-form chat** — any other message goes to Gemini
  (`gemini-flash-lite-latest`) with the last-20-messages history; the system
  prompt forbids the bot from promising code changes

## Safety boundary (by design)

The bot **never holds private keys or seed phrases, never signs anything, and
never executes trades**. Wallet features are read-only balance/transaction
lookups. Trade execution stays with a human (or a separate agent under
per-order approval). This is a deliberate, standing rule — not a missing
feature.

## How it runs

```
python3 bot.py            # long-polling, stdlib only
bash watchdog.sh          # restarts it only if it is not running (cron, 5 min)
python3 check-alerts.py   # price-alert checker (cron, 10 min)
python3 set_menu.py       # sets the 29-command menu on all 4 Telegram scopes
```

- `config.json` (mode 600, never committed) holds `telegram_token` and
  `owner_id`. Only the first `/start` sender becomes the owner; everyone else
  is ignored.
- Optional: a Gemini API key (`~/workspace/gemini/credentials.json`) enables
  free-form chat; a make.fun API key (`~/workspace/makefun/credentials.json`)
  enables `/rank`. The bot works without both.
- `notes.json`, `portfolio.json`, `alerts.json`, `history.json` are local
  runtime state (all mode 600).

## Reliability notes

- One instance only. A second long-poll consumer causes Telegram HTTP 409
  `getUpdates` conflicts — the watchdog kills by verified PID, waits 35 s,
  then starts exactly one instance.
- The command menu must be set on all four scopes (default, all private
  chats, all group chats, all chat administrators); the default scope omits
  the `scope` key entirely (an empty object returns HTTP 400).
- The `/harga` resolver tries exact-symbol match first, then CoinGecko
  `/search` — so `pol`, `polygon`, and `matic` all resolve correctly.

## Files

| File | Purpose |
|---|---|
| `bot.py` | The bot: polling, commands, skills, Gemini chat |
| `check-alerts.py` | Price-alert checker (sends the message itself when an alert fires) |
| `set_menu.py` | Sets the command menu on all scopes |
| `watchdog.sh` | Single-instance restart guard |
| `config.example.json` | Template for `config.json` |
