import { API_BASE_PATH } from "@adminbot/api-contracts";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  server: {
    host: "127.0.0.1",
    proxy: {
      [API_BASE_PATH]: {
        target: "http://127.0.0.1:8765",
      },
    },
  },
});
