// The 10 IPL franchises. Shared by the auction engine (IplAuctionScreen) and the
// multiplayer lobby (Lobby) so the list/colors live in exactly one place.
// `agg` = AI aggression multiplier, `jump` = AI bid-jump tendency (auction only).
export const TEAMS = [
  { id: "MI",   name: "Mumbai Indians",              short: "MI",   color: "#1B6FCB", text: "#fff",    agg: 1.0,  jump: 0.30 },
  { id: "CSK",  name: "Chennai Super Kings",         short: "CSK",  color: "#F4C430", text: "#10131C", agg: 1.0,  jump: 0.25 },
  { id: "RCB",  name: "Royal Challengers Bengaluru", short: "RCB",  color: "#C8102E", text: "#fff",    agg: 1.12, jump: 0.52 },
  { id: "KKR",  name: "Kolkata Knight Riders",       short: "KKR",  color: "#6A4C93", text: "#fff",    agg: 0.98, jump: 0.35 },
  { id: "DC",   name: "Delhi Capitals",              short: "DC",   color: "#2E5EAA", text: "#fff",    agg: 0.92, jump: 0.16 },
  { id: "SRH",  name: "Sunrisers Hyderabad",         short: "SRH",  color: "#FF7A1A", text: "#10131C", agg: 1.08, jump: 0.42 },
  { id: "RR",   name: "Rajasthan Royals",            short: "RR",   color: "#E6308A", text: "#fff",    agg: 0.90, jump: 0.16 },
  { id: "PBKS", name: "Punjab Kings",                short: "PBKS", color: "#D31329", text: "#fff",    agg: 1.10, jump: 0.48 },
  { id: "GT",   name: "Gujarat Titans",              short: "GT",   color: "#C2A05A", text: "#10131C", agg: 1.0,  jump: 0.28 },
  { id: "LSG",  name: "Lucknow Super Giants",        short: "LSG",  color: "#1FA2C4", text: "#10131C", agg: 1.03, jump: 0.33 },
];
