import * as assert from "assert";
import { IdleTimer } from "../idle";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite("IdleTimer", () => {
  test("fires once after the timeout while inactive", async () => {
    let fired = 0;
    const t = new IdleTimer(
      () => 30,
      () => fired++,
    );
    t.setActive(false);
    t.setActive(false);
    await sleep(100);
    assert.strictEqual(fired, 1);
  });

  test("becoming active cancels a pending fire", async () => {
    let fired = 0;
    const t = new IdleTimer(
      () => 50,
      () => fired++,
    );
    t.setActive(false);
    await sleep(20);
    t.setActive(true);
    await sleep(100);
    assert.strictEqual(fired, 0);
  });

  test("repeated inactive calls do not restart the clock", async () => {
    let fired = 0;
    const t = new IdleTimer(
      () => 60,
      () => fired++,
    );
    t.setActive(false);
    await sleep(40);
    t.setActive(false);
    await sleep(40);
    assert.strictEqual(fired, 1);
  });

  test("a timeout of 0 disables it", async () => {
    let fired = 0;
    const t = new IdleTimer(
      () => 0,
      () => fired++,
    );
    t.setActive(false);
    await sleep(50);
    assert.strictEqual(fired, 0);
  });

  test("dispose cancels a pending fire and it can be armed again", async () => {
    let fired = 0;
    const t = new IdleTimer(
      () => 30,
      () => fired++,
    );
    t.setActive(false);
    t.dispose();
    await sleep(80);
    assert.strictEqual(fired, 0);
    t.setActive(false);
    await sleep(80);
    assert.strictEqual(fired, 1);
  });
});
