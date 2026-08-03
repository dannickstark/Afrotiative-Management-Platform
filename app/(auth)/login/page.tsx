import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "@/components/login-form";

export default async function LoginPage() {
  const s = await getSession();
  if (s?.user) redirect("/dashboard");
  return <div className="min-h-screen grid place-items-center bg-muted/30 p-6"><LoginForm /></div>;
}
