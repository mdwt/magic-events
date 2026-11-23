// The time now. Services take it as a dependency, so a test can say what day it is.
export type Clock = () => Date;
