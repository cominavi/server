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
  vite: {
    build: {
      sourcemap: "hidden",
    },
    plugins: [
      {
        // The test identity provider (src/lib/server/test-identity-provider.ts)
        // is compiled only into staging builds and the local dev server.
        // Production builds get `false`, which drops the route from the bundle.
        name: "cominavi-test-identity-provider-flag",
        config(_config, { command }) {
          const enabled =
            command === "serve" || process.env.CLOUDFLARE_ENV === "staging";
          return {
            define: {
              __COMINAVI_TEST_IDENTITY_PROVIDER__: JSON.stringify(enabled),
            },
          };
        },
      },
    ],
  },
  adapter: cloudflare({
    imageService: "compile",
  }),
  integrations: [react()],
});
