#!/usr/bin/env python3
"""Crest AI price-alert checker. Run by cron every 10 minutes.
Reads alerts.json, checks current prices on CoinGecko, sends a Telegram
message to the owner when an alert fires, and removes fired alerts.
Stdlib only. Never prints the token."""
import json
import os
import sys
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
ALERTS_PATH = os.path.join(BASE, "alerts.json")


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


def tg_send(token, chat_id, text):
    url = "https://api.telegram.org/bot{}/sendMessage".format(token)
    payload = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def main():
    cfg = load_json(CONFIG_PATH, {})
    token = cfg.get("telegram_token")
    owner_id = cfg.get("owner_id")
    if not token or not owner_id:
        print("config.json missing token/owner_id", file=sys.stderr)
        return 1
    alerts = load_json(ALERTS_PATH, [])
    if not alerts:
        return 0
    ids = ",".join(sorted({a["cid"] for a in alerts}))
    try:
        req = urllib.request.Request(
            "https://api.coingecko.com/api/v3/simple/price"
            "?ids={}&vs_currencies=usd,idr".format(ids))
        with urllib.request.urlopen(req, timeout=20) as r:
            prices = json.load(r)
    except Exception as e:
        print("CoinGecko error: {}".format(e), file=sys.stderr)
        return 1
    remaining = []
    for a in alerts:
        info = prices.get(a["cid"]) or {}
        cur = info.get("usd")
        if cur is None:
            remaining.append(a)
            continue
        fired = (a["direction"] == "atas" and cur >= a["target"]) or \
                (a["direction"] == "bawah" and cur <= a["target"])
        if not fired:
            remaining.append(a)
            continue
        idr = info.get("idr") or 0
        idr_s = "Rp{:,.0f}".format(idr).replace(",", ".")
        msg = ("ALARM: {} {} ${:,.2f}!\n"
               "Harga sekarang: ${:,.4f} ({}).".format(
                   a["coin"],
                   "udah naik ke" if a["direction"] == "atas" else "udah turun ke",
                   a["target"], cur, idr_s))
        try:
            tg_send(token, owner_id, msg)
            print("Fired alert: {} {} {}".format(
                a["coin"], a["direction"], a["target"]))
        except Exception as e:
            print("Telegram send error: {}".format(e), file=sys.stderr)
            remaining.append(a)
    save_json(ALERTS_PATH, remaining)
    return 0


if __name__ == "__main__":
    sys.exit(main())
