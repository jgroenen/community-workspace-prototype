import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relatieve asset-paden i.p.v. absolute (/assets/...): zo werkt de build
  // zowel lokaal als op een GitHub Pages-project-URL
  // (https://<user>.github.io/<repo>/) zonder dat we de repo-naam hier
  // hoeven te kennen. De app gebruikt toch al hash-routing (#<kanaal-id>),
  // dus er is geen server-side rewrite nodig voor deep links.
  base: './',
  server: {
    port: 5173,
  },
});
