#!/bin/sh
# ui.sh press "<button name>" | shot <file>
P='first process whose name is "Patina"'
case "$1" in
  resolve) osascript -e "tell application \"System Events\" to tell ($P) to click (first button of toolbar 1 of window 1 whose description starts with \"Resolve\")" ;;
  key) osascript -e "tell application \"System Events\" to tell ($P) to set frontmost to true" -e "delay 0.2" -e "tell application \"System Events\" to keystroke \"$2\"" ;;
  code) osascript -e "tell application \"System Events\" to tell ($P) to set frontmost to true" -e "delay 0.2" -e "tell application \"System Events\" to key code $2" ;;
esac
