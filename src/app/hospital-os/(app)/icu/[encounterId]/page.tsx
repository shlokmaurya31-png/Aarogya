import { IcuWorkspace } from "@/components/hospital-os/IcuWorkspace";

export default async function IcuWorkspacePage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;
  return <IcuWorkspace encounterId={encounterId} />;
}
