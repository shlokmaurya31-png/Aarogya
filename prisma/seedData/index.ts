import { cardioRespiratoryCases } from "./cases/cardioRespiratory";
import { endocrineRenalInfectiousCases } from "./cases/endocrineRenalInfectious";
import { surgicalNeuroCases } from "./cases/surgicalNeuro";
import { pedsObgynEmergencyCases } from "./cases/pedsObgynEmergency";
import type { CaseDef } from "./builder";

export const allCaseDefs: CaseDef[] = [
  ...cardioRespiratoryCases,
  ...endocrineRenalInfectiousCases,
  ...surgicalNeuroCases,
  ...pedsObgynEmergencyCases,
];
