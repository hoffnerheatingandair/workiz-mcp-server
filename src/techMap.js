// Maps Workiz technicians to GHL user ids, so an assigned tech's Workiz
// schedule can block the matching GHL user's calendar availability.
//
// Workiz id: data.team[].id from the real job webhook -- a "USR-..." string,
// NOT the numeric id used by the job/get/ REST API's Team field.
// GHL user id: Settings > My Staff > click the user -- the id is in the URL
// (.../team/<userId>) -- or from GHL's GET /users/ endpoint.
//
// Single source of truth below; WORKIZ_TO_GHL_USER (by id, primary) and
// WORKIZ_NAME_TO_GHL_USER (by name, fallback if the id doesn't match -- e.g.
// Workiz re-issues a user id) are both derived from this list.
const TECHS = [
  { workizId: "USR-G8ye2JvdggXxgAdj", name: "Todd Kinsey", ghlUserId: "RQtU4GbsnXBX7jWFcoLM" },
  { workizId: "USR-DvjZwLkyYmWMmVBA", name: "James Pfeiffer", ghlUserId: "fIsUSGmNaJcr6xhl8wCQ" },
  { workizId: "USR-70BYwLyqGmqLqWXp", name: "James Madison", ghlUserId: "8RSnCm8Bpllo0fhkTM82" },
];

export const WORKIZ_TO_GHL_USER = Object.fromEntries(TECHS.map((t) => [t.workizId, t.ghlUserId]));

export const WORKIZ_NAME_TO_GHL_USER = Object.fromEntries(
  TECHS.map((t) => [t.name.toLowerCase(), t.ghlUserId])
);
