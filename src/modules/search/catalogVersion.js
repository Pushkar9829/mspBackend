/**
 * In-process catalog change counter. Product / Brand / Category models bump it from their write
 * hooks, and the fuzzy-search term dictionary rebuilds lazily when it has moved. Dependency-free so
 * model files can import it without cycles. Other instances pick changes up through the
 * dictionary's TTL.
 */
let version = 0;

export function catalogVersion() {
  return version;
}

export function bumpCatalogVersion() {
  version += 1;
}

const QUERY_WRITES = ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany"];

/** Register post-write hooks on a schema (call before the model is compiled). */
export function trackCatalogChanges(schema) {
  const bump = () => bumpCatalogVersion();
  schema.post("save", bump);
  schema.post("insertMany", bump);
  for (const op of QUERY_WRITES) schema.post(op, { document: false, query: true }, bump);
  schema.post("deleteOne", { document: true, query: false }, bump);
}
