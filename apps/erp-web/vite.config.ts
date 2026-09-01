import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5174 is the POS. Both run side by side during development, and the
    // API's CORS_ORIGIN lists each explicitly.
    port: 5175,
  },
});
