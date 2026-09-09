/**
 * PACS integration BOUNDARY (Phase B7, brief §24-25). This is the clean domain
 * seam a real PACS/DICOM connector would slot into later — it is NOT a PACS, a
 * DICOM server, or an image store. No image bytes are ever handled here. The
 * default implementation is a local, deterministic no-op adapter suitable for
 * development: it echoes back the identifiers the technologist recorded and a
 * synthetic reference handle, and never claims images exist that don't.
 *
 * A production deployment provides its own PacsAdapter (e.g. a DICOMweb/WADO or
 * vendor-API implementation) without touching any calling code.
 */
export interface PacsStudyRegistration {
  facilityId: string;
  accessionNumber: string;
  studyInstanceUid?: string;
  seriesUid?: string;
  modality: string;
}

export interface PacsRegistrationResult {
  pacsReference: string;
  imageAvailability: "NONE" | "PENDING" | "AVAILABLE";
}

export interface PacsAdapter {
  /** Register a performed study with the (future) PACS and get back an opaque reference handle. */
  registerStudy(input: PacsStudyRegistration): Promise<PacsRegistrationResult>;
  /** Query whether images for a reference are available in the external PACS. */
  checkAvailability(pacsReference: string): Promise<"NONE" | "PENDING" | "AVAILABLE">;
}

/**
 * Local no-op adapter — the only implementation wired up in development. It
 * produces a stable, non-clinical reference string and reports availability as
 * PENDING (images were acquired locally but no real PACS confirms them). It
 * deliberately never returns AVAILABLE, so the UI never implies a functioning
 * PACS that Aarogya does not have.
 */
export const localPacsAdapter: PacsAdapter = {
  async registerStudy(input) {
    const uid = input.studyInstanceUid ?? `local.${input.facilityId.slice(-6)}.${input.accessionNumber}`;
    return { pacsReference: `local-pacs://${input.facilityId}/${input.accessionNumber}#${uid}`, imageAvailability: "PENDING" };
  },
  async checkAvailability() {
    return "PENDING";
  },
};

let activeAdapter: PacsAdapter = localPacsAdapter;
export function getPacsAdapter(): PacsAdapter {
  return activeAdapter;
}
/** Test/production hook to swap the adapter without touching callers. */
export function setPacsAdapter(adapter: PacsAdapter): void {
  activeAdapter = adapter;
}
