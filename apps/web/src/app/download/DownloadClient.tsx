"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download, ShieldCheck, Monitor, Apple, Server } from "lucide-react";
import type { ReleaseInfo } from "./page";

type OS = "Windows" | "macOS" | "Linux";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "Windows";
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Windows";
}

function osLabel(os: OS) {
  switch (os) {
    case "macOS":
      return "下载 macOS 版";
    case "Linux":
      return "下载 Linux 版";
    default:
      return "下载 Windows 安装包";
  }
}

const fallbackRelease: ReleaseInfo = {
  tag: "v0.1.0",
  name: "0.1.0",
  publishedAt: "2026-08-21T00:00:00Z",
  notes: "- 支持 mathmind、qwenwan、yuanbao 三家厂商调度生成\n- 动态额度账本与等效次数换算\n- 账号池化与智能 failover\n- 桌面端基础 UI：调度台、历史、团队、设置\n- 自动更新与代码签名（后续版本完善）"
};

function releaseNotes(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/^[-*…\s]+/, "").trim())
    .filter(Boolean);
}

function formatPublishDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

export default function DownloadClient({ release }: { release: ReleaseInfo | null }) {
  const current = release || fallbackRelease;
  const notes = releaseNotes(current.notes);
  const published = formatPublishDate(current.publishedAt);

  const [os, setOs] = useState<OS>("Windows");

  useEffect(() => {
    setOs(detectOS());
  }, []);

  /** 当前系统对应的直接下载地址；无对应安装包时回退到 GitHub release 列表页 */
  function osDownloadUrl(osName: OS): string {
    if (osName === "macOS" && current.mac) return current.mac;
    if (osName === "Linux" && current.linux) return current.linux;
    if (osName === "Windows" && current.windows) return current.windows;
    return "https://github.com/Shaun520/quota-flow/releases/latest";
  }

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <h1>下载 Quota-Flow</h1>
          <p>桌面端是唯一的创作入口。选择你的系统，几分钟即可完成安装。</p>
        </div>
      </section>

      <section className="download-main">
        <div className="container">
          <div className="download-card">
            <div className="os-detected">
              <ShieldCheck size={14} />
              已检测到你的系统
            </div>
            <h2>{os}</h2>
            <p className="version">
              当前版本 <strong>{current.tag}</strong>{" "}
              {published ? `· 发布于 ${published}` : ""}
            </p>
            <div className="download-actions">
              <a
                href={osDownloadUrl(os)}
                className="btn btn-primary btn-lg"
                rel="noreferrer"
              >
                <Download size={18} />
                {osLabel(os)}
              </a>
              <a
                href="https://github.com/Shaun520/quota-flow/releases"
                className="btn btn-secondary btn-lg"
                target="_blank"
                rel="noreferrer"
              >
                查看所有版本
              </a>
            </div>
            <p className="download-note">
              下载后运行安装程序即可。已安装旧版本的用户可在应用内「设置 → 检查更新」一键升级。
            </p>
          </div>
        </div>
      </section>

      <section className="platforms-section">
        <div className="container">
          <div className="section-title">
            <h2>选择你的平台</h2>
            <p>Windows 是主推平台，macOS 与 Linux 版本同步维护。</p>
          </div>
          <div className="platform-grid">
            <div className="platform-card recommended">
              <div className="platform-badge">推荐</div>
              <div className="platform-icon">
                <Monitor size={26} />
              </div>
              <h3>Windows</h3>
              <p>Windows 10 / 11 64 位<br />安装包约 80 MB</p>
              <a
                href={current.windows || "https://github.com/Shaun520/quota-flow/releases/latest"}
                className="btn btn-primary"
                rel="noreferrer"
              >
                下载安装包
              </a>
            </div>
            <div className="platform-card">
              <div className="platform-icon">
                <Apple size={26} />
              </div>
              <h3>macOS</h3>
              <p>macOS 12 及以上<br />Intel / Apple Silicon 通用</p>
              <a
                href={current.mac || "https://github.com/Shaun520/quota-flow/releases/latest"}
                className="btn btn-secondary"
                rel="noreferrer"
              >
                下载 .dmg
              </a>
            </div>
            <div className="platform-card">
              <div className="platform-icon">
                <Server size={26} />
              </div>
              <h3>Linux</h3>
              <p>Ubuntu / Debian / Fedora<br />AppImage 与 deb 包</p>
              <a
                href={current.linux || "https://github.com/Shaun520/quota-flow/releases/latest"}
                className="btn btn-secondary"
                rel="noreferrer"
              >
                下载 Linux 版
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="install-section">
        <div className="container">
          <div className="section-title">
            <h2>四步开始创作</h2>
            <p>下载、安装、登录、绑定厂商，整个过程不超过 5 分钟。</p>
          </div>
          <div className="steps-grid">
            <div className="step-card">
              <h3>下载安装包</h3>
              <p>根据系统选择对应安装包，双击运行安装向导。</p>
            </div>
            <div className="step-card">
              <h3>完成首次启动</h3>
              <p>打开应用后配置 Supabase 连接，官方托管用户直接登录即可。</p>
            </div>
            <div className="step-card">
              <h3>登录厂商账号</h3>
              <p>在「厂商」Tab 按引导登录各平台，额度将自动归集到账本。</p>
            </div>
            <div className="step-card">
              <h3>一键生成视频</h3>
              <p>回到调度台输入 prompt，系统会为你选择最优厂商并提交生成。</p>
            </div>
          </div>
        </div>
      </section>

      <section className="release-section">
        <div className="container">
          <div className="section-title">
            <h2>最新发布</h2>
            <p>{current.tag} 是当前最新版本，包含核心调度与多家厂商接入。</p>
          </div>
          <div className="release-card">
            <h3>{current.tag}</h3>
            <ul>
              {notes.map((note) => (
                <li key={note}>
                  <span className="dot" />
                  {note}
                </li>
              ))}
            </ul>
            <p style={{ marginTop: 16, fontSize: 14, color: "var(--text-secondary)" }}>
              查看完整更新日志请访问{" "}
              <a
                href="https://github.com/Shaun520/quota-flow/releases"
                target="_blank"
                rel="noreferrer"
              >
                GitHub Releases
              </a>
              。
            </p>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, paddingBottom: 80 }}>
        <div className="container">
          <div className="cta-banner">
            <h2>准备好把免费额度聚成一个池子了吗？</h2>
            <p>下载桌面端，几分钟即可绑定第一家厂商，开始你的第一次智能调度。</p>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
              <a
                href={osDownloadUrl(os)}
                className="btn btn-lg btn-secondary"
                rel="noreferrer"
              >
                立即下载
              </a>
              <Link href="/pricing" className="btn btn-lg btn-outline-white">
                开源免费
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
