import { CaseFeed } from "@/components/student/CaseFeed";

export default function StudentEmergencyPage() {
  return (
    <CaseFeed
      presetAcuity="EMERGENCY"
      title="Emergency Arena"
      subtitle="Time-critical simulated scenarios. Prioritize ABCDE, recognize red flags, and sequence stabilization correctly."
    />
  );
}
