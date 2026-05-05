#!/usr/bin/env zsh

export BW_SESSION=$(bw unlock --raw)

eval $(ssh-agent -s -t 1h)

bw_add_sshkeys
