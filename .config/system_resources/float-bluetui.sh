#!/usr/bin/env bash

systemctl is-active --quiet bluetooth.service || systemctl start bluetooth.service

ghostty --class=ghostty.float.bluetui -e bluetui
