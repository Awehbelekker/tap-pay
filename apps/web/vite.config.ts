import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", ["VITE_"]);
  const name = env.VITE_PRODUCT_NAME || "Tap to pay";
  return {
    envDir: "../..",
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icon.svg"],
        manifest: {
          name,
          short_name: name,
          description: "Create bills and see payments live.",
          theme_color: "#0f766e",
          background_color: "#ffffff",
          display: "standalone",
          start_url: "/",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
        },
        workbox: {
          // Offline shell only. Bill creation needs a connection (SPEC 15); never cache /v1 API calls.
          navigateFallbackDenylist: [/^\/v1\//, /^\/t\//, /^\/b\//, /^\/r\//],
        },
      }),
    ],
    server: { port: 5173 },
  };
});
