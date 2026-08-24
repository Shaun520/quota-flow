import type { Metadata } from "next";
import DocsClient from "./DocsClient";

export const metadata: Metadata = {
  title: "文档 — Quota-Flow",
  description: "Quota-Flow 文档中心。从下载安装到自部署，从厂商接入到团队共享，这里有你需要的全部指南。"
};

export default function DocsPage() {
  return <DocsClient />;
}
