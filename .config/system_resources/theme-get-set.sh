#!/usr/bin/env bash

if [ -e ~/.theme-light ]; then
	/home/toms/.config/system_resources/theme-dark.sh
else
	/home/toms/.config/system_resources/theme-light.sh
fi
