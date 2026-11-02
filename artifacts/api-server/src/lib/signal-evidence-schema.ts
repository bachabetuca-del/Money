import { GetKalshiSignalsResponse } from "@workspace/api-zod";

// The same contract validates persisted evidence and owner-only responses.
export const signalEvidenceSchema = GetKalshiSignalsResponse.shape.rows.element.shape.evidence;
