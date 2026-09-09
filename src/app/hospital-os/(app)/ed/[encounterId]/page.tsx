import { EdPatientWorkspace } from "@/components/hospital-os/EdPatientWorkspace";

export default async function EdPatientWorkspacePage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;
  return <EdPatientWorkspace encounterId={encounterId} />;
}
