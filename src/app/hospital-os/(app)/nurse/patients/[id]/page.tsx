import { NursingWorkspace } from "@/components/hospital-os/NursingWorkspace";

export default async function NursingWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NursingWorkspace patientId={id} />;
}
