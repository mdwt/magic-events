import type { ExtractionAnswer } from "../../../src/data-processing/extract.ts";

// Answers as the language model gives them, with every field filled the way the schema asks.

type AnswerExperience = ExtractionAnswer["experiences"][number];
type AnswerSession = AnswerExperience["sessions"][number];

export function session(overrides: Partial<AnswerSession> = {}): AnswerSession {
  return {
    start: "2027-06-12",
    end: "2027-06-21",
    precision: "day",
    startTime: "",
    endTime: "",
    label: "",
    soldOut: false,
    cancelled: false,
    ...overrides,
  };
}

// The FynArts festival of 2027, as a page announces it.
export function answered(overrides: Partial<AnswerExperience> = {}): AnswerExperience {
  return {
    title: "Hermanus FynArts",
    summary: "A ten-day arts festival.",
    description: "Exhibitions, concerts and talks across Hermanus.",
    type: "single",
    status: "announced",
    booking: "not_yet",
    sessions: [session()],
    recurrence: null,
    openingHours: "",
    venueName: "",
    venueAddress: "",
    city: "Hermanus",
    venueLatitude: null,
    venueLongitude: null,
    priceMin: null,
    priceMax: null,
    currency: "",
    onSaleAt: "",
    bookingClosesAt: "",
    bookingUrl: "",
    imageUrl: "",
    url: "",
    hints: ["Festival"],
    ...overrides,
  };
}

export function extraction(...experiences: AnswerExperience[]): ExtractionAnswer {
  return { experiences };
}
