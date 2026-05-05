#!/usr/bin/env bash

rm ~/.theme-dark
touch ~/.theme-light

notify-send --app-name="theme-switcher" --urgency=low --icon=weather-clear "switching to light mode"

sed -i 's/catppuccin-mocha/catppuccin-latte/g' /home/toms/.config/nvim/lua/plugins/colorscheme.lua
ls "/run/user/1000/" | grep 'nvim.' | while read socket; do
  nvim --server "/run/user/1000/$socket" --remote-send "<esc>:colorscheme catppuccin-latte<cr>"
done

ls "/run/user/1000/" | grep 'nvimtj.' | while read socket; do
  nvim --server "/run/user/1000/$socket" --remote-send "<esc>:set background=light<cr>"
done

ls "/run/user/1000/" | grep 'Alacritty' | while read socket; do
  alacritty msg -s "/run/user/1000/$socket" config "$(cat ~/.config/alacritty/catppuccin-latte.toml)" -w -1
done

killall swaybg && /home/toms/.config/system_resources/swaybg.sh &
killall swayidle && /home/toms/.config/system_resources/swayidle.sh &

gsettings set org.gnome.desktop.interface gtk-theme "Adwaita:light"
gsettings set org.gnome.desktop.interface color-scheme prefer-light

sed -i 's/cdd6f4/7287fd/g' /home/toms/.config/niri/config.kdl
sed -i 's/f5e0dc/dc8a78/g' /home/toms/.config/niri/config.kdl
sed -i 's/515151/bdbdbd/g' /home/toms/.config/niri/config.kdl

echo '@import url("latte.css");' >/home/toms/.config/swaync/style.css
swaync-client -rs

sed -i 's/mocha.css/latte.css/g' /home/toms/.config/waybar/style.css
killall waybar
waybar &
disown

sed -i 's/TwoDark/ansi/g' /home/toms/.config/bat/config

sed -i 's/Mocha/Latte/g' /home/toms/.config/ghostty/config

sed -i 's/catppuccin_mocha/catppuccin_latte/g' /home/toms/.config/helix/config.toml

sed -i 's/catppuccin-mocha/catppuccin-latte/g' /home/toms/.config/rofi/config.rasi

sed -i 's/Dark/Light/g' /home/toms/.config/alacritty/alacritty.toml
