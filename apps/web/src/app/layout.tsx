import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Quota-Flow — 把 9 家 AI 视频厂商的免费额度，聚成一个池子",
  description: "Quota-Flow 是一站式 AI 视频免费额度调度平台。自动归集、智能路由、团队共享，告别反复登录与额度沉睡。",
  icons: {
    icon: "/logo.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
