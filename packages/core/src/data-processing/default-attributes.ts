import type { AttributeDefinition } from "./ports.ts";

// The default attribute definitions from docs/data-processing.md ("Default definitions").
// The descriptions are what the classifier reads to decide when a definition applies.

export const attributes: AttributeDefinition[] = [
  {
    key: "category",
    name: "Category",
    description:
      "What the experience is about. An experience can have several categories. Category is separate from format: " +
      "a jazz festival is Music, and a farmers' market is Food and drink.",
    type: "option",
    defaultValue: null,
    multiple: true,
    filterable: true,
    options: [
      { key: "music", name: "Music", description: "Concerts, gigs, recitals and music festivals" },
      {
        key: "performing_arts",
        name: "Performing arts",
        description: "Theatre, musicals, dance, opera, comedy and cabaret",
      },
      { key: "film", name: "Film", description: "Screenings, film festivals and outdoor cinema" },
      {
        key: "visual_arts",
        name: "Visual arts",
        description: "Exhibitions, gallery openings, art walks, craft and design",
      },
      {
        key: "food_and_drink",
        name: "Food and drink",
        description: "Tastings, pairings, harvest days and pop-up dinners",
      },
      { key: "sport", name: "Sport", description: "Matches, races and tournaments to watch" },
      {
        key: "outdoor_and_adventure",
        name: "Outdoor and adventure",
        description: "Things to take part in outdoors: trail runs, cycling, hiking, kayaking, golf days",
      },
      {
        key: "nature_and_wildlife",
        name: "Nature and wildlife",
        description: "Whales, birding, fynbos, gardens, stargazing and other wildlife or botanical seasons and tours",
      },
      {
        key: "culture_and_heritage",
        name: "Culture and heritage",
        description: "History, heritage sites, museums, cultural celebrations, book and author events",
      },
      { key: "wellness", name: "Wellness", description: "Yoga, retreats, spa and wellbeing days" },
      {
        key: "holidays_and_celebrations",
        name: "Holidays and celebrations",
        description: "Christmas, New Year's Eve, Easter, Heritage Day, Valentine's Day",
      },
      {
        key: "hobbies_and_lifestyle",
        name: "Hobbies and lifestyle",
        description: "Car and boat shows, garden shows, fashion, home and decor, collectors' fairs",
      },
      {
        key: "community_and_causes",
        name: "Community and causes",
        description: "Charity days, fundraisers, school and town events",
      },
      {
        key: "faith_and_spirituality",
        name: "Faith and spirituality",
        description: "Services, carols and religious gatherings",
      },
      {
        key: "business_and_professional",
        name: "Business and professional",
        description: "Conferences, networking and trade expos",
      },
    ],
  },
  {
    key: "format",
    name: "Format",
    description:
      "The form the experience takes. Format is not the experience's type: the type says how its dates are known, " +
      "the format says what form it takes. A festival, a market and a talk are formats.",
    type: "option",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [
      { key: "performance", name: "Performance", description: "A concert, show, recital or gig" },
      { key: "festival", name: "Festival", description: "A programme that runs over several days or venues" },
      { key: "market", name: "Market", description: "Farmers', craft and night markets" },
      { key: "fair_or_expo", name: "Fair or expo", description: "Shows, expos and fêtes" },
      { key: "exhibition", name: "Exhibition", description: "An art or museum exhibition open over a period" },
      { key: "screening", name: "Screening", description: "A film showing" },
      { key: "match_or_tournament", name: "Match or tournament", description: "A fixture to watch" },
      { key: "race", name: "Race", description: "A trail run, cycle race, swim or regatta" },
      { key: "tour_or_excursion", name: "Tour or excursion", description: "A guided walk, boat trip or tasting tour" },
      { key: "class_or_workshop", name: "Class or workshop", description: "Hands-on learning" },
      { key: "talk", name: "Talk", description: "A lecture, book launch or panel" },
      { key: "conference", name: "Conference", description: "A conference or networking event" },
      { key: "dining_event", name: "Dining event", description: "A pairing dinner, pop-up or gala" },
      { key: "party", name: "Party", description: "A club night or New Year's Eve party" },
      { key: "retreat", name: "Retreat", description: "A wellness or creative retreat over several days" },
      { key: "parade_or_ceremony", name: "Parade or ceremony", description: "A parade, carols or lights switch-on" },
      {
        key: "attraction",
        name: "Attraction",
        description: "Something to visit with no programme: a site, an open garden",
      },
    ],
  },
  {
    key: "audience",
    name: "Audience",
    description:
      "Who the experience is for. This is the only place that says an experience is for families; " +
      "there is no family category.",
    type: "option",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [
      {
        key: "family",
        name: "Family",
        description: "Made for children and their families: children's theatre, a holiday club, an egg hunt",
      },
      { key: "all_ages", name: "All ages", description: "Open to anyone, children welcome" },
      { key: "adults", name: "Adults", description: "Aimed at adults, whether or not a source states an age limit" },
    ],
  },
  {
    key: "minimum_age",
    name: "Minimum age",
    description: "The age limit a source states, such as 18 for \"No under 18s\". Set only when a source states one.",
    type: "number",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [],
  },
  {
    key: "language",
    name: "Language",
    description:
      "The language the experience is performed or presented in. Set where language matters: theatre, comedy, " +
      "talks, film.",
    type: "option",
    defaultValue: null,
    multiple: true,
    filterable: true,
    options: [
      { key: "english", name: "English", description: "Performed or presented in English" },
      { key: "afrikaans", name: "Afrikaans", description: "Performed or presented in Afrikaans" },
      { key: "isixhosa", name: "isiXhosa", description: "Performed or presented in isiXhosa" },
      { key: "other", name: "Other", description: "Performed or presented in a language not listed here" },
    ],
  },
  {
    key: "setting",
    name: "Setting",
    description: "Where the experience takes place: indoors, outdoors, or both.",
    type: "option",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [
      {
        key: "indoor",
        name: "Indoor",
        description: "Takes place inside a building: a theatre, hall, gallery or restaurant",
      },
      {
        key: "outdoor",
        name: "Outdoor",
        description: "Takes place in the open air: a beach, park, street, farm or the sea",
      },
      {
        key: "both",
        name: "Both",
        description: "Has indoor and outdoor parts, such as a festival with halls and an open-air stage",
      },
    ],
  },
  {
    key: "scale",
    name: "Scale",
    description:
      "How far people travel for the experience: Local draws the town, Regional draws the province, " +
      "Major draws visitors from across the country or abroad.",
    type: "option",
    defaultValue: "local",
    multiple: false,
    filterable: true,
    options: [
      { key: "local", name: "Local", description: "Draws the town and its surroundings" },
      { key: "regional", name: "Regional", description: "Draws visitors from across the province" },
      { key: "major", name: "Major", description: "Draws visitors from across the country or abroad" },
    ],
  },
  {
    key: "wheelchair_accessible",
    name: "Wheelchair accessible",
    description: "Whether the experience is wheelchair accessible. Set only when a source says so.",
    type: "boolean",
    defaultValue: null,
    multiple: false,
    filterable: true,
    options: [],
  },
];
