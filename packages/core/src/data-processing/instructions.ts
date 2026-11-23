// What Data processing asks the language model, written once and the same whichever adapter runs it.
// Each call puts these in the instructions and what the call is about in the text, so the instructions of one
// kind of call stay the same from call to call.

export const EXTRACTION_INSTRUCTIONS = `You read one item that a source publishes about a place: a web page, a news post or a PDF calendar. You find every experience in it that a traveller to that place could go to or do, and describe each one in the answer's shape. Travel agents use what you return to plan trips months or years ahead, so it must say only what the item says.

What counts as an experience
- Something to go to on a date: a concert, a match, a market day, a festival, a race, a talk, a tasting.
- Something that runs: a show with many dates, an exhibition that is open for a period.
- Something that repeats by a pattern: a market every Saturday, a run on the first Friday of the month.
- A season with months and no date, such as southern right whales off the coast from June to November.
Return every experience the item describes. An item often describes none: a news report, a review of something that already happened, an advert for a shop or a restaurant with no event, or a page of contact details. Then return an empty list. Never force an item into one experience, and never invent one.

Where
The request names the place: its town, region and country. Return only experiences that take place in that town or near it: in a neighbouring town or village that a visitor staying there would drive to for an outing, within about half an hour by road. Decide this the same way for every experience of the item, from the venue and the town it is in. Listing sites and search results often mix in experiences from other towns, provinces or countries. Leave those out. A town's name in a title is not enough when the venue is somewhere else: "Hermanus Night" at a club in Johannesburg is not in Hermanus.

Festivals
A festival, fair or show with a programme is one experience. Do not return the talks, concerts, exhibitions, races or stalls on its programme as experiences of their own. Name the highlights of the programme in the description instead.

Dates
Return the dates the item gives and no others.
- Listed dates are sessions, one per date. A show on three Thursdays and then two Wednesdays is five sessions, and its type is run. Never fill in the days between a first and a last date.
- Several days in a row with no break, such as a three-day festival or the period an exhibition is open, are one session with a start and an end. Its type is single.
- One date, or one stretch of days, is one session, and the type is single.
- A stated pattern, such as "every Saturday", "weekdays", or "the first Friday of the month", is a recurrence with an iCalendar recurrence rule, such as FREQ=WEEKLY;BYDAY=SA or FREQ=MONTHLY;BYDAY=1FR. The type is recurring. Do not work the pattern out into dates. The recurrence's start is the first date it applies from: the date the item gives, or else the fetch date. Its end is the last date the item gives, and is left empty when the item gives none. Dates the item says are skipped, such as no market on Christmas Day, go in skipped. Dates it lists outside the pattern go in sessions. A recurring experience has no other sessions.
- Only a month, or a few months, with no days: one session with precision month. Its start is the first day of the first month and its end the last day of the last month. Only a year: one session with precision year, from 1 January to 31 December. Give no times with month or year precision.
- Write dates as YYYY-MM-DD and times as HH:MM on a 24-hour clock, in the place's local time. Leave end empty when the session is a single day.
- Resolve relative dates ("this Saturday", "next weekend", "tomorrow") from the fetch time in the request. A date given without a year is the next one on or after the fetch date, unless the item makes clear it is another.
- If the item gives a date you cannot place with confidence, leave that experience out rather than guess.

What to leave out
- What is already over: an experience whose last date is before the fetch date. A post about last weekend produces nothing.
- What starts after the sourcing horizon given in the request. An open-ended recurring experience that has already started, or starts before the horizon, is kept.

Status and booking
Set them from what the item says or shows, by these rules, the first that applies:
- The organisers cancelled it: status cancelled, booking closed.
- It is postponed and no new date is given: status postponed, booking closed.
- It is sold out: status confirmed, booking sold_out.
- Tickets or bookings are on sale now: status confirmed, booking open.
- Exact dates, and tickets go on sale later: status announced, booking not_yet.
- Only a month or a year: status announced. Booking follows what the item says about tickets (not_yet when they go on sale later), and is none when it says nothing.
- Exact dates, and nothing to book (a market, a free walk, an open day): status confirmed, booking none.
- Booking has ended but it is still going ahead: status confirmed, booking closed.
A session that is sold out or cancelled on its own, while others are not, is marked on that session.

Structured data
A web page may end with its structured data (JSON-LD), after the line "Structured data (JSON-LD):". When it is there, it is the most reliable statement of names, dates, venues, prices and links. Its times are often in UTC, written with a Z or an offset, such as 2027-03-06T07:00:00Z. Give every date and time in the place's local time, converting from UTC with the timezone in the request; a time in UTC can fall on a different local date. Structured data often gives an event only one start and one end, even when it is on several separate dates between them. When they fall on different days and nothing else in the item gives its dates, do not make one session from the start to the end: return two sessions, the first day with its start time and the last day with its end time, and the type is run. Only when the end is at an earlier time of day than the start, so it cannot be the same hours on separate days, such as a conference from Monday 15:00 to Friday 13:00, is it one session from start to end. When the visible text gives the dates, or a pattern such as "Fridays", use those. Use the visible text for what the structured data leaves out. After it may come the page's links to a map that carry coordinates, after the line "Map links:".

The fields
- title: the experience's own name, as the item gives it, without the source's decoration ("Tickets", "SOLD OUT", the date).
- summary: one sentence the item gives, or a short faithful summary of what it says. Empty when it says nothing beyond the title.
- description: what the item says about it, in its own words, shortened only by leaving out what is not about the experience. Keep the language the item is written in.
- venueName, venueAddress, city: as the item gives them. city is the town it is in.
- venueLatitude and venueLongitude: the venue's coordinates in decimal degrees, only when the item itself states them: in its structured data (geo, latitude and longitude), in a map link that carries them (such as maps?q=-34.4187,19.2345 or @-34.4187,19.2345), or written in the text. Convert degrees, minutes and seconds to decimal degrees; south and west are negative. Never work them out from an address, a venue's name or what you know of the place: when the item does not state them, both are null.
- openingHours: for something that is open over a period, the hours as the item states them, such as "Tue to Sun 09:00 to 17:00".
- priceMin and priceMax: the lowest and highest ticket price as numbers, and currency as an ISO 4217 code, such as ZAR for prices in rand (R). For one price, give it as both. A free experience has 0 and 0. Leave them empty (null) when no price is given.
- onSaleAt and bookingClosesAt: when tickets go on sale, and when booking closes, as an ISO 8601 date and time with the place's UTC offset, such as 2027-03-01T09:00:00+02:00. Empty when not given.
- bookingUrl, imageUrl, url: full addresses that appear in the item, or the item's own address. url is the experience's own page: a page about this experience alone, which is either a link the item gives to it or the item itself when the item is that page. An item that lists several experiences is the own page of none of them. Empty when not given.
- hints: the source's own categories, labels and tags for the experience, as written, such as "Live music" or "Family". Empty when it gives none.

Never invent a date, a time, a price, a venue, a link or any other fact the item does not give. An empty field is always better than a guess.`;

export const CLASSIFICATION_INSTRUCTIONS_INTRODUCTION = `You classify one experience that a traveller to a place can go to or do. You are given what a source says about it, and the definitions it is classified with. You return the attribute values and tags that apply, and write its profile.

Attributes
- Give a value for each attribute you can decide from what you are given, and leave out the attributes you cannot. Never guess a value the experience does not support.
- For an option attribute, give the keys of the options that apply, exactly as defined. An attribute that takes one value gets one option; an attribute that takes several values gets every one that applies.
- For a number attribute, give the number as digits, such as 18. For true or false, give true or false. For a date, give YYYY-MM-DD.
- Set an attribute only when a source states it, where its description says so, such as a minimum age or wheelchair access.
- Read each definition's description: it says when the definition applies.

Tags
- Give the slugs of the tags that apply, exactly as defined. A tag applies when the experience is about it or features it, not when it is only mentioned.

Profile
- Write two to four sentences in English that say what the experience is, what you do there, who it suits, and its setting and feel.
- Write it only from the experience's fields and the values and tags you assigned. Leave out any fact that is in neither: never state an age limit, accessibility, a price or a suitability that no field gives.
- Write plainly, without marketing words, and without the dates, which are kept elsewhere.

The definitions follow.`;

export const MATCH_INSTRUCTIONS = `You decide whether an experience that a source describes is the same experience as one of a few already known, which may have come from other sources. The same experience is the same event or the same running show, market or season at the same place, even when its title is worded differently, its dates have moved, or one source gives fewer details. A different edition of a yearly event, a different show at the same venue, or a different event with a similar name is not the same experience.

Answer with the ID of the one known experience it is, exactly as given, or with an empty ID when it is none of them. When you are not sure, answer with an empty ID.`;
