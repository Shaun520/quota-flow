import type { Metadata } from "next";
import DownloadClient from "./DownloadClient";

export const metadata: Metadata = {
  title: "下载 — Quota-Flow",
  description: "下载 Quota-Flow 桌面端，支持 Windows、macOS 与 Linux。几分钟即可完成安装，开始调度你的免费额度。"
};

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string; // ISO 字符串
  notes: string;
  windows?: string; // Windows 安装包直接下载地址
  mac?: string; // macOS 安装包直接下载地址
  linux?: string; // Linux 安装包直接下载地址
}

/** 从 release assets 中按文件名关键词挑选对应平台的安装包下载地址 */
function pickAssetUrl(
  assets: { name: string; browser_download_url: string }[] | undefined,
  match: RegExp
): string | undefined {
  if (!assets) return undefined;
  const asset = assets.find((a) => match.test(a.name));
  return asset?.browser_download_url;
}

async function getLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/Shaun520/quota-flow/releases/latest",
      {
        next: { revalidate: 3600 }, // 缓存 1 小时，减少 GitHub API 请求
        headers: { Accept: "application/vnd.github+json" }
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const assets: { name: string; browser_download_url: string }[] | undefined =
      data?.assets;
    return {
      tag: data?.tag_name || "",
      name: data?.name || "",
      publishedAt: data?.published_at || "",
      notes: data?.body || "",
      // Setup 安装包优先，其次退化为 portable 版；排除 .blockmap/.yml 等辅助文件
      windows:
        pickAssetUrl(assets, /Setup-.*\.exe$/) ||
        pickAssetUrl(assets, /Portable-.*\.exe$/),
      mac: pickAssetUrl(assets, /\.dmg$/),
      linux: pickAssetUrl(assets, /\.(AppImage|deb|rpm)$/)
    };
  } catch {
    return null;
  }
}

export const revalidate = 3600;

export default async function DownloadPage() {
  const release = await getLatestRelease();
  return <DownloadClient release={release} />;
}