import { defineConfig } from "vite";
import { resolve } from "node:path";
import copy from "rollup-plugin-copy";

export default defineConfig({
  publicDir: false,
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    cssMinify: true,

    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },

    rollupOptions: {
      output: {
        dir: "dist",
        preserveModules: true,
        preserveModulesRoot: "src",
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "style[extname]",
      },
    },
  },

  resolve: {
    alias: {
      styles: resolve(__dirname, "src/styles"),
    },
    mainFields: ["browser", "module", "jsnext:main", "jsnext"],
    conditions: ["browser"],
  },

  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      } as any,
    },
  },

  plugins: [
    copy({
      targets: [
        { src: "src/module.json", dest: "dist" },
        { src: "src/templates", dest: "dist" },
        { src: "src/assets", dest: "dist" },
      ],
      hook: "writeBundle",
    }),
  ]
});
