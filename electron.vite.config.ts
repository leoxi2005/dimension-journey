import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // grandiose + ws là native/CJS — không được bundle vào out/main.
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        external: ['@stagetimerio/grandiose', 'ws']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          control: resolve(__dirname, 'src/renderer/control/index.html'),
          wall: resolve(__dirname, 'src/renderer/wall/index.html'),
          floor: resolve(__dirname, 'src/renderer/floor/index.html')
        }
      }
    }
  }
})
