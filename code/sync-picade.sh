#!/usr/bin/env bash

set -euxo pipefail

#for i in 0 1 2 3 4; do
#  rsync -avrP --delete "root@10.100.0.10$i:/etc/wireguard/" "$HOME/code/picade/picade$i/etc/wireguard"
#  rsync -avrP --delete "root@10.100.0.10$i:/etc/network/interfaces.d/" "$HOME/code/picade/picade$i/etc/network/interfaces.d"
#done

#rsync -avrP --delete "root@10.100.0.100:/etc/apt/sources.list" "$HOME/code/picade/etc/apt/sources.list"
#rsync -avrP --delete "root@10.100.0.100:/etc/apt/sources.list.d/" "$HOME/code/picade/etc/apt/sources.list.d"
#rsync -avrP --delete "root@10.100.0.100:/etc/wpa_supplicant/wpa_supplicant.conf" "$HOME/code/picade/etc/wpa_supplicant/wpa_supplicant.conf"
rsync -avrP --delete "root@10.100.0.100:/root/.ssh/" "$HOME/code/picade/root/.ssh"
#rsync -avrP --delete "pi@10.100.0.100:/home/pi/" "$HOME/code/picade/home/pi"
#rsync -avrP --delete "pi@10.100.0.100:/opt/retropie/configs/" "$HOME/code/picade/opt/retropie/configs"

for i in 0 1 2 3 4; do
  # Shared /etc
#  rsync -avrP --chown root:root "$HOME/code/picade/etc/" "root@10.100.0.10$i:/etc"
  # Picade-specific /etc
#  rsync -avrP --chown root:root "$HOME/code/picade/picade$i/etc/wireguard/" "root@10.100.0.10$i:/etc/wireguard"
#  rsync -avrP --chown root:root "$HOME/code/picade/picade$i/etc/network/interfaces.d/" "root@10.100.0.10$i:/etc/network/interfaces.d"
  # Shared /root, /home, /opt
  rsync -avrP --chown root:root "$HOME/code/picade/root/.ssh/" "root@10.100.0.10$i:/root/.ssh"
#  rsync -avrP --chown pi:users "$HOME/code/picade/home/pi/" "pi@10.100.0.10$i:/home/pi"
#  rsync -avrP --chown pi:users "$HOME/code/picade/opt/retropie/configs/" "pi@10.100.0.10$i:/opt/retropie/configs"
  # Picade-specific /opt
#  rsync -avrP --chown pi:users "$HOME/code/picade/picade$i/opt/retropie/" "root@10.100.0.10$i:/opt/retropie"
done
