#!/usr/bin/env bash

op=$(echo -e " poweroff\n reboot\n󱉚 hibernate\n suspend\n lock\n logout" | rofi -dmenu | awk '{print tolower($2)}')

case $op in
poweroff) ;&
reboot)
  systemctl $op
  ;;
hibernate)
  # hyprlock & sleep 3 && systemctl $op
  systemctl $op
  ;;
suspend)
  # hyprlock & sleep 3 && systemctl $op
  systemctl $op
  ;;
lock)
  # hyprlock
  exec /home/toms/.config/system_resources/swaylockwp.sh
  ;;
logout)
  # hyprctl dispatch exit
  niri msg action quit
  ;;
esac
