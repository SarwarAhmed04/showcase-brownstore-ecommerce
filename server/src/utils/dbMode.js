/** Local process DB mode — never changes production config; used for admin warnings only. */
let mongoMode = "unknown";

export function setMongoMode(mode) {
  mongoMode = mode === "memory" || mode === "persistent" ? mode : "unknown";
}

export function getMongoMode() {
  return mongoMode;
}
