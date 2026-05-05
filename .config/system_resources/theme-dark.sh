#!/usr/bin/env bash

rm ~/.theme-light
touch ~/.theme-dark

notify-send --app-name="theme-switcher" --urgency=low --icon=weather-clear-night "switching to dark mode"

sed -i 's/catppuccin-latte/catppuccin-mocha/g' /home/toms/.config/nvim/lua/plugins/colorscheme.lua
ls "/run/user/1000/" | grep 'nvim' | while read socket; do
  nvim --server "/run/user/1000/$socket" --remote-send "<esc>:colorscheme catppuccin-mocha<cr>"
done

ls "/run/user/1000/" | grep 'nvimtj.' | while read socket; do
  nvim --server "/run/user/1000/$socket" --remote-send "<esc>:set background=dark<cr>"
done

ls "/run/user/1000/" | grep 'Alacritty' | while read socket; do
  alacritty msg -s "/run/user/1000/$socket" config "$(cat ~/.config/alacritty/catppuccin-mocha.toml)" -w -1
done

killall swaybg && /home/toms/.config/system_resources/swaybg.sh &
killall swayidle && /home/toms/.config/system_resources/swayidle.sh &

gsettings set org.gnome.desktop.interface gtk-theme "Adwaita:dark"
gsettings set org.gnome.desktop.interface color-scheme prefer-dark

sed -i 's/7287fd/cdd6f4/g' /home/toms/.config/niri/config.kdl
sed -i 's/dc8a78/f5e0dc/g' /home/toms/.config/niri/config.kdl
sed -i 's/bdbdbd/515151/g' /home/toms/.config/niri/config.kdl

echo '@import url("mocha.css");' >/home/toms/.config/swaync/style.css
swaync-client -rs

sed -i 's/latte.css/mocha.css/g' /home/toms/.config/waybar/style.css
killall waybar
waybar &
disown

sed -i 's/ansi/TwoDark/g' /home/toms/.config/bat/config

sed -i 's/Latte/Mocha/g' /home/toms/.config/ghostty/config

sed -i 's/catppuccin_latte/catppuccin_mocha/g' /home/toms/.config/helix/config.toml

sed -i 's/catppuccin-latte/catppuccin-mocha/g' /home/toms/.config/k9s/config.yaml

sed -i 's/catppuccin-latte/catppuccin-mocha/g' /home/toms/.config/rofi/config.rasi

sed -i 's/Light/Dark/g' /home/toms/.config/alacritty/alacritty.toml
