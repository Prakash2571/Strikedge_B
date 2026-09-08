import { test } from "node:test";
// This line is a comment mentioning images.dhan.co and must be IGNORED.
test("planted", async () => {
  const url = "https://images.dhan.co/api-data/api-scrip-master.csv";
  await fetch(url);
});
