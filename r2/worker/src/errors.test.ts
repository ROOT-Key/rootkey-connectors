import { PermanentError } from "./errors";

describe("PermanentError", () => {
  it("is an Error subclass with the correct name", () => {
    const err = new PermanentError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.name).toBe("PermanentError");
    expect(err.message).toBe("boom");
  });

  it("instanceof discriminates from regular errors", () => {
    const transient = new Error("transient");
    const permanent = new PermanentError("permanent");
    expect(transient instanceof PermanentError).toBe(false);
    expect(permanent instanceof PermanentError).toBe(true);
  });
});
