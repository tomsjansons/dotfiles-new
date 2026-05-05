#!usr/bin/env bun

import { $, file } from "bun";

const INTERVAL = 30;
const MIN_BAT = 10;
const MAX_BAT = 80;
const CRIT_BAT = 3;

async function getPluggedState() {
  const output: string = await file(
    "/sys/bus/acpi/drivers/battery/PNP0C0A:00/power_supply/BAT0/status",
  ).text();
  const state = output.split("\n")[0];
  return state;
}

async function getBatteryLevel() {
  await $`acpi`;
  const output: string = await $`acpi`.text();
  const percentStr = output.split(" ")[3].split("%")[0];
  const percent = Number(percentStr);
  return percent;
}

while (true) {
  const batPercent = await getBatteryLevel();
  const pluggedState = await getPluggedState();

  const markerFile = file("/tmp/battery-check-marker");

  if (pluggedState === "Discharging") {
    if (await markerFile.exists()) {
      await $`rm /tmp/battery-check-marker`;
    }
    if (batPercent < CRIT_BAT) {
      await $`notify-send -u critical -i /home/toms/.config/system_resources/icons8-sleep-50.png "Battery critical - hibernating"`;
      await $`systemctl hibernate`;
    } else if (batPercent < MIN_BAT) {
      await $`notify-send -u critical -i /home/toms/.config/system_resources/icons8-android-l-battery-64.png "Battery below ${MIN_BAT}"`;
    }
  }
  if (pluggedState === "Charging" && batPercent > MAX_BAT) {
    if (!(await markerFile.exists())) {
      await $`notify-send -u critical -i /home/toms/.config/system_resources/icons8-full-battery-64.png "Battery above ${MAX_BAT}"`;
      await $`touch /tmp/battery-check-marker`;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, INTERVAL * 1000));
}
