import type { Metadata } from "next";
import DownloadClient from "./DownloadClient";

export const metadata: Metadata = {
  title: "下载 — Quota-Flow",
  description: "下载 Quota-Flow 桌面端，支持 Windows、macOS 与 Linux。几分钟即可完成安装，开始调度你的免费额度。"
};

export default function DownloadPage() {
  return <DownloadClient />;
}
