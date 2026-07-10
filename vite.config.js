import { defineConfig } from 'vite';
import { storiesPlugin } from './tools/vite-plugin-stories.js';

export default defineConfig({
  plugins: [storiesPlugin()],
});
