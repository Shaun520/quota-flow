import type { Metadata } from "next";
import RegisterClient from "./RegisterClient";

export const metadata: Metadata = {
  title: "注册 — Quota-Flow",
  description: "注册 Quota-Flow 账号，开始调度多家 AI 视频厂商的免费额度。"
};

export default function RegisterPage() {
  return <RegisterClient />;
}
