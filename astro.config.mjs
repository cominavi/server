// @ts-check
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://cominavi.net",
  build: {
    redirects: false,
  },
  adapter: cloudflare({
    imageService: "compile",
  }),
  integrations: [react()],
});
