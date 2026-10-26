# 企业知识库中台

企业内部使用的通用知识库中台 1.0，目标是完成模型配置、知识导入、知识库构建、自动选库、混合检索、在线对话、引用和运行日志的完整闭环。

## 当前阶段

阶段 1：可点击高保真前端原型，已完成实现与自测，等待用户确认。

阶段状态和验收记录以 `DEVELOPMENT_WORKFLOW.md` 为唯一依据。前端原型未经用户确认，不进入后端开发。

## 开发文档

- [开发计划](./DEVELOPMENT_PLAN.md)
- [开发流程与进度](./DEVELOPMENT_WORKFLOW.md)

## 当前工程

- Python 包：`src/rag_center_console`
- 前端原型：阶段 1 建立于 `apps/web`

## 本地启动

前置要求：Node.js 20.9 或更高版本。

```bash
cd apps/web
npm install
npm run dev
```

浏览器访问 `http://localhost:3000`。当前版本仅使用模拟数据；阶段 1 经用户确认前，不开始后端与基础设施开发。

质量检查：

```bash
cd apps/web
npm run typecheck
npm run build
```
