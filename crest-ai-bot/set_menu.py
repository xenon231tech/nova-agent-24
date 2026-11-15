#!/usr/bin/env python3
"""Set the Crest AI Telegram menu commands on all scopes.
Reads the token from config.json (never prints it)."""
import json
import os
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(BASE, "config.json")))
TOKEN = cfg["telegram_token"]

COMMANDS = [
    {"command": "harga", "description": "Harga crypto live (USD + Rp)"},
    {"command": "analisa", "description": "Analisa market koin + Fear & Greed"},
    {"command": "top", "description": "Top 10 koin berdasarkan market cap"},
    {"command": "gainers", "description": "Top gainer & loser 24 jam"},
    {"command": "rsi", "description": "RSI-14 + MA7/MA30"},
    {"command": "chart", "description": "Grafik harga 7 hari"},
    {"command": "trending", "description": "Koin yang lagi trending"},
    {"command": "fear", "description": "Fear & Greed Index"},
    {"command": "dominance", "description": "Dominasi BTC + total market cap"},
    {"command": "convert", "description": "Convert crypto/fiat, misal /convert 1 btc idr"},
    {"command": "saldo", "description": "Saldo wallet (read-only, ETH + BSC)"},
    {"command": "tx", "description": "Status transaksi ETH/BSC"},
    {"command": "berita", "description": "Berita crypto terbaru"},
    {"command": "tambah", "description": "Catat holdings, misal /tambah btc 0.05"},
    {"command": "kurang", "description": "Kurangi holdings"},
    {"command": "portofolio", "description": "Total nilai holdings lo"},
    {"command": "alert", "description": "Alarm harga, misal /alert btc 70000"},
    {"command": "alerts", "description": "Liat semua alarm aktif"},
    {"command": "hapus_alert", "description": "Hapus alarm"},
    {"command": "cuaca", "description": "Cuaca sekarang"},
    {"command": "kurs", "description": "Kurs USD ke Rupiah"},
    {"command": "gas", "description": "Gas fee ETH + BSC"},
    {"command": "rank", "description": "Posisi lo di make.fun"},
    {"command": "inget", "description": "Simpen catatan"},
    {"command": "catatan", "description": "Liat catatan lo"},
    {"command": "hapus", "description": "Hapus catatan"},
    {"command": "waktu", "description": "Jam dan tanggal sekarang (WIB)"},
    {"command": "baru", "description": "Mulai obrolan baru (hapus ingatan)"},
    {"command": "help", "description": "Daftar lengkap skill"},
]

SCOPES = [
    {},
    {"type": "all_private_chats"},
    {"type": "all_group_chats"},
    {"type": "all_chat_administrators"},
]

for scope in SCOPES:
    payload = {"commands": COMMANDS}
    if scope:
        payload["scope"] = scope
    req = urllib.request.Request(
        "https://api.telegram.org/bot{}/setMyCommands".format(TOKEN),
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        print(scope or "default", "->", json.load(r).get("ok"))
