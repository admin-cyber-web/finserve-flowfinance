import {
  MEETING_DAYS,
  formatMeetingDate,
  fromDateInputValue,
  istWeekday,
  toDateInputValue,
  type MeetingDay,
} from "@/lib/meeting";
import { CalendarDays, TriangleAlert } from "lucide-react";

/**
 * A + B — the MANUAL centre meeting schedule for a new loan.
 *
 * The Admin or Branch Manager picks the meeting day and independently picks
 * the first meeting date. Nothing here is derived from the disbursement date,
 * nothing is pre-selected, and nothing is overwritten after the user chooses:
 * both controls stay editable until the loan is submitted, and neither value
 * is ever changed by the other one.
 */
export function MeetingSchedulePicker({
  meetingDay,
  firstMeetingDate,
  onChange,
  disabled,
  className = "",
}: {
  meetingDay: MeetingDay | null;
  firstMeetingDate: number | null;
  onChange: (next: {
    meetingDay?: MeetingDay | null;
    firstMeetingDate?: number | null;
  }) => void;
  disabled?: boolean;
  className?: string;
}) {
  const weekday = firstMeetingDate ? istWeekday(firstMeetingDate) : null;
  const mismatch = !!meetingDay && !!weekday && meetingDay !== weekday;
  const label =
    "text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground";

  return (
    <div className={"space-y-3 " + className}>
      {/* A — meeting day */}
      <div className="space-y-1.5">
        <div className={label}>A · Select center meeting day</div>
        <div
          role="radiogroup"
          aria-label="Center meeting day"
          className="grid grid-cols-4 gap-1.5 sm:grid-cols-7"
        >
          {MEETING_DAYS.map((day) => {
            const active = meetingDay === day;
            return (
              <button
                key={day}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => onChange({ meetingDay: active ? null : day })}
                className={
                  "border-2 border-ink px-1 py-2 text-[10px] font-black uppercase shadow-hard-sm transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-none disabled:opacity-50 sm:text-[11px] " +
                  (active ? "bg-gold" : "bg-white")
                }
              >
                {day.slice(0, 3)}
                <span className="mt-0.5 block text-[9px] font-bold text-muted-foreground">
                  {day.slice(3)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* B — first meeting date */}
      <label className="block space-y-1.5">
        <span className={label}>B · Select first meeting date</span>
        <span className="flex items-center gap-2 border-2 border-ink bg-white px-2 shadow-hard-sm">
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="date"
            value={toDateInputValue(firstMeetingDate)}
            disabled={disabled}
            aria-label="First meeting date"
            onChange={(e) => {
              const ts = fromDateInputValue(e.target.value);
              // An empty / malformed value clears the choice; a valid one is
              // stored exactly as picked — never nudged to "today".
              onChange({ firstMeetingDate: ts });
            }}
            className="h-11 w-full bg-transparent text-sm font-bold outline-none disabled:opacity-50"
          />
        </span>
      </label>

      {/* Selected values, always readable — with the weekday spelled out. */}
      <div className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
        {meetingDay && firstMeetingDate ? (
          <>
            Center Meeting Day: <span className="font-black">{meetingDay}</span> · First
            Meeting Date:{" "}
            <span className="font-black">{formatMeetingDate(firstMeetingDate)}</span>
          </>
        ) : meetingDay ? (
          <>Meeting day <span className="font-black">{meetingDay}</span> selected — now pick the first meeting date.</>
        ) : firstMeetingDate ? (
          <>
            First meeting date{" "}
            <span className="font-black">{formatMeetingDate(firstMeetingDate)}</span>{" "}
            selected — now pick the meeting day.
          </>
        ) : (
          "Pick a meeting day and a first meeting date — both are chosen manually and saved on the loan."
        )}
      </div>

      {mismatch && (
        <div className="flex items-start gap-2 border-2 border-ink bg-gold p-2 text-[10px] font-black uppercase">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          The meeting day ({meetingDay}) and the first meeting date ({weekday}) differ — both
          are kept exactly as selected.
        </div>
      )}
    </div>
  );
}
