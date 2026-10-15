/** CDS works from California: business dates (price start dates) are Pacific dates. */
const pacificDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Today's date in California as "YYYY-MM-DD", the same date the database uses for prices
 * (private.today()). Use it for every "today" in a price query.
 */
export function pacificToday(now: Date = new Date()): string {
  return pacificDate.format(now);
}
