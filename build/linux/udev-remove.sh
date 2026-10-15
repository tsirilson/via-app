
# --- Keyboard Lighting: remove the raw-HID udev rule.
rm -f /etc/udev/rules.d/50-keyboard-lighting.rules
udevadm control --reload-rules 2>/dev/null || true
