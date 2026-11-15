#!/bin/bash
# Restart Crest AI bot if it is not running.
if ! pgrep -f "^python3 (.*/)?bot\.py$" > /dev/null; then
  cd /home/hatch/workspace/telegram-bot
  nohup python3 /home/hatch/workspace/telegram-bot/bot.py >> bot.log 2>&1 &
fi
