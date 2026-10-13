import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import { resolveLoginDestination } from "@/lib/auth/roleDestination";
import { ChangePasswordForm } from "@/components/auth/PasswordForms";

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <ChangePasswordForm displayName={user.displayName} backHref={resolveLoginDestination(user.role)} />;
}
