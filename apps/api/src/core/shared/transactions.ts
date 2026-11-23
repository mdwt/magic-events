// A unit of work across domains. Everything the repositories write inside `run` is saved together or not at all.
// It belongs to no domain. One raw listing is processed inside one: the claim, the experiences it saves,
// the warehouse rows and the mark.
export interface Transactions {
  // Runs the work in one transaction. When the work throws, everything it wrote is rolled back and the error is
  // thrown on. Work that is already inside a transaction joins it.
  run<T>(work: () => Promise<T>): Promise<T>;
}
