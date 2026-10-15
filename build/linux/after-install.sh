#!/bin/sh
# Lets the logged-in user talk to keyboards' raw-HID interfaces (needed for
# WebHID on Linux). "uaccess" limits access to the user at the seat.
cat > /etc/udev/rules.d/50-keyboard-lighting.rules <<'RULES'
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", MODE="0660", TAG+="uaccess"
RULES
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
