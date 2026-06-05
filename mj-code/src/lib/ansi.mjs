const ESC = "[";
const RESET = "[0m";

function wrap(code, value, enabled) {
  return enabled ? `${code}${value}${RESET}` : value;
}

export function createAnsi(enabled) {
  return {
    enabled,
    reset: RESET,
    saveCursor() {
      return enabled ? `${ESC}s` : "";
    },
    restoreCursor() {
      return enabled ? `${ESC}u` : "";
    },
    clearLine() {
      return enabled ? `${ESC}2K` : "";
    },
    eraseDown() {
      return enabled ? `${ESC}J` : "";
    },
    hideCursor() {
      return enabled ? `${ESC}?25l` : "";
    },
    showCursor() {
      return enabled ? `${ESC}?25h` : "";
    },
    cursorUp(count = 1) {
      return enabled ? `${ESC}${Math.max(1, count)}A` : "";
    },
    cursorDown(count = 1) {
      return enabled ? `${ESC}${Math.max(1, count)}B` : "";
    },
    moveToColumn(count = 1) {
      return enabled ? `${ESC}${Math.max(1, count)}G` : "";
    },
    bold(value) {
      return wrap(`${ESC}1m`, value, enabled);
    },
    dim(value) {
      return wrap(`${ESC}2m`, value, enabled);
    },
    italic(value) {
      return wrap(`${ESC}3m`, value, enabled);
    },
    underline(value) {
      return wrap(`${ESC}4m`, value, enabled);
    },
    cyan(value) {
      return wrap(`${ESC}36m`, value, enabled);
    },
    brightCyan(value) {
      return wrap(`${ESC}96m`, value, enabled);
    },
    blue(value) {
      return wrap(`${ESC}34m`, value, enabled);
    },
    brightBlue(value) {
      return wrap(`${ESC}94m`, value, enabled);
    },
    green(value) {
      return wrap(`${ESC}32m`, value, enabled);
    },
    brightGreen(value) {
      return wrap(`${ESC}92m`, value, enabled);
    },
    yellow(value) {
      return wrap(`${ESC}33m`, value, enabled);
    },
    brightYellow(value) {
      return wrap(`${ESC}93m`, value, enabled);
    },
    red(value) {
      return wrap(`${ESC}31m`, value, enabled);
    },
    brightRed(value) {
      return wrap(`${ESC}91m`, value, enabled);
    },
    magenta(value) {
      return wrap(`${ESC}35m`, value, enabled);
    },
    brightMagenta(value) {
      return wrap(`${ESC}95m`, value, enabled);
    },
    white(value) {
      return wrap(`${ESC}37m`, value, enabled);
    },
    brightWhite(value) {
      return wrap(`${ESC}97m`, value, enabled);
    },
    bgBlack(value) {
      return wrap(`${ESC}40m`, value, enabled);
    },
    bgBlue(value) {
      return wrap(`${ESC}44m`, value, enabled);
    },
    bgMagenta(value) {
      return wrap(`${ESC}45m`, value, enabled);
    },
    bgCyan(value) {
      return wrap(`${ESC}46m`, value, enabled);
    },
    rgb(r, g, b, value) {
      if (!enabled) return value;
      return `${ESC}38;2;${r};${g};${b}m${value}${RESET}`;
    },
    bgRgb(r, g, b, value) {
      if (!enabled) return value;
      return `${ESC}48;2;${r};${g};${b}m${value}${RESET}`;
    },
  };
}
