import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 相对路径：本地和 GitHub Pages 的子目录（/texas-holdem/）都能用
  base: './',
  server: { port: 5173, strictPort: true },
});
