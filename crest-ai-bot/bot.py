#!/usr/bin/env python3
"""Crest AI — personal Telegram assistant.
Free-form chat runs on the Gemini API (free tier, key in
~/workspace/gemini/credentials.json); the skills below still work.
Stdlib only. Long-polling via the Telegram Bot API.

Skills (all free APIs, no extra keys except the make.fun key already on disk):
- /harga <coin> — live crypto price in USD + IDR (CoinGecko).
- /analisa <coin> — price, 24h/7d/30d change, volume, market cap, ATH/ATL + Fear & Greed.
- /top — top 10 coins by market cap.
- /gainers — top 5 gainers + top 5 losers (24h).
- /rsi <coin> — RSI-14 + MA7/MA30 from 30-day prices.
- /chart <coin> — 7-day price chart image (QuickChart).
- /tambah <coin> <jumlah> / /kurang <coin> <jumlah> / /portofolio — local holdings tracker.
- /alert <coin> <harga> [atas|bawah] — price alert (checked every 10 min by cron).
- /alerts — list active alerts; /hapus_alert <no> — delete one.
- /trending — top 7 trending coins (CoinGecko).
- /fear — Fear & Greed Index.
- /dominance — BTC dominance + total market cap.
- /convert <jumlah> <dari> <ke> — convert crypto/fiat, misal /convert 1 btc idr.
- /saldo <0x-address> — READ-ONLY wallet balances (ETH + BSC native + USDT/USDC).
- /tx <hash> — transaction status on ETH/BSC.
- /berita — top 5 crypto headlines (Google News RSS).
- /cuaca <kota> — current weather (Open-Meteo).
- /kurs — USD/IDR + major rates.
- /gas — ETH + BSC gas price in Gwei (public RPCs, no key).
- /rank — make.fun ranks + earnings summary.
- /inget <teks> — save a note; /catatan — list notes; /hapus <no> — delete one.
- /waktu — current time/date (WIB).
- Math: send an expression like 12*15 or 100+250 and it computes it.
- Commands: /start, /help, /baru (clear conversation history).

The bot NEVER holds private keys or seed phrases, never signs, and never
executes trades. Wallet features are read-only (public address lookup only).

Owner lock: the first user who sends /start becomes the owner; after that
only the owner gets answers. Config in config.json (mode 600). The
make.fun API key is read from ~/workspace/makefun/credentials.json.
"""
import json
import math
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
HISTORY_PATH = os.path.join(BASE, "history.json")
NOTES_PATH = os.path.join(BASE, "notes.json")
PORTFOLIO_PATH = os.path.join(BASE, "portfolio.json")
ALERTS_PATH = os.path.join(BASE, "alerts.json")
MAKEFUN_CREDS = os.path.expanduser("~/workspace/makefun/credentials.json")
GEMINI_CREDS = os.path.expanduser("~/workspace/gemini/credentials.json")
GEMINI_MODEL = "gemini-flash-lite-latest"
GEMINI_TIMEOUT = 120
POLL_TIMEOUT = 30
MAX_HISTORY = 20
WIB = timezone(timedelta(hours=7))

SYSTEM_PROMPT = (
    "You are Crest AI, a helpful personal assistant. Answer in the same "
    "language the user writes in (Bahasa Indonesia by default). Keep answers "
    "SHORT: at most 2-3 short sentences, plain text only. No markdown, no "
    "bold, no bullet lists, no headings, no long explanations. Only give a "
    "long or detailed answer if the user explicitly asks for detail. You "
    "remember the conversation so far; use that context when it is relevant. "
    "You CANNOT change your own code, add features, or integrate new services "
    "yourself. If the user asks for a new feature or a fix, do NOT promise to "
    "do it yourself; say you will pass the request to your owner instead."
)

WELCOME = (
    "Halo, gue Crest AI, asisten pribadi lo.\n\n"
    "Tanya apa aja, gue jawab. Gue inget obrolan kita, jadi lo bisa lanjut "
    "ngobrol tanpa ulang dari awal.\n\n"
    "Skill gue:\n"
    "/harga <coin> - harga crypto live (USD + Rp)\n"
    "/analisa <coin> - analisa market: harga, 24j/7h, volume, ATH\n"
    "/top - 10 koin terbesar\n"
    "/gainers - top gainer & loser 24j\n"
    "/rsi <coin> - RSI-14 + MA7/MA30\n"
    "/chart <coin> - grafik harga 7 hari\n"
    "/trending - koin yang lagi trending\n"
    "/fear - Fear & Greed Index\n"
    "/dominance - dominasi BTC + total market cap\n"
    "/convert <jml> <dari> <ke> - misal /convert 1 btc idr\n"
    "/saldo <0x...> - saldo wallet (cuma liat, ETH + BSC)\n"
    "/tx <hash> - status transaksi ETH/BSC\n"
    "/berita - berita crypto terbaru\n"
    "/tambah <coin> <jml> - catat holdings lo\n"
    "/portofolio - total nilai holdings lo\n"
    "/alert <coin> <harga> - alarm harga\n"
    "/cuaca <kota> - cuaca sekarang\n"
    "/kurs - kurs USD ke Rupiah\n"
    "/gas - gas fee ETH + BSC\n"
    "/rank - posisi lo di make.fun\n"
    "/inget <teks> - simpen catatan\n"
    "/catatan - liat catatan lo\n"
    "/waktu - jam dan tanggal sekarang\n"
    "Kirim rumus kayak 12*15, gue hitungin.\n\n"
    "/help - daftar lengkap\n"
    "/baru - mulai obrolan baru (hapus ingatan)"
)

HELP = (
    "Skill gue:\n\n"
    "Tanya apa aja - jawab singkat dan jelas, inget obrolan kita.\n"
    "/harga <coin> - harga crypto live, misal /harga btc\n"
    "/analisa <coin> - harga, 24j/7h/30h, volume, market cap, ATH/ATL\n"
    "/top - 10 koin terbesar berdasarkan market cap\n"
    "/gainers - 5 top gainer + 5 top loser 24 jam\n"
    "/rsi <coin> - RSI-14 + MA7/MA30, misal /rsi btc\n"
    "/chart <coin> - grafik harga 7 hari, misal /chart eth\n"
    "/trending - 7 koin yang lagi trending\n"
    "/fear - Fear & Greed Index\n"
    "/dominance - dominasi BTC + total market cap\n"
    "/convert <jml> <dari> <ke> - misal /convert 1 btc idr\n"
    "/saldo <0x...> - saldo wallet (cuma liat, ETH + BSC + USDT/USDC)\n"
    "/tx <hash> - status transaksi di ETH/BSC\n"
    "/berita - 5 berita crypto terbaru\n"
    "/tambah <coin> <jml> - catat holdings, misal /tambah btc 0.05\n"
    "/kurang <coin> <jml> - kurangi holdings\n"
    "/portofolio - total nilai semua holdings lo\n"
    "/alert <coin> <harga> [atas|bawah] - alarm harga, misal /alert btc 70000\n"
    "/alerts - liat semua alarm aktif\n"
    "/hapus_alert <no> - hapus alarm, misal /hapus_alert 1\n"
    "/cuaca <kota> - cuaca sekarang, misal /cuaca jakarta\n"
    "/kurs - kurs USD ke Rupiah dan mata uang lain\n"
    "/gas - gas fee ETH + BSC sekarang\n"
    "/rank - posisi lo di bounty make.fun + penghasilan\n"
    "/inget <teks> - simpen catatan, misal /inget beli susu\n"
    "/catatan - liat semua catatan lo\n"
    "/hapus <no> - hapus catatan, misal /hapus 1\n"
    "/waktu - jam dan tanggal sekarang (WIB)\n"
    "Rumus - kirim 12*15 atau 100+250, gue hitungin.\n"
    "/baru - mulai obrolan baru (hapus ingatan)\n"
    "/help - pesan ini"
)

COIN_ALIASES = {
    "btc": "bitcoin", "bitcoin": "bitcoin",
    "eth": "ethereum", "ethereum": "ethereum",
    "sol": "solana", "solana": "solana",
    "bnb": "binancecoin", "xrp": "ripple", "ripple": "ripple",
    "doge": "dogecoin", "dogecoin": "dogecoin",
    "ada": "cardano", "cardano": "cardano",
    "usdt": "tether", "tether": "tether",
    "usdc": "usd-coin", "ton": "the-open-network",
    "trx": "tron", "tron": "tron", "avax": "avalanche-2",
    "link": "chainlink", "dot": "polkadot", "ltc": "litecoin",
    "gt": "gatechain-token", "mon": "monad",
    "pol": "polygon-ecosystem-token", "polygon": "polygon-ecosystem-token",
    "matic": "matic-network",
}


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)


def load_json(path, default):
    try:
        with open(path) as f:
            v = json.load(f)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def save_json(path, value):
    with open(path, "w") as f:
        json.dump(value, f)
    os.chmod(path, 0o600)


def http_get_json(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def tg_request(cfg, method, payload=None):
    url = "https://api.telegram.org/bot{}/{}".format(cfg["telegram_token"], method)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=POLL_TIMEOUT + 10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = ""
        print("Telegram {} failed HTTP {}: {}".format(method, e.code, body),
              file=sys.stderr, flush=True)
        return {"ok": False}
    except Exception as e:
        print("Telegram {} error: {}".format(method, e), file=sys.stderr, flush=True)
        return {"ok": False}


def send_message(cfg, chat_id, text):
    for i in range(0, len(text), 4000):
        tg_request(cfg, "sendMessage",
                   {"chat_id": chat_id, "text": text[i:i + 4000]})


def send_photo(cfg, chat_id, photo_url, caption=""):
    tg_request(cfg, "sendPhoto",
               {"chat_id": chat_id, "photo": photo_url,
                "caption": caption[:1000]})


def fmt_idr(n):
    return "Rp{:,.0f}".format(n).replace(",", ".")


def fmt_usd(n):
    if n >= 1000:
        return "${:,.2f}".format(n)
    return "${:.4f}".format(n)


# ---------------- skills ----------------

def resolve_coin_id(coin):
    """Resolve a symbol/name to a CoinGecko id. Returns (cid, name) or (None, None)."""
    coin = (coin or "").strip().lower()
    if not coin:
        return None, None
    if coin in COIN_ALIASES:
        return COIN_ALIASES[coin], coin
    try:
        s = http_get_json(
            "https://api.coingecko.com/api/v3/search?query={}".format(
                urllib.request.quote(coin)))
    except Exception as e:
        print("CoinGecko search error: {}".format(e), file=sys.stderr, flush=True)
        return None, None
    coins = s.get("coins") or []
    for c in coins:
        if c.get("symbol", "").lower() == coin:
            return c["id"], c.get("name", coin)
    if coins:
        return coins[0]["id"], coins[0].get("name", coin)
    return None, None


def skill_price(arg):
    coin = (arg or "").strip().lower()
    if not coin:
        return "Koin apa? Misal: /harga btc"
    cid, _name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu. Coba /harga btc, eth, sol.".format(coin)
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/simple/price?ids={}"
            "&vs_currencies=usd,idr".format(cid))
    except Exception as e:
        print("CoinGecko error: {}".format(e), file=sys.stderr, flush=True)
        return "Harga lagi nggak bisa dicek. Coba lagi sebentar."
    info = d.get(cid)
    if not info:
        return "Koin '{}' nggak ketemu. Coba /harga btc, eth, sol.".format(coin)
    return "{}: {} ({}).".format(coin.upper(), fmt_usd(info["usd"]),
                                 fmt_idr(info["idr"]))


def skill_weather(arg):
    city = (arg or "").strip()
    if not city:
        return "Kota apa? Misal: /cuaca jakarta"
    try:
        g = http_get_json(
            "https://geocoding-api.open-meteo.com/v1/search?name={}"
            "&count=1&language=id".format(urllib.request.quote(city)))
        res = g.get("results") or []
        if not res:
            return "Kota '{}' nggak ketemu.".format(city)
        lat, lon = res[0]["latitude"], res[0]["longitude"]
        name = res[0].get("name", city)
        w = http_get_json(
            "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}"
            "&current=temperature_2m,relative_humidity_2m,weather_code,"
            "wind_speed_10m&timezone=auto".format(lat, lon))
        cur = w.get("current", {})
        codes = {0: "cerah", 1: "cerah berawan", 2: "berawan",
                 3: "mendung", 45: "berkabut", 48: "berkabut",
                 51: "gerimis", 53: "gerimis", 55: "gerimis",
                 61: "hujan ringan", 63: "hujan", 65: "hujan deras",
                 71: "salju ringan", 73: "salju", 75: "salju lebat",
                 80: "hujan ringan", 81: "hujan", 82: "hujan deras",
                 95: "badai petir"}
        cond = codes.get(cur.get("weather_code"), "berawan")
        return ("Cuaca {} sekarang: {}, suhu {:.0f}C, kelembapan {}%, "
                "angin {:.0f} km/jam.".format(
                    name, cond, cur.get("temperature_2m", 0),
                    cur.get("relative_humidity_2m", 0),
                    cur.get("wind_speed_10m", 0)))
    except Exception as e:
        print("Weather error: {}".format(e), file=sys.stderr, flush=True)
        return "Cuaca lagi nggak bisa dicek. Coba lagi sebentar."


def skill_kurs():
    try:
        d = http_get_json("https://api.exchangerate-api.com/v4/latest/USD")
        r = d.get("rates", {})
        idr = r.get("IDR")
        if not idr:
            return "Kurs lagi nggak bisa dicek."
        return ("1 USD = {}. 1 EUR = {}, 1 SGD = {}, 1 JPY = {}."
                .format(fmt_idr(idr), fmt_idr(idr / r.get("EUR", 1)),
                        fmt_idr(idr / r.get("SGD", 1)),
                        fmt_idr(idr / r.get("JPY", 1) * 100) + " /100"))
    except Exception as e:
        print("Kurs error: {}".format(e), file=sys.stderr, flush=True)
        return "Kurs lagi nggak bisa dicek. Coba lagi sebentar."


def skill_rank():
    try:
        key = json.load(open(MAKEFUN_CREDS))["key"]
        me = http_get_json("https://make.fun/api/me",
                           headers={"x-api-key": key}, timeout=30)
        entries = me.get("entry_count", len(me.get("entries", [])))
        earn = me.get("earnings", {})
        total = earn.get("total_usd", 0)
        paid = earn.get("paid_usd", 0)
        pending = earn.get("pending_usd", 0)
        return ("make.fun lo: {} entri, penghasilan total ${}, "
                "udah dibayar ${}, pending ${}.".format(
                    entries, total, paid, pending))
    except Exception as e:
        print("make.fun error: {}".format(e), file=sys.stderr, flush=True)
        return "Rank make.fun lagi nggak bisa dicek. Coba lagi sebentar."


def _rpc_gas_price(urls):
    payload = {"jsonrpc": "2.0", "method": "eth_gasPrice",
               "params": [], "id": 1}
    for url in urls:
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.load(r)
            return int(d["result"], 16) / 1e9
        except Exception as e:
            print("Gas RPC {} error: {}".format(url, e),
                  file=sys.stderr, flush=True)
    return None


def skill_gas():
    eth = _rpc_gas_price(["https://ethereum-rpc.publicnode.com",
                          "https://eth.llamarpc.com"])
    bnb = _rpc_gas_price(["https://bsc-dataseed.binance.org",
                          "https://bsc.llamarpc.com"])
    eth_s = "{:.2f} Gwei".format(eth) if eth is not None else "nggak bisa dicek"
    bnb_s = "{:.2f} Gwei".format(bnb) if bnb is not None else "nggak bisa dicek"
    return "Gas sekarang — ETH: {}, BSC: {}.".format(eth_s, bnb_s)


def skill_calc(text):
    expr = text.strip().replace(",", ".").replace("x", "*").replace("X", "*")
    if not re.fullmatch(r"[0-9+\-*/().\s%]+", expr):
        return None
    if not any(c.isdigit() for c in expr):
        return None
    try:
        val = eval(expr, {"__builtins__": {}}, {"sqrt": math.sqrt})
    except Exception:
        return None
    if isinstance(val, float) and val == int(val):
        val = int(val)
    return "{} = {}".format(text.strip(), val)


def skill_time():
    now = datetime.now(WIB)
    days = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]
    months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
              "Juli", "Agustus", "September", "Oktober", "November",
              "Desember"]
    return "Sekarang {}, {} {} {} pukul {:02d}:{:02d} WIB.".format(
        days[now.weekday()], now.day, months[now.month - 1], now.year,
        now.hour, now.minute)


def fmt_pct(v):
    if v is None:
        return "?"
    return "{:+.2f}%".format(v)


def _fear_label(v):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return ""
    if v < 25:
        return "takut banget"
    if v < 45:
        return "takut"
    if v < 55:
        return "netral"
    if v < 75:
        return "serakah"
    return "serakah banget"


def skill_fear():
    try:
        d = http_get_json("https://api.alternative.me/fng/?limit=1")
        f = (d.get("data") or [{}])[0]
        v = f.get("value")
        cls = f.get("value_classification", "")
        return "Fear & Greed Index: {} ({} — {}).".format(
            v, cls, _fear_label(v))
    except Exception as e:
        print("Fear error: {}".format(e), file=sys.stderr, flush=True)
        return "Fear & Greed lagi nggak bisa dicek. Coba lagi sebentar."


def skill_analisa(arg):
    coin = (arg or "").strip().lower()
    if not coin:
        return "Analisa koin apa? Misal: /analisa btc"
    cid, name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu. Coba /analisa btc, eth, sol.".format(coin)
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/coins/{}?localization=false"
            "&tickers=false&community_data=false&developer_data=false"
            "&sparkline=false".format(cid))
        md = d.get("market_data", {})
        price = md.get("current_price", {})
        fng = http_get_json("https://api.alternative.me/fng/?limit=1")
        f = (fng.get("data") or [{}])[0]
    except Exception as e:
        print("Analisa error: {}".format(e), file=sys.stderr, flush=True)
        return "Analisa lagi nggak bisa dicek. Coba lagi sebentar."
    ath = (md.get("ath") or {}).get("usd")
    atl = (md.get("atl") or {}).get("usd")
    cur = price.get("usd")
    ath_chg = None
    if ath and cur:
        ath_chg = (cur / ath - 1) * 100
    lines = [
        "{} ({}) — {} ({}).".format(
            d.get("name", coin).title() if d.get("name") else coin.upper(),
            coin.upper(), fmt_usd(cur or 0),
            fmt_idr(price.get("idr", 0))),
        "24j: {} | 7h: {} | 30h: {}.".format(
            fmt_pct(md.get("price_change_percentage_24h")),
            fmt_pct(md.get("price_change_percentage_7d")),
            fmt_pct(md.get("price_change_percentage_30d"))),
        "Vol 24j: ${:,.0f} | Market cap: ${:,.0f} | Rank #{}.".format(
            md.get("total_volume", {}).get("usd") or 0,
            md.get("market_cap", {}).get("usd") or 0,
            d.get("market_cap_rank") or "?"),
    ]
    if ath:
        lines.append("ATH: {} ({} dari ATH) | ATL: {}.".format(
            fmt_usd(ath), fmt_pct(ath_chg), fmt_usd(atl or 0)))
    lines.append("Fear & Greed: {} ({}).".format(
        f.get("value"), _fear_label(f.get("value"))))
    return "\n".join(lines)


def skill_trending():
    try:
        d = http_get_json("https://api.coingecko.com/api/v3/search/trending")
        coins = d.get("coins") or []
        if not coins:
            return "Trending lagi nggak bisa dicek."
        lines = ["Lagi trending di CoinGecko:"]
        for i, c in enumerate(coins[:7], 1):
            it = c.get("item", {})
            lines.append("{}. {} ({}) — rank #{}".format(
                i, it.get("name"), it.get("symbol"),
                it.get("market_cap_rank") or "?"))
        return "\n".join(lines)
    except Exception as e:
        print("Trending error: {}".format(e), file=sys.stderr, flush=True)
        return "Trending lagi nggak bisa dicek. Coba lagi sebentar."


def skill_dominance():
    try:
        d = http_get_json("https://api.coingecko.com/api/v3/global")
        data = d.get("data", {})
        pct = data.get("market_cap_percentage", {})
        total = (data.get("total_market_cap") or {}).get("usd") or 0
        chg = data.get("market_cap_change_percentage_24h_usd")
        return ("Dominasi BTC: {:.1f}% | ETH: {:.1f}% | Total market cap: "
                "${:,.0f} (24j {}).".format(
                    pct.get("btc") or 0, pct.get("eth") or 0, total,
                    fmt_pct(chg)))
    except Exception as e:
        print("Dominance error: {}".format(e), file=sys.stderr, flush=True)
        return "Dominasi lagi nggak bisa dicek. Coba lagi sebentar."


def _usd_price(sym):
    """USD price of a symbol (crypto via CoinGecko, fiat via exchangerate)."""
    sym = sym.lower()
    if sym in ("usd", "dollar", "usdt", "usdc", "dai"):
        return 1.0
    if sym in ("idr", "rupiah", "rp"):
        try:
            d = http_get_json("https://api.exchangerate-api.com/v4/latest/USD")
            rate = (d.get("rates") or {}).get("IDR")
            return 1.0 / rate if rate else None
        except Exception:
            return None
    cid, _name = resolve_coin_id(sym)
    if not cid:
        return None
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/simple/price?ids={}"
            "&vs_currencies=usd".format(cid))
        return (d.get(cid) or {}).get("usd")
    except Exception:
        return None


def skill_convert(arg):
    parts = (arg or "").strip().lower().split()
    if len(parts) != 3:
        return "Format: /convert <jumlah> <dari> <ke>, misal /convert 1 btc idr"
    try:
        amt = float(parts[0].replace(",", "."))
    except ValueError:
        return "Jumlahnya harus angka. Misal: /convert 1 btc idr"
    src, dst = parts[1], parts[2]
    ps = _usd_price(src)
    pd = _usd_price(dst)
    if ps is None:
        return "Koin '{}' nggak ketemu.".format(src)
    if pd is None:
        return "Koin '{}' nggak ketemu.".format(dst)
    out = amt * ps / pd
    if dst in ("idr", "rupiah", "rp"):
        return "{} {} = {}.".format(amt, src.upper(), fmt_idr(out))
    if dst in ("usd", "dollar"):
        return "{} {} = {}.".format(amt, src.upper(), fmt_usd(out))
    return "{} {} = {:.6f} {}.".format(amt, src.upper(), out, dst.upper())


def skill_berita():
    try:
        import xml.etree.ElementTree as ET
        req = urllib.request.Request(
            "https://news.google.com/rss/search?q=cryptocurrency"
            "&hl=id&gl=ID&ceid=ID:id",
            headers={"User-Agent": "crest-ai"})
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
        root = ET.fromstring(raw)
        items = root.findall(".//item")[:5]
        if not items:
            return "Berita crypto lagi nggak bisa dicek."
        lines = ["Berita crypto terbaru:"]
        for i, it in enumerate(items, 1):
            title = (it.findtext("title") or "").split(" - ")[0].strip()
            lines.append("{}. {}".format(i, title))
        return "\n".join(lines)
    except Exception as e:
        print("Berita error: {}".format(e), file=sys.stderr, flush=True)
        return "Berita crypto lagi nggak bisa dicek. Coba lagi sebentar."


def skill_top():
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/coins/markets"
            "?vs_currency=usd&order=market_cap_desc&per_page=10&page=1"
            "&price_change_percentage=24h")
    except Exception as e:
        print("Top error: {}".format(e), file=sys.stderr, flush=True)
        return "Top 10 lagi nggak bisa dicek. Coba lagi sebentar."
    lines = ["Top 10 crypto (market cap):"]
    for i, c in enumerate(d, 1):
        lines.append("{}. {} ({}) — {} (24j {})".format(
            i, c.get("name"), (c.get("symbol") or "").upper(),
            fmt_usd(c.get("current_price") or 0),
            fmt_pct(c.get("price_change_percentage_24h"))))
    return "\n".join(lines)


def skill_gainers():
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/coins/markets"
            "?vs_currency=usd&order=market_cap_desc&per_page=100&page=1"
            "&price_change_percentage=24h")
    except Exception as e:
        print("Gainers error: {}".format(e), file=sys.stderr, flush=True)
        return "Gainers lagi nggak bisa dicek. Coba lagi sebentar."
    ranked = sorted(d, key=lambda c: c.get("price_change_percentage_24h") or 0)
    lines = ["Top 5 gainer 24j:"]
    for c in ranked[-5:][::-1]:
        lines.append("- {} ({}) {} (24j {})".format(
            c.get("name"), (c.get("symbol") or "").upper(),
            fmt_usd(c.get("current_price") or 0),
            fmt_pct(c.get("price_change_percentage_24h"))))
    lines.append("Top 5 loser 24j:")
    for c in ranked[:5]:
        lines.append("- {} ({}) {} (24j {})".format(
            c.get("name"), (c.get("symbol") or "").upper(),
            fmt_usd(c.get("current_price") or 0),
            fmt_pct(c.get("price_change_percentage_24h"))))
    return "\n".join(lines)


def _rsi_14(closes):
    """Wilder's RSI-14 from daily closes. Returns None if not enough data."""
    if len(closes) < 15:
        return None
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(c, 0) for c in changes]
    losses = [max(-c, 0) for c in changes]
    avg_gain = sum(gains[:14]) / 14
    avg_loss = sum(losses[:14]) / 14
    for i in range(14, len(changes)):
        avg_gain = (avg_gain * 13 + gains[i]) / 14
        avg_loss = (avg_loss * 13 + losses[i]) / 14
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def skill_rsi(arg):
    coin = (arg or "").strip().lower()
    if not coin:
        return "RSI koin apa? Misal: /rsi btc"
    cid, name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu. Coba /rsi btc, eth, sol.".format(coin)
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/coins/{}/market_chart"
            "?vs_currency=usd&days=30&interval=daily".format(cid))
        closes = [p[1] for p in d.get("prices", [])]
    except Exception as e:
        print("RSI error: {}".format(e), file=sys.stderr, flush=True)
        return "RSI lagi nggak bisa dicek. Coba lagi sebentar."
    if len(closes) < 15:
        return "Data harga {} kurang buat hitung RSI.".format(coin.upper())
    rsi = _rsi_14(closes)
    ma7 = sum(closes[-7:]) / 7
    ma30 = sum(closes) / len(closes)
    last = closes[-1]
    if rsi >= 70:
        verdict = "jenuh beli (overbought)"
    elif rsi <= 30:
        verdict = "jenuh jual (oversold)"
    else:
        verdict = "netral"
    trend = "di atas MA30 (tren naik)" if last > ma30 else "di bawah MA30 (tren turun)"
    return ("RSI-14 {} ({}): {:.1f} — {}.\n"
            "Harga: {} | MA7: {} | MA30: {} — {}."
            .format((name or coin).upper(), coin.upper(), rsi, verdict,
                    fmt_usd(last), fmt_usd(ma7), fmt_usd(ma30), trend))


def skill_chart(arg, cfg=None, chat_id=None):
    coin = (arg or "").strip().lower()
    if not coin:
        return "Chart koin apa? Misal: /chart btc"
    cid, name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu. Coba /chart btc, eth, sol.".format(coin)
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/coins/{}/market_chart"
            "?vs_currency=usd&days=7&interval=daily".format(cid))
        pts = d.get("prices", [])
        if len(pts) < 2:
            return "Data chart {} kurang.".format(coin.upper())
        labels = [datetime.fromtimestamp(p[0] / 1000, tz=WIB).strftime("%d/%m")
                  for p in pts]
        values = [round(p[1], 4) for p in pts]
        chg = (values[-1] / values[0] - 1) * 100 if values[0] else 0
    except Exception as e:
        print("Chart error: {}".format(e), file=sys.stderr, flush=True)
        return "Chart lagi nggak bisa dicek. Coba lagi sebentar."
    import urllib.parse
    cfg_chart = {
        "type": "line",
        "data": {"labels": labels,
                 "datasets": [{"label": (name or coin).upper() + " (USD)",
                               "data": values, "fill": False,
                               "borderColor": "rgb(75, 192, 192)"}]},
        "options": {"title": {"display": True,
                              "text": "{} 7 hari ({}%)".format(
                                  (name or coin).upper(), fmt_pct(chg))}},
    }
    url = ("https://quickchart.io/chart?c=" +
           urllib.parse.quote(json.dumps(cfg_chart)))
    if cfg is not None and chat_id is not None:
        send_photo(cfg, chat_id, url,
                   "{} 7 hari: {} ({}).".format(
                       (name or coin).upper(), fmt_usd(values[-1]),
                       fmt_pct(chg)))
        return "__PHOTO_SENT__"
    return url


def _load_portfolio():
    return load_json(PORTFOLIO_PATH, {})


def skill_tambah(arg, delta=1):
    parts = (arg or "").strip().lower().split()
    if len(parts) != 2:
        return ("Format: /tambah <coin> <jumlah>, misal /tambah btc 0.05. "
                "Buat kurangi: /kurang <coin> <jumlah>.")
    coin = parts[0]
    try:
        amt = float(parts[1].replace(",", "."))
    except ValueError:
        return "Jumlahnya harus angka. Misal: /tambah btc 0.05"
    if amt <= 0:
        return "Jumlahnya harus lebih dari 0."
    cid, name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu.".format(coin)
    pf = _load_portfolio()
    cur = pf.get(cid, {}).get("amount", 0)
    new = round(cur + delta * amt, 8)
    if new <= 0:
        new = 0
    if new == 0:
        pf.pop(cid, None)
        save_json(PORTFOLIO_PATH, pf)
        return "{} dihapus dari portofolio.".format(coin.upper())
    pf[cid] = {"symbol": coin.upper(), "name": name or coin, "amount": new}
    save_json(PORTFOLIO_PATH, pf)
    verb = "ditambah" if delta > 0 else "dikurangi"
    return "{} {} {} — total sekarang {} {}.".format(
        coin.upper(), verb, amt, new, coin.upper())


def skill_portofolio():
    pf = _load_portfolio()
    if not pf:
        return ("Portofolio masih kosong. Catat holdings lo: "
                "/tambah btc 0.05")
    ids = ",".join(pf.keys())
    try:
        d = http_get_json(
            "https://api.coingecko.com/api/v3/simple/price?ids={}"
            "&vs_currencies=usd,idr".format(ids))
    except Exception as e:
        print("Portofolio error: {}".format(e), file=sys.stderr, flush=True)
        return "Portofolio lagi nggak bisa dicek. Coba lagi sebentar."
    lines = ["Portofolio lo:"]
    total_usd = 0.0
    total_idr = 0.0
    for cid, h in pf.items():
        info = d.get(cid) or {}
        price = info.get("usd", 0)
        price_idr = info.get("idr", 0)
        val = h["amount"] * price
        total_usd += val
        total_idr += h["amount"] * price_idr
        lines.append("- {} {} ({}): {} (~${:,.2f})".format(
            h["amount"], h["symbol"], h.get("name", ""),
            fmt_usd(price), val))
    lines.append("Total: ${:,.2f} ({}).".format(total_usd, fmt_idr(total_idr)))
    return "\n".join(lines)


def _load_alerts():
    return load_json(ALERTS_PATH, [])


def skill_alert(arg):
    parts = (arg or "").strip().lower().split()
    if len(parts) < 2 or len(parts) > 3:
        return ("Format: /alert <coin> <harga> [atas|bawah], "
                "misal /alert btc 70000")
    coin = parts[0]
    try:
        target = float(parts[1].replace(",", "."))
    except ValueError:
        return "Harganya harus angka. Misal: /alert btc 70000"
    if target <= 0:
        return "Harganya harus lebih dari 0."
    direction = parts[2] if len(parts) == 3 else None
    if direction not in (None, "atas", "bawah"):
        return "Arahnya 'atas' atau 'bawah'. Misal: /alert btc 70000 atas"
    cid, name = resolve_coin_id(coin)
    if not cid:
        return "Koin '{}' nggak ketemu.".format(coin)
    if direction is None:
        try:
            d = http_get_json(
                "https://api.coingecko.com/api/v3/simple/price?ids={}"
                "&vs_currencies=usd".format(cid))
            cur = (d.get(cid) or {}).get("usd")
        except Exception:
            cur = None
        direction = "atas" if (cur is None or target > cur) else "bawah"
    alerts = _load_alerts()
    alerts.append({"coin": coin.upper(), "cid": cid, "name": name or coin,
                   "target": target, "direction": direction})
    save_json(ALERTS_PATH, alerts)
    return ("Alarm disetel: {} {} ${:,.2f} (no {}). Gue kabarin begitu "
            "harganya nyentuh.".format(
                coin.upper(), "naik ke" if direction == "atas" else "turun ke",
                target, len(alerts)))


def skill_alerts():
    alerts = _load_alerts()
    if not alerts:
        return ("Belum ada alarm. Setel: /alert btc 70000")
    lines = ["Alarm aktif:"]
    for i, a in enumerate(alerts, 1):
        lines.append("{}. {} {} ${:,.2f}".format(
            i, a["coin"], "naik ke" if a["direction"] == "atas" else "turun ke",
            a["target"]))
    return "\n".join(lines)


def skill_hapus_alert(arg):
    arg = (arg or "").strip()
    if not arg.isdigit():
        return "Format: /hapus_alert <no>, misal /hapus_alert 1"
    idx = int(arg) - 1
    alerts = _load_alerts()
    if not (0 <= idx < len(alerts)):
        return "Nomor alarm nggak ada."
    gone = alerts.pop(idx)
    save_json(ALERTS_PATH, alerts)
    return "Alarm {} ${:,.2f} dihapus.".format(gone["coin"], gone["target"])


# --- wallet (READ-ONLY: public RPC lookups, no keys, no signing) ---

RPCS = {
    "ETH": ["https://ethereum-rpc.publicnode.com",
            "https://eth.llamarpc.com"],
    "BSC": ["https://bsc-dataseed.binance.org",
            "https://bsc.llamarpc.com"],
}

TOKENS = {
    ("ETH", "USDT"): ("0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
    ("ETH", "USDC"): ("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
    ("BSC", "USDT"): ("0x55d398326f99059fF775485246999027B3197955", 6),
    ("BSC", "USDC"): ("0x8AC76a51cc950d9822D68b83fE1Ad97B32C4dD1a", 6),
}


def _rpc_call(urls, method, params):
    payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    for url in urls:
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.load(r)
            if "result" in d and d["result"] is not None:
                return d["result"]
        except Exception as e:
            print("RPC {} error: {}".format(url, e), file=sys.stderr, flush=True)
    return None


def skill_saldo(arg):
    addr = (arg or "").strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", addr):
        return ("Alamatnya harus 0x + 40 karakter hex. "
                "Misal: /saldo 0xAe5f920b5d5Ce0f941b2b1A941eb058Cac3E5624")
    try:
        p = http_get_json(
            "https://api.coingecko.com/api/v3/simple/price"
            "?ids=ethereum,binancecoin,tether,usd-coin&vs_currencies=usd")
    except Exception:
        p = {}
    short = addr[:8] + "..." + addr[-6:]
    lines = ["Saldo {} (cuma liat, read-only):".format(short)]
    total_usd = 0.0
    for chain, sym, cgid in (("ETH", "ETH", "ethereum"),
                             ("BSC", "BNB", "binancecoin")):
        bal_hex = _rpc_call(RPCS[chain], "eth_getBalance", [addr, "latest"])
        if bal_hex is None:
            lines.append("{}: nggak bisa dicek".format(chain))
            continue
        bal = int(bal_hex, 16) / 1e18
        price = (p.get(cgid) or {}).get("usd", 0)
        total_usd += bal * price
        lines.append("{}: {:.4f} {} (~${:,.2f})".format(
            chain, bal, sym, bal * price))
        for (ch, tsym), (contract, dec) in TOKENS.items():
            if ch != chain:
                continue
            data = "0x70a08231" + "0" * 24 + addr[2:].lower()
            res = _rpc_call(RPCS[chain], "eth_call",
                            [{"to": contract, "data": data}, "latest"])
            if not res or res == "0x":
                continue
            try:
                tb = int(res, 16) / (10 ** dec)
            except ValueError:
                continue
            if tb > 0:
                tprice = (p.get("tether" if tsym == "USDT" else "usd-coin")
                          or {}).get("usd", 1)
                total_usd += tb * tprice
                lines.append("  {} ({}): {:.2f} (~${:,.2f})".format(
                    tsym, chain, tb, tb * tprice))
    lines.append("Total: ~${:,.2f}".format(total_usd))
    return "\n".join(lines)


def skill_tx(arg):
    h = (arg or "").strip().lower()
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", h):
        return ("Hash tx harus 0x + 64 karakter hex. "
                "Misal: /tx 0x...")
    for chain in ("ETH", "BSC"):
        rec = _rpc_call(RPCS[chain], "eth_getTransactionReceipt", [h])
        if rec is None:
            continue
        st = rec.get("status")
        status = "sukses" if st in ("0x1", None) else "gagal"
        try:
            block = int(rec.get("blockNumber", "0x0"), 16)
        except ValueError:
            block = 0
        tx = _rpc_call(RPCS[chain], "eth_getTransactionByHash", [h]) or {}
        try:
            val = int(tx.get("value", "0x0"), 16) / 1e18
        except ValueError:
            val = 0
        frm = (tx.get("from") or "?")
        to = (tx.get("to") or "kontrak baru")
        sym = "ETH" if chain == "ETH" else "BNB"
        return ("Tx ketemu di {}: {} (blok #{:,}). Dari {} ke {}, "
                "nilai {:.4f} {}.".format(
                    chain, status, block, frm[:10] + "...",
                    to[:10] + "..." if to != "kontrak baru" else to,
                    val, sym))
    return "Tx '{}...' nggak ketemu di ETH maupun BSC (mungkin masih pending atau hash salah).".format(h[:10])


# ---------------- chat (Gemini free tier) ----------------

def chat_ask(history, question):
    try:
        key = json.load(open(GEMINI_CREDS))["key"]
    except Exception as e:
        print("Gemini key error: {}".format(e), file=sys.stderr, flush=True)
        return "Chat lagi nggak bisa (key Gemini belum ada)."
    contents = []
    for h in history[-MAX_HISTORY:]:
        role = "user" if h.get("role") == "user" else "model"
        contents.append({"role": role,
                         "parts": [{"text": h.get("content", "")}]})
    contents.append({"role": "user", "parts": [{"text": question}]})
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": 500, "temperature": 0.7},
    }
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           "{}:generateContent?key={}".format(GEMINI_MODEL, key))
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT) as r:
                d = json.load(r)
            parts = d["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
            return text or "Gue nggak dapet jawaban."
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode()[:300]
            except Exception:
                body = ""
            last_err = "HTTP {}: {}".format(e.code, body)
            print("Gemini error (attempt {}): {}".format(attempt + 1, last_err),
                  file=sys.stderr, flush=True)
            if attempt < 2:
                time.sleep(3)
        except Exception as e:
            last_err = str(e)
            print("Gemini error (attempt {}): {}".format(attempt + 1, last_err),
                  file=sys.stderr, flush=True)
            if attempt < 2:
                time.sleep(3)
    print("Gemini failed after 3 attempts: {}".format(last_err),
          file=sys.stderr, flush=True)
    return "Chat lagi error. Coba lagi sebentar."


def dispatch_skill(text, cfg=None, chat_id=None):
    """Return a skill answer, or None if no skill matches.
    Returns "__PHOTO_SENT__" when a photo was already sent (no text reply)."""
    low = text.lower().strip()
    if low.startswith("/top"):
        return skill_top()
    if low.startswith("/gainers"):
        return skill_gainers()
    if low.startswith("/rsi"):
        return skill_rsi(text[4:])
    if low.startswith("/chart"):
        return skill_chart(text[6:], cfg, chat_id)
    if low.startswith("/tambah"):
        return skill_tambah(text[7:], delta=1)
    if low.startswith("/kurang"):
        return skill_tambah(text[7:], delta=-1)
    if low.startswith("/portofolio"):
        return skill_portofolio()
    if low.startswith("/alert"):
        if low.startswith("/alerts"):
            return skill_alerts()
        return skill_alert(text[6:])
    if low.startswith("/hapus_alert"):
        return skill_hapus_alert(text[12:])
    if low.startswith("/analisa"):
        return skill_analisa(text[8:])
    if low.startswith("/trending"):
        return skill_trending()
    if low.startswith("/fear"):
        return skill_fear()
    if low.startswith("/dominance"):
        return skill_dominance()
    if low.startswith("/convert"):
        return skill_convert(text[8:])
    if low.startswith("/saldo"):
        return skill_saldo(text[6:])
    if low.startswith("/tx"):
        return skill_tx(text[3:])
    if low.startswith("/berita"):
        return skill_berita()
    if low.startswith("/harga"):
        return skill_price(text[6:])
    if low.startswith("/cuaca"):
        return skill_weather(text[6:])
    if low.startswith("/kurs"):
        return skill_kurs()
    if low.startswith("/gas"):
        return skill_gas()
    if low.startswith("/rank"):
        return skill_rank()
    if low.startswith("/waktu"):
        return skill_time()
    if low in ("top", "top 10", "top crypto"):
        return skill_top()
    if low in ("gainers", "gainer", "top gainer"):
        return skill_gainers()
    m = re.match(r"^rsi\s+(.+)$", low)
    if m:
        return skill_rsi(m.group(1))
    m = re.match(r"^chart\s+(.+)$", low)
    if m:
        return skill_chart(m.group(1), cfg, chat_id)
    m = re.match(r"^tambah\s+(.+)$", low)
    if m:
        return skill_tambah(m.group(1), delta=1)
    m = re.match(r"^kurang\s+(.+)$", low)
    if m:
        return skill_tambah(m.group(1), delta=-1)
    if low in ("portofolio", "porto", "portfolio", "holdings gue"):
        return skill_portofolio()
    m = re.match(r"^alert\s+(.+)$", low)
    if m:
        return skill_alert(m.group(1))
    if low in ("alerts", "alarm", "alarm gue"):
        return skill_alerts()
    m = re.match(r"^hapus_alert\s+(\d+)$", low)
    if m:
        return skill_hapus_alert(m.group(1))
    m = re.match(r"^analisa\s+(.+)$", low)
    if m:
        return skill_analisa(m.group(1))
    if low in ("trending", "koin trending", "lagi trending"):
        return skill_trending()
    if low in ("fear", "fear and greed", "fear greed", "fear & greed"):
        return skill_fear()
    if low in ("dominance", "dominasi", "dominasi btc", "btc dominance"):
        return skill_dominance()
    m = re.match(r"^convert\s+(.+)$", low)
    if m:
        return skill_convert(m.group(1))
    m = re.match(r"^saldo\s+(0x[0-9a-fA-F]{40})$", text.strip())
    if m:
        return skill_saldo(m.group(1))
    m = re.match(r"^tx\s+(0x[0-9a-fA-F]{64})$", text.strip())
    if m:
        return skill_tx(m.group(1))
    if low in ("berita", "berita crypto", "berita kripto"):
        return skill_berita()
    m = re.match(r"^harga\s+(.+)$", low)
    if m:
        return skill_price(m.group(1))
    m = re.match(r"^cuaca(?:\s+di)?\s+(.+)$", low)
    if m:
        return skill_weather(m.group(1))
    if low in ("kurs", "kurs usd", "kurs dollar", "kurs dolar"):
        return skill_kurs()
    if low in ("gas", "gas fee", "gas eth", "gas bsc", "gas sekarang"):
        return skill_gas()
    if low in ("rank", "rank gue", "posisi gue", "posisi make.fun"):
        return skill_rank()
    if low in ("jam berapa", "sekarang jam berapa", "tanggal berapa"):
        return skill_time()
    calc = skill_calc(text)
    if calc is not None:
        return calc
    return None


def main():
    cfg = load_config()
    if not cfg.get("telegram_token"):
        print("config.json has no telegram_token yet.", file=sys.stderr)
        sys.exit(1)
    owner_id = cfg.get("owner_id")
    history = load_json(HISTORY_PATH, [])
    notes = load_json(NOTES_PATH, [])
    offset = 0
    print("Bot running. Owner: {}".format(owner_id or "(not set yet)"),
          flush=True)
    while True:
        res = tg_request(cfg, "getUpdates",
                         {"offset": offset, "timeout": POLL_TIMEOUT})
        if not res.get("ok"):
            time.sleep(5)
            continue
        for upd in res.get("result", []):
            offset = upd["update_id"] + 1
            msg = upd.get("message") or {}
            text = (msg.get("text") or "").strip()
            chat_id = (msg.get("chat") or {}).get("id")
            user_id = (msg.get("from") or {}).get("id")
            if chat_id is None:
                continue
            if owner_id is None:
                if text == "/start":
                    owner_id = user_id
                    cfg["owner_id"] = owner_id
                    save_config(cfg)
                    send_message(cfg, chat_id, WELCOME)
                else:
                    send_message(cfg, chat_id,
                                 "Bot ini pribadi. Kirim /start dulu.")
                continue
            if user_id != owner_id:
                send_message(cfg, chat_id,
                             "Maaf, bot ini cuma buat pemiliknya.")
                continue
            if text == "/start":
                send_message(cfg, chat_id, WELCOME)
                continue
            if text == "/help":
                send_message(cfg, chat_id, HELP)
                continue
            if text == "/baru":
                history = []
                save_json(HISTORY_PATH, history)
                send_message(cfg, chat_id,
                             "Obrolan baru. Ingatan udah gue hapus, "
                             "silakan tanya dari awal.")
                continue
            if text.startswith("/inget "):
                note = text[7:].strip()
                if note:
                    notes.append(note)
                    save_json(NOTES_PATH, notes)
                    send_message(cfg, chat_id,
                                 "Disimpen. Catatan no {}.".format(len(notes)))
                else:
                    send_message(cfg, chat_id,
                                 "Mau nyimpen apa? Misal: /inget beli susu")
                continue
            if text == "/catatan":
                if not notes:
                    send_message(cfg, chat_id, "Belum ada catatan.")
                else:
                    lines = ["Catatan lo:"] + [
                        "{}. {}".format(i + 1, n)
                        for i, n in enumerate(notes)]
                    send_message(cfg, chat_id, "\n".join(lines))
                continue
            m = re.match(r"^/hapus\s+(\d+)$", text)
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(notes):
                    gone = notes.pop(idx)
                    save_json(NOTES_PATH, notes)
                    send_message(cfg, chat_id,
                                 "Dihapus: {}".format(gone))
                else:
                    send_message(cfg, chat_id, "Nomor catatan nggak ada.")
                continue
            if not text:
                send_message(cfg, chat_id,
                             "Gue baru bisa bales pesan teks. Kirim "
                             "pertanyaan lo sebagai teks ya.")
                continue
            tg_request(cfg, "sendChatAction",
                       {"chat_id": chat_id, "action": "typing"})
            answer = dispatch_skill(text, cfg, chat_id)
            if answer == "__PHOTO_SENT__":
                history.append({"role": "user", "content": text})
                history.append({"role": "assistant",
                                "content": "[chart image sent]"})
                save_json(HISTORY_PATH, history[-MAX_HISTORY:])
                continue
            if answer is None:
                answer = chat_ask(history, text)
            history.append({"role": "user", "content": text})
            history.append({"role": "assistant", "content": answer})
            save_json(HISTORY_PATH, history[-MAX_HISTORY:])
            send_message(cfg, chat_id, answer)


if __name__ == "__main__":
    main()
