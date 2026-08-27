// supports-color is declared. has-flag is not: it is only here because
// supports-color depends on it and npm hoisted it to the top level. Under
// pnpm, Yarn PnP or npm --install-strategy=nested this import throws.
import supportsColor from 'supports-color';
import hasFlag from 'has-flag';

export function colorful() {
  return Boolean(supportsColor.stdout) && hasFlag('color');
}
