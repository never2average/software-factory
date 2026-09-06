/**
 * The stand-in owner for a ticket nobody has been assigned to yet.
 *
 * `tickets.ticket_owner_email` is NOT NULL and validated as an email, so an
 * unowned ticket still needs one — and the value used to be a real address at
 * one company. Every workspace on the platform therefore filed its untriaged
 * tickets to that company's domain: visible in the tickets list, in the
 * exported workbook, and in any roster lookup that tried to resolve it.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so this is a
 * sentinel that is unmistakably a sentinel — nothing will ever deliver to it,
 * and nobody reading a ticket list will mistake it for a colleague.
 *
 * Callers that want a real owner should resolve one from the workspace roster;
 * this is the value for "we genuinely do not know yet".
 */
export const UNASSIGNED_OWNER_EMAIL = "unassigned@example.invalid";

/** True for the sentinel above — for UI that wants to render "Unassigned". */
export function isUnassignedOwner(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === UNASSIGNED_OWNER_EMAIL;
}
