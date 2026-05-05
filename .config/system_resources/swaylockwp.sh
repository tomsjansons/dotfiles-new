if ! pgrep -x 'swaylock' >/dev/null; then
  if [ -e ~/.theme-light ]; then
    swaylock -f -i /home/toms/.config/system_resources/view-light.jpg
  else
    swaylock -f -i /home/toms/.config/system_resources/view-dark.jpg
  fi
fi
