import { Suspense } from "react";
import { PrototypeApp } from "../../prototype-app";

export default function DetailPage() {
  return <Suspense fallback={<div className="app-loading">正在打开知枢…</div>}><PrototypeApp /></Suspense>;
}
