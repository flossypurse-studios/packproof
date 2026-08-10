import kleur from 'kleur';
import { TEMPLATE } from './templates/default.js';
export const render = (s) => kleur.bold(TEMPLATE + s);
