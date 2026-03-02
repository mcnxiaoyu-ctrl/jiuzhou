import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

/**
 * 作用：统一定义“图片资源”文件后缀匹配规则，避免构建流程中重复维护同类判断逻辑。
 * 不做什么：不参与 JS/CSS chunk 命名，不参与业务资源路径拼接。
 * 输入/输出：输入为产物文件名字符串，输出为是否命中图片后缀的布尔结果。
 * 数据流/状态流：由构建插件在 `generateBundle` 阶段读取该规则并决定是否删除对应资产。
 * 关键边界条件与坑点：
 * 1. 仅覆盖常见图片后缀（png/jpg/jpeg/gif/svg/webp/avif/ico），不包含字体等其它静态资源。
 * 2. 使用大小写不敏感匹配，避免文件名大小写差异导致遗漏。
 */
const IMAGE_ASSET_EXT_REGEXP = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i;

/**
 * 作用：在“无图片构建模式”下集中删除 Rollup 图片资产，确保 dist 中不产出图片文件。
 * 不做什么：不处理业务代码逻辑，不改动 JS/CSS 的分包策略与命名规则。
 * 输入/输出：输入 `enabled`（是否启用无图片模式），输出 Vite 插件对象或 `false`。
 * 数据流/状态流：Vite 构建 -> Rollup `generateBundle` -> 遍历产物 -> 删除命中的图片 asset。
 * 关键边界条件与坑点：
 * 1. 仅删除 `asset` 类型且文件名命中图片后缀的产物，避免误删代码 chunk。
 * 2. 插件通过 `apply: "build"` 仅在构建阶段生效，不影响 `vite dev`。
 */
function createStripImageAssetsPlugin(enabled: boolean): PluginOption {
  if (!enabled) {
    return false;
  }

  return {
    name: "strip-image-assets",
    apply: "build",
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const outputArtifact = bundle[fileName];
        if (
          outputArtifact.type === "asset" &&
          IMAGE_ASSET_EXT_REGEXP.test(fileName)
        ) {
          delete bundle[fileName];
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const analyze = env.ANALYZE === "true";
  const disableImageAssets = mode === "no-image";

  return {
    plugins: [
      react(),
      analyze &&
        visualizer({
          filename: "dist/stats.html",
          open: false,
          gzipSize: true,
        }),
      createStripImageAssetsPlugin(disableImageAssets),
    ].filter(Boolean),
    base: "/",
    server: {
      host: true,
    },
    build: {
      copyPublicDir: !disableImageAssets,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          // 基于模块路径的智能分包策略
          manualChunks(id) {
            if (id.includes("node_modules")) {
              // Ant Design 全家桶（图标、组件、rc-*）
              if (
                id.includes("antd") ||
                id.includes("@ant-design") ||
                id.includes("rc-")
              ) {
                return "antd-vendor";
              }
              // React 核心
              if (
                id.includes("react-dom") ||
                id.includes("node_modules/react/")
              ) {
                return "react-vendor";
              }
              // 路由
              if (id.includes("react-router")) {
                return "router";
              }
              // 网络相关
              if (id.includes("socket.io") || id.includes("axios")) {
                return "network";
              }
            }
          },
        },
      },
    },
  };
});
