// Maps Workiz technician ids (from a job's Team array) to GHL user ids, so
// an assigned tech's Workiz schedule can block the matching GHL user's
// calendar availability.
//
// Workiz tech id: the `id` in a job's Team array, or from workiz_list_team.
// GHL user id: Settings > My Staff > click the user -- the id is in the URL
// (.../team/<userId>) -- or from GHL's GET /users/ endpoint.
//
// Fill in real GHL user ids below as they're provided; entries with a null
// value are skipped (logged as unmapped) rather than sent to GHL.
export const WORKIZ_TO_GHL_USER = {
  "443756": "RQtU4GbsnXBX7jWFcoLM", // Todd Kinsey
  "390374": "fIsUSGmNaJcr6xhl8wCQ", // James Pfeiffer
  "406784": "8RSnCm8Bpllo0fhkTM82", // James Madison
};
