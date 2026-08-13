import { PrototypePage } from "@/components/prototype-page";
import { PROTOTYPE_PAGE_HTML } from "@/lib/prototype-pages";

export default function DashboardPage() {
  return <PrototypePage html={PROTOTYPE_PAGE_HTML["dashboard"]} />;
}
