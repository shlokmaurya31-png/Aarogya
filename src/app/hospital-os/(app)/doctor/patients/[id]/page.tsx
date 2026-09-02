import { PatientChart } from "@/components/hospital-os/PatientChart";

export default async function PatientChartPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PatientChart patientId={id} />;
}
