import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client', // Set the root to the 'client' directory
  build: {
    outDir: '../dist', // Output build files to a top-level 'dist' directory
  },
  server: {
    port: 3000, // Run the dev server on port 3000
  },
});
