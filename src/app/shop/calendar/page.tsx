import Link from "next/link";
import { calendarEntries, monthLabel, monthWeeks, parseMonth, shiftMonth, type CalendarEntry } from "@/components/shop/calendar";
import { queueHref } from "@/components/shop/JobQueue";
import styles from "@/components/shop/shop.module.css";
import { TAB_STATUSES, tabForStatus } from "@/components/shop/types";
import { requireShop } from "@/lib/auth";
import { pacificToday } from "@/lib/dates";
import { pickupWindowLabel, woLabel } from "@/lib/format";
import { weekdayOf } from "@/lib/pickup";
import { loadCalendar } from "../data";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Entry({ e }: { e: CalendarEntry }) {
  const done = TAB_STATUSES.completed.includes(e.status);
  return (
    <Link
      href={queueHref(tabForStatus(e.status), "", e.id)}
      className={`${styles.calEntry} ${e.kind === "received" ? styles.calEntryReceived : ""} ${done ? styles.calEntryDone : ""}`}
    >
      <strong className={styles.nowrap}>{woLabel(e.wo_number)}</strong>{" "}
      {e.kind === "pickup" ? <>Pickup {pickupWindowLabel(e.window)}</> : <>Received</>}
      <div>
        {e.customer_name} - {e.location_label}
        {e.unit_number && <> • Unit {e.unit_number}</>}
      </div>
    </Link>
  );
}

export default async function ShopCalendarPage({ searchParams }: PageProps<"/shop/calendar">) {
  await requireShop();
  const params = await searchParams;
  const raw = Array.isArray(params.month) ? params.month[0] : params.month;
  const today = pacificToday();
  const month = parseMonth(raw, today);
  const days = calendarEntries(await loadCalendar(month), month);
  const monthHref = (m: string) => `/shop/calendar?month=${m}`;

  return (
    <>
      <div className="title">
        <h1>Calendar</h1>
        <p>Pickup jobs on the pickup day you chose, shipped jobs on the day the parts arrived. Jobs without a date are not shown.</p>
      </div>
      <section className="section">
        <div className={styles.calNav}>
          <h3>{monthLabel(month)}</h3>
          <Link className="btn btn-secondary btn-small" href={monthHref(shiftMonth(month, -1))} aria-label="Previous month">
            ← Prev
          </Link>
          <Link className="btn btn-secondary btn-small" href={monthHref(today.slice(0, 7))}>
            Today
          </Link>
          <Link className="btn btn-secondary btn-small" href={monthHref(shiftMonth(month, 1))} aria-label="Next month">
            Next →
          </Link>
          <Link className="link" href="/shop" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontWeight: 700 }}>
            Job list
          </Link>
        </div>
        <p className="small" style={{ marginTop: 0 }}>
          <span className="tag green">Pickup</span> <span className="tag blue">Received</span> Dates are Pacific time.
        </p>

        <div className={styles.calGrid}>
          {WEEKDAYS.map((d) => (
            <div key={d} className={styles.calWeekday}>
              {d}
            </div>
          ))}
          {monthWeeks(month)
            .flat()
            .map((day, i) =>
              day ? (
                <div
                  key={day}
                  className={`${styles.calCell} ${day === today ? styles.calToday : ""}`}
                  aria-current={day === today ? "date" : undefined}
                >
                  <div className={styles.calDayNum}>{Number(day.slice(8))}</div>
                  {(days.get(day) ?? []).map((e) => (
                    <Entry key={`${e.kind}-${e.id}`} e={e} />
                  ))}
                </div>
              ) : (
                <div key={`pad-${i}`} className={`${styles.calCell} ${styles.calCellOut}`} />
              ),
            )}
        </div>

        <div className={styles.calList}>
          {[...days.entries()].map(([day, entries]) => (
            <div key={day}>
              <h4 className={styles.calListDay}>
                {weekdayOf(day)} {day}
                {day === today && " (today)"}
              </h4>
              {entries.map((e) => (
                <Entry key={`${e.kind}-${e.id}`} e={e} />
              ))}
            </div>
          ))}
        </div>
        {days.size === 0 && (
          <p className="small" style={{ marginBottom: 0 }}>
            No jobs with a date in {monthLabel(month)}.
          </p>
        )}
      </section>
    </>
  );
}
