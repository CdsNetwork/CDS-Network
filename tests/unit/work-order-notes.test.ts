import { describe, expect, it } from "vitest";
import { NOTE_MAX_LENGTH, noteBody } from "@/lib/notes";

describe("noteBody", () => {
  it("keeps the line breaks inside a note and trims the ends", () => {
    expect(noteBody("  \r\nUnit arrived.\r\n\r\nInlet cracked, see photos.\r\n  ")).toEqual({
      body: "Unit arrived.\n\nInlet cracked, see photos.",
    });
    expect(noteBody("old\rmac")).toEqual({ body: "old\nmac" });
  });

  it("refuses an empty, blank or missing note", () => {
    for (const value of ["", "   ", "\r\n\t \r\n", null]) {
      expect(noteBody(value), JSON.stringify(value)).toEqual({ error: "Write a note first." });
    }
    expect(noteBody(new File(["x"], "x.txt"))).toEqual({ error: "Write a note first." });
  });

  it("allows 2000 characters and refuses more, counting characters like Postgres", () => {
    expect(noteBody("a".repeat(NOTE_MAX_LENGTH))).toEqual({ body: "a".repeat(NOTE_MAX_LENGTH) });
    expect(noteBody("a".repeat(NOTE_MAX_LENGTH + 1))).toEqual({
      error: "The note is too long (2001 characters, max 2000).",
    });
    // An emoji is one character in Postgres but two UTF-16 units in JavaScript.
    expect(noteBody("\u{1F69A}".repeat(NOTE_MAX_LENGTH))).toHaveProperty("body");
  });
});
