#!/usr/bin/env bash

if [ -e ~/.theme-light ]; then
  /usr/bin/alacritty -o "$(cat ~/.config/alacritty/catppuccin-latte.toml)" "$@"
else
  /usr/bin/alacritty -o "$(cat ~/.config/alacritty/catppuccin-mocha.toml)" "$@"
fi
