# 浏览器兼容构建

项目通过根目录 `.browserslistrc` 将 Chrome 79 加入 JavaScript / CSS 构建目标，避免首页及懒加载 bundle 中保留该版本无法解析的可选链（`?.`）、空值合并（`??`）等语法。开发和生产构建共用此配置，无需降低 `tsconfig.json` 的 `target`；最终浏览器产物由 Angular CLI 按 Browserslist 转换。

修改配置后需重启开发服务器，或执行 `npm run build:prod` 并部署 `dist/aily-blockly/browser` 的完整内容。仅更新源码或单个脚本不会改变已部署的旧产物。

这个配置只提供语法转换，不代表 Angular 19 官方支持 Chrome 79，也不会补齐浏览器运行时 API。`angular.json` 中通过 assets 原样复制的脚本（例如 `assets/vs` 下的 Monaco）不经过转换，需要另行验证。真实 Chrome 79 上仍需验证登录、编辑器及设备连接等功能。

Angular 浏览器支持说明：https://angular.dev/reference/versions#browser-support
