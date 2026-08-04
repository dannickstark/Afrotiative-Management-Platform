import { requireUser } from "@/lib/session";
import { SettingsNav } from "@/components/settings/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="space-y-6">
      <SettingsNav role={user.role} />
      {children}
    </div>
  );
}
