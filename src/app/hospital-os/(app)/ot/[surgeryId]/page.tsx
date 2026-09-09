import { SurgicalWorkspace } from "@/components/hospital-os/SurgicalWorkspace";

export default async function SurgicalWorkspacePage({ params }: { params: Promise<{ surgeryId: string }> }) {
  const { surgeryId } = await params;
  return <SurgicalWorkspace surgeryId={surgeryId} />;
}
