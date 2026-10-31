import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import { createHash, randomBytes } from "node:crypto";

test("authenticated workspace has no Next.js prerender errors on navigation or reload", async ({ page }) => {
  const email = `prerender-${randomBytes(10).toString("hex")}@example.test`;
  const password = randomBytes(20).toString("hex");
  const client = new MongoClient(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/it_helpdesk");
  const errors: string[] = [];

  // Next.js reports prerender validation errors through console.error and its
  // issues overlay, even when the page renders and no pageerror event fires.
  page.on("console", (message) => {
    if (message.type() === "error" && /unstable value|blocking-prerender|Blocking Route/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto("/login");
    await expect(page.locator("main")).toHaveCSS("display", "grid");
    const response = await page.request.post("/api/auth/register", {
      data: { name: "Kiểm tra prerender", email, password, confirmPassword: password },
    });
    expect(response.status()).toBe(201);

    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /Xin chào, prerender/ })).toBeVisible();
    await expect(page.locator(".user-info")).toContainText("Nhân viên");
    await expect(page.getByRole("button", { name: "Đăng xuất", exact: true })).toBeVisible();
    expect(errors, "Next.js must not report errors after authenticated navigation").toEqual([]);
    await expect(page.getByRole("button", { name: "Open issues overlay" })).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /Xin chào, prerender/ })).toBeVisible();
    expect(errors, "Next.js must not report errors after authenticated reload").toEqual([]);
    await expect(page.getByRole("button", { name: "Open issues overlay" })).toHaveCount(0);
  } finally {
    await client.connect();
    const db = client.db();
    try {
      const user = await db.collection("users").findOne({ email });
      if (user) {
        await db.collection("authsessions").deleteMany({ userId: user._id });
        await db.collection("users").deleteOne({ _id: user._id });
      }
      const window = Math.floor(Date.now() / (15 * 60 * 1000));
      const ids = [window - 1, window].map((value) => createHash("sha256").update(`register:${email}:${value}`).digest("hex"));
      await db.collection<{ _id: string }>("authattempts").deleteMany({ _id: { $in: ids } });
    } finally {
      await client.close();
    }
  }
});
