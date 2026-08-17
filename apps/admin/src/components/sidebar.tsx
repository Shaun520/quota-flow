"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";

const NAV_SECTIONS: Array<{
  title: string;
  items: Array<{ href: string; label: string; badge?: string; icon: ReactNode }>;
}> = [
  {
    title: "总览",
    items: [
      {
        href: "/dashboard",
        label: "系统监控",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
          </svg>
        )
      }
    ]
  },
  {
    title: "运营管理",
    items: [
      {
        href: "/teams",
        label: "团队管理",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )
      },
      {
        href: "/users",
        label: "用户管理",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        )
      },
      {
        href: "/subscriptions",
        label: "订阅管理",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="2" y1="10" x2="22" y2="10" />
          </svg>
        )
      },
      {
        href: "/creation-videos",
        label: "创作中心视频",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        )
      }
    ]
  },
  {
    title: "配置管理",
    items: [
      {
        href: "/providers",
        label: "Provider 管理",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
        )
      },
      {
        href: "/cost-tables",
        label: "额度扣减规则",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        )
      },
      {
        href: "/desktop-permissions",
        label: "权限控制",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )
      }
    ]
  },
  {
    title: "审计",
    items: [
      {
        href: "/audit",
        label: "审计日志",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        )
      }
    ]
  },
  {
    title: "系统",
    items: [
      {
        href: "/announcements",
        label: "公告通知",
        icon: (
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        )
      }
    ]
  }
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    try {
      const supabase = createAdminBrowserClient();
      await supabase.auth.signOut();
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <>
      <div className={`sidebar-overlay${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`sidebar${open ? " open" : ""}`} id="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <div className="sidebar-title">Quota-Flow</div>
            <div className="sidebar-subtitle">Admin Console</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_SECTIONS.map((section) => {
            const activeItem = section.items.find(
              (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
            );
            return (
              <div className="nav-section" key={section.title}>
                <div className="nav-section-title">{section.title}</div>
                {section.items.map((item) => {
                  const active = activeItem?.href === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`nav-item${active ? " active" : ""}`}
                      onClick={onClose}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                      {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="admin-profile">
            <div className="admin-avatar">OP</div>
            <div className="admin-info">
              <div className="admin-name">平台运营者</div>
              <div className="admin-role">Super Admin</div>
            </div>
            <button className="btn-icon" title="退出登录" type="button" onClick={() => void handleSignOut()}>
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
