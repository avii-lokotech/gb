// vite build, with vite.config.js imported by Node instead of by Vite's CLI: the CLI writes a bundled copy of
// the config next to it, which fails on the read-only checkout of the local containers.
import { build } from 'vite';
import config from './vite.config.js';

await build({ ...config, configFile: false });
