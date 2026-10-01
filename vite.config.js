import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Relative asset paths make the build work well
  // on GitHub Pages and inside a Wix embed.
  base: './',
})