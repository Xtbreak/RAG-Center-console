import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // rewrite 代理默认只缓冲 10MB 请求体，超出会截断上传；单文件上限 100MB，另留 multipart 开销
    proxyClientMaxBodySize: "101mb",
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000"}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
