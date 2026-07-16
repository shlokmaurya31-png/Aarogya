import { vitals } from "@/lib/mock-data";
import { VitalCard } from "./VitalCard";

export function VitalsGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {vitals.map((v, i) => (
        <VitalCard key={v.id} vital={v} delay={0.1 + i * 0.06} />
      ))}
    </div>
  );
}
