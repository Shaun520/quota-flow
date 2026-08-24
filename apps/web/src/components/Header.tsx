"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, Github, Menu, X } from "lucide-react";

interface HeaderProps {
  variant?: "default" | "transparent";
}

export default function Header({ variant = "default" }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand">
          <img src="/logo.svg" alt="Quota-Flow" className="brand-logo" />
          Quota-Flow
        </Link>

        <nav className="nav-links">
          <Link href="/#features">特性</Link>
          <Link href="/#vendors">厂商</Link>
          <Link href="/#how">原理</Link>
          <Link href="/pricing">开源免费</Link>
          <Link href="/docs">文档</Link>
          <a href="https://github.com/Shaun520/quota-flow" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>

        <div className="header-cta">
          <Link href="/pricing" className="btn btn-secondary">
            开源免费
          </Link>
          <Link href="/download" className="btn btn-primary">
            <Download size={16} />
            免费下载
          </Link>
        </div>

        <button
          className="mobile-menu-btn btn-ghost"
          aria-label="菜单"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {mobileOpen && (
        <div className="container" style={{ paddingBottom: 16 }}>
          <nav style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Link href="/#features" className="btn btn-ghost" onClick={() => setMobileOpen(false)}>
              特性
            </Link>
            <Link href="/#vendors" className="btn btn-ghost" onClick={() => setMobileOpen(false)}>
              厂商
            </Link>
            <Link href="/#how" className="btn btn-ghost" onClick={() => setMobileOpen(false)}>
              原理
            </Link>
            <Link href="/pricing" className="btn btn-ghost" onClick={() => setMobileOpen(false)}>
              开源免费
            </Link>
            <Link href="/docs" className="btn btn-ghost" onClick={() => setMobileOpen(false)}>
              文档
            </Link>
            <a
              href="https://github.com/Shaun520/quota-flow"
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost"
            >
              <Github size={16} />
              GitHub
            </a>
            <Link href="/download" className="btn btn-primary" onClick={() => setMobileOpen(false)}>
              <Download size={16} />
              免费下载
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
