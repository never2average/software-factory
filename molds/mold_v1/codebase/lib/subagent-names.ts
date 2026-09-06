/**
 * A large static pool of distinct, memorable codenames for subagent RUNS.
 *
 * Two runs of the same subagent type ("Research", "Research") are otherwise
 * indistinguishable in the Control Panel. Each run gets a famous robot as its
 * proper name — "WALL-E", "HAL-9000", "R2-D2" — so parallel/repeated runs read
 * apart at a glance. The name is assigned deterministically from its stable id (its
 * child session id) so it never shifts between renders, and it is PERSISTED in
 * the DB (subagent_runs.label) so it is authoritative and reusable elsewhere.
 *
 * Shared, dependency-free: imported by both the client (cockpit) and the
 * server API route.
 */
export const SUBAGENT_NAMES: readonly string[] = [
  // Star Wars droids
  "R2-D2", "C-3PO", "BB-8", "K-2SO", "IG-11", "IG-88", "HK-47", "BD-1", "Chopper", "L3-37",
  "R5-D4", "D-O", "4-LOM", "2-1B", "FX-7", "EV-9D9",
  // Pixar / Disney
  "WALL-E", "EVE", "Baymax", "M-O", "AUTO",
  // Transformers
  "Optimus", "Bumblebee", "Megatron", "Starscream", "Soundwave", "Ironhide", "Ratchet", "Jazz",
  "Prowl", "Wheeljack", "Shockwave", "Grimlock",
  // Star Trek
  "Data", "Lore", "B-4",
  // Terminator
  "T-800", "T-1000", "T-X", "Skynet",
  // Portal
  "GLaDOS", "Wheatley", "ATLAS", "P-Body",
  // Interstellar
  "TARS", "CASE", "KIPP",
  // Knight Rider
  "KITT", "KARR",
  // Marvel / Iron Man
  "Vision", "Ultron", "JARVIS", "FRIDAY", "Dum-E", "Jocasta",
  // Futurama
  "Bender", "Calculon", "Flexo", "URL", "Clamps",
  // Classic sci-fi film & TV
  "HAL-9000", "Marvin", "Robby", "Gort", "Maria", "Twiki", "K9", "Rosie", "Vicki", "Max",
  "Robot-B9", "Huey", "Dewey", "Louie", "Johnny-5", "RoboCop", "ED-209", "Chappie", "Sonny",
  // Alien / Blade Runner
  "Ash", "Bishop", "David", "Walter", "Call", "Roy-Batty", "Pris", "Rachael", "Nexus-6",
  // Ex Machina / Her / Westworld
  "Ava", "Kyoko", "Samantha", "Dolores", "Bernard", "Maeve",
  // Games
  "Cortana", "Guilty-Spark", "Clank", "Legion", "EDI", "Mega-Man", "Proto-Man", "Zero", "Roll", "Bass",
  // Detroit / BSG
  "Connor", "Markus", "Kara", "Cylon", "Number-Six", "Boomer",
  // Anime / mecha
  "Astro", "Doraemon", "Gundam", "RX-78", "Zaku", "EVA-01", "Mazinger", "Tetsujin", "Voltron", "Jet-Jaguar",
  // A.I. / Bicentennial / Real Steel / Iron Giant
  "Teddy", "Andrew", "Atom", "Iron-Giant", "Gigolo-Joe",
  // Real-world robots
  "Asimo", "Pepper", "Sophia", "Spot", "Atlas-BD", "Nao", "Vector", "Cozmo", "Aibo", "BMO",
  // Person of Interest / misc
  "The-Machine", "Samaritan", "Tik-Tok", "Bishop-2", "Robot",
];

/** FNV-1a-ish stable hash of a string → non-negative int. */
function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically pick a codename for a run from its stable key (child
 * session id, else tool-call id). Same key → same name, every time, no state.
 */
export function pickSubagentName(key: string): string {
  return SUBAGENT_NAMES[hashKey(key) % SUBAGENT_NAMES.length];
}
