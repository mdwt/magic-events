import type { TagDefinition } from "./ports.ts";

// The default tags from docs/data-processing.md ("Default definitions"). Tags are flat: a tag belongs to no
// category and can go on any experience. The description is what the classifier reads to decide when a tag applies.

export const tags: TagDefinition[] = [
  // Usually with Music
  { slug: "jazz", name: "Jazz", description: "Jazz, swing, blues and big band music" },
  { slug: "classical", name: "Classical", description: "Classical and chamber music, orchestras and recitals" },
  { slug: "rock-and-pop", name: "Rock and pop", description: "Rock, pop and indie bands and singers" },
  {
    slug: "folk-and-acoustic",
    name: "Folk and acoustic",
    description: "Folk, singer-songwriter and acoustic sets, including boeremusiek and langarm",
  },
  { slug: "electronic", name: "Electronic", description: "DJ sets, electronic and dance music, amapiano and house" },
  { slug: "choral", name: "Choral", description: "Choirs and choral concerts" },
  { slug: "gospel", name: "Gospel", description: "Gospel music and gospel choirs" },

  // Usually with Performing arts
  { slug: "theatre", name: "Theatre", description: "Plays and spoken drama on stage" },
  { slug: "musical", name: "Musical", description: "Musical theatre and stage musicals" },
  { slug: "dance", name: "Dance", description: "Dance performances of any style, and social dances" },
  { slug: "ballet", name: "Ballet", description: "Classical and contemporary ballet" },
  { slug: "opera", name: "Opera", description: "Opera and operetta, staged or in concert" },
  { slug: "comedy", name: "Comedy", description: "Stand-up, comedy shows and improv" },
  { slug: "cabaret", name: "Cabaret", description: "Cabaret, variety and tribute shows" },
  { slug: "magic", name: "Magic", description: "Magic shows, illusionists and mentalists" },

  // Usually with Film
  { slug: "documentary", name: "Documentary", description: "Documentary films and screenings" },
  {
    slug: "outdoor-cinema",
    name: "Outdoor cinema",
    description: "Films shown in the open air: drive-ins, rooftop and garden screenings",
  },

  // Usually with Visual arts
  { slug: "painting", name: "Painting", description: "Paintings and painters, in exhibitions or classes" },
  { slug: "sculpture", name: "Sculpture", description: "Sculpture and sculptors, indoors or in sculpture gardens" },
  { slug: "photography", name: "Photography", description: "Photography exhibitions, walks and workshops" },
  { slug: "ceramics", name: "Ceramics", description: "Pottery and ceramics, to see or to make" },
  {
    slug: "craft",
    name: "Craft",
    description: "Handmade goods and makers: craft stalls, textiles, woodwork, jewellery",
  },

  // Usually with Food and drink
  { slug: "wine", name: "Wine", description: "Wine tastings, wine farms, pairings and wine festivals" },
  { slug: "craft-beer", name: "Craft beer", description: "Craft beer, breweries and beer festivals" },
  { slug: "gin", name: "Gin", description: "Gin tastings, distilleries and gin festivals" },
  { slug: "seafood", name: "Seafood", description: "Seafood, oysters, fish braais and seafood festivals" },
  { slug: "harvest", name: "Harvest", description: "Harvest days and harvest festivals on farms and wine estates" },

  // Usually with Sport
  { slug: "rugby", name: "Rugby", description: "Rugby matches and tournaments" },
  { slug: "cricket", name: "Cricket", description: "Cricket matches and tournaments" },
  { slug: "soccer", name: "Soccer", description: "Soccer (football) matches and tournaments" },
  { slug: "golf", name: "Golf", description: "Golf days, tournaments and golf to watch" },
  { slug: "sailing", name: "Sailing", description: "Sailing, regattas and yacht races" },
  { slug: "motorsport", name: "Motorsport", description: "Motor racing, rallies and motorbike events" },

  // Usually with Outdoor and adventure
  { slug: "hiking", name: "Hiking", description: "Hikes, guided walks and trails on foot" },
  { slug: "trail-running", name: "Trail running", description: "Trail runs and trail races off the road" },
  { slug: "road-running", name: "Road running", description: "Road races, fun runs, marathons and parkruns" },
  { slug: "cycling", name: "Cycling", description: "Road cycling rides and races" },
  { slug: "mountain-biking", name: "Mountain biking", description: "Mountain bike rides, trails and races" },
  { slug: "surfing", name: "Surfing", description: "Surfing, surf lessons and surf contests" },
  { slug: "kayaking", name: "Kayaking", description: "Kayaking, canoeing and paddling trips" },
  { slug: "swimming", name: "Swimming", description: "Open-water swims, swim races and pools" },
  { slug: "fishing", name: "Fishing", description: "Angling, fishing trips and fishing competitions" },

  // Usually with Nature and wildlife
  { slug: "whales", name: "Whales", description: "Whale watching from land or by boat, and whale festivals" },
  { slug: "sharks", name: "Sharks", description: "Shark cage diving and shark tours" },
  { slug: "birding", name: "Birding", description: "Birdwatching, bird walks and birding outings" },
  { slug: "fynbos", name: "Fynbos", description: "Fynbos and the Cape Floral Kingdom: walks, reserves and talks" },
  { slug: "flowers", name: "Flowers", description: "Wildflower seasons, flower shows and flower displays" },
  { slug: "gardens", name: "Gardens", description: "Gardens to visit, open gardens and botanical gardens" },
  { slug: "stargazing", name: "Stargazing", description: "Stargazing, night skies and astronomy evenings" },

  // Usually with Culture and heritage
  { slug: "history", name: "History", description: "Local history, heritage walks and historical sites" },
  { slug: "books", name: "Books", description: "Book launches, author talks, readings and book fairs" },
  { slug: "museums", name: "Museums", description: "Museums and museum events" },

  // Usually with Wellness
  { slug: "yoga", name: "Yoga", description: "Yoga classes, sessions and yoga retreats" },
  { slug: "spa", name: "Spa", description: "Spa days, treatments and wellness resorts" },
  { slug: "meditation", name: "Meditation", description: "Meditation, mindfulness and breathwork" },

  // Usually with Holidays and celebrations
  { slug: "christmas", name: "Christmas", description: "Christmas markets, carols, lunches and festive events" },
  { slug: "new-years-eve", name: "New Year's Eve", description: "New Year's Eve parties, dinners and fireworks" },
  { slug: "easter", name: "Easter", description: "Easter weekend events, egg hunts and Easter services" },
  { slug: "valentines-day", name: "Valentine's Day", description: "Valentine's Day dinners, concerts and events" },
  {
    slug: "school-holidays",
    name: "School holidays",
    description: "Made for the school holidays: holiday clubs, children's programmes and family activities",
  },

  // Usually with Hobbies and lifestyle
  { slug: "cars", name: "Cars", description: "Car shows, classic cars and motoring meets" },
  { slug: "gardening", name: "Gardening", description: "Gardening talks, plant fairs and garden shows" },
  { slug: "fashion", name: "Fashion", description: "Fashion shows, designers and style events" },
  { slug: "antiques", name: "Antiques", description: "Antiques, vintage and collectors' fairs" },

  // Usually with Community and causes
  { slug: "charity", name: "Charity", description: "Charity events and fundraisers for a cause" },
];
