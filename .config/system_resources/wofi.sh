if [ -e ~/.theme-light ]; then
	wofi -s /home/toms/.config/wofi/style-light.css $@
else
	wofi $@
fi
