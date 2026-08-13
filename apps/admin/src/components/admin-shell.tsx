"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { TopHeader } from "./top-header";

export function AdminShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="main-content">
        <TopHeader onMenuClick={() => setMenuOpen(true)} />
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
