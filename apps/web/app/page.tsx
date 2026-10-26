import { Suspense } from "react";
import { PrototypeApp } from "./prototype-app";

export default function Home() {
  return <Suspense fallback={<div className="app-loading">正在打开知识库中台…</div>}><PrototypeApp /></Suspense>;
}
