// A softer 256-color palette than the saturated ANSI primaries. The dashboard
// uses a 256-color terminal profile by default so these semantic tones remain
// consistent across modern native, SSH, and web terminal frontends.
export const COLOR = Object.freeze({
  black: 16,       // #000000
  bright: 231,     // #ffffff
  text: 252,       // #d0d0d0
  secondary: 250,  // #bcbcbc
  muted: 245,      // #8a8a8a
  frame: 243,      // #767676
  accent: 81,      // #5fd7ff
  accentSoft: 80,  // #5fd7d7
  success: 78,     // #5fd787
  warning: 221,    // #ffd75f
  danger: 203,     // #ff5f5f
  blue: 75,        // #5fafff
  magenta: 177,    // #d787ff
  orange: 215,     // #ffaf5f
  lime: 156,       // #afff87
});

const TONE_ALIASES = Object.freeze({
  white: COLOR.text,
  gray: COLOR.muted,
  cyan: COLOR.accent,
  green: COLOR.success,
  yellow: COLOR.warning,
  red: COLOR.danger,
  blue: COLOR.blue,
  magenta: COLOR.magenta,
});

export function resolveUiColor(value) {
  return TONE_ALIASES[value] ?? value;
}
