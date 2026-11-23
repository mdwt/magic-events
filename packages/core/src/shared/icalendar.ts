// What an iCalendar file says, as text that reads the same on every fetch. A calendar's server writes DTSTAMP, the
// time it generated the file, into every event, and Google Calendar lists the events in a new order each time.

// True when the body is an iCalendar file rather than a page.
export function isCalendar(body: string): boolean {
  return body.replace(/^\uFEFF/, "").trimStart().startsWith("BEGIN:VCALENDAR");
}

// The calendar with its long lines unfolded, without DTSTAMP, and with its events in a fixed order: by start, then
// UID, then which occurrence of a recurring event they replace. Everything else an event says is kept as written.
export function calendarContent(body: string): string {
  // A long line goes on in the next line that starts with a space or a tab (RFC 5545, 3.1).
  const lines = body
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !/^DTSTAMP[:;]/i.test(line));

  const head: string[] = [];
  const events: string[][] = [];
  const tail: string[] = [];
  let event: string[] | null = null;
  // How deep inside an event the line is, for the alarms an event can hold.
  let depth = 0;
  for (const line of lines) {
    if (event) {
      event.push(line);
      if (/^BEGIN:/i.test(line)) depth += 1;
      else if (/^END:/i.test(line) && --depth === 0) {
        events.push(event);
        event = null;
      }
    } else if (/^BEGIN:VEVENT$/i.test(line.trim())) {
      event = [line];
      depth = 1;
    } else if (/^END:VCALENDAR$/i.test(line.trim()) || tail.length > 0) {
      tail.push(line);
    } else {
      head.push(line);
    }
  }
  // An event the file never closes is kept where the calendar ends.
  if (event) tail.unshift(...event);

  const keyed = events.map((lines) => ({ lines, key: sortKey(lines) }));
  keyed.sort((a, b) => compare(a.key, b.key));
  return [...head, ...keyed.flatMap((one) => one.lines), ...tail].join("\n");
}

function sortKey(lines: string[]): string[] {
  const value = (name: string) => {
    const line = lines.find((one) => new RegExp(`^${name}[:;]`, "i").test(one)) ?? "";
    return line.slice(line.indexOf(":") + 1);
  };
  return [value("DTSTART"), value("UID"), value("RECURRENCE-ID"), lines.join("\n")];
}

function compare(a: string[], b: string[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
