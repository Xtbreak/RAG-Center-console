import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "知枢 · 企业知识库中台",
  description: "企业内部知识导入、检索与对话工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
