// سرور پشتیبان «سی‌شاپ»
// این سرور بین صفحه‌ی HTML و گیت‌هاب واسطه است:
// ۱) کدی که کاربر می‌فرستد را در ریپازیتوری کامیت می‌کند
// ۲) یک GitHub Action را برای ساخت APK اجرا می‌کند
// ۳) وضعیت آن را چک می‌کند و لینک دانلود نهایی را برمی‌گرداند

import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));

// همین صفحه‌ی index.html را هم از همین سرور سرو می‌کنیم
// (فایل index__1_.html خودت را با نام index.html در پوشه‌ی public کنار این فایل بگذار)
app.use(express.static(path.join(__dirname, "public")));

const { GH_TOKEN, OWNER, REPO, PORT = 3000 } = process.env;
if (!GH_TOKEN || !OWNER || !REPO) {
  console.warn("⚠️  متغیرهای محیطی GH_TOKEN / OWNER / REPO تنظیم نشده‌اند.");
}

const GH_API = "https://api.github.com";
const BRANCH = "main";
const WORKFLOW_FILE = "build.yml";

// نگهداری موقت وضعیت کارها در حافظه (برای شروع کافی است)
const jobs = new Map();

function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { ...ghHeaders(), ...(options.headers || {}) },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`GitHub ${r.status}: ${text.slice(0, 300)}`);
  }
  if (r.status === 204) return {};
  return r.json().catch(() => ({}));
}

async function putTextFile(filePath, contentUtf8, message) {
  let sha;
  try {
    const existing = await ghFetch(
      `${GH_API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filePath)}?ref=${BRANCH}`
    );
    sha = existing.sha;
  } catch {
    // فایل هنوز وجود ندارد، مشکلی نیست
  }
  const body = {
    message,
    content: Buffer.from(contentUtf8, "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  await ghFetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

app.post("/build", async (req, res) => {
  try {
    const payload = req.body || {};
    const id = crypto.randomBytes(8).toString("hex");
    const marker = `build-${id}`;

    if (payload.type === "web") {
      if (!payload.code || !payload.code.trim()) {
        return res.status(400).json({ error: "کد خالی است" });
      }
      await putTextFile("www/index.html", payload.code, `build: ${marker}`);
    } else {
      // این نسخه‌ی سرور فقط حالت «وب» (HTML) را پشتیبانی می‌کند.
      // حالت‌های اندروید (single/multi/zip) نیاز به یک قالب پروژه‌ی
      // اندروید در ریپازیتوری دارند که باید جداگانه آماده شود.
      return res.status(400).json({
        error: "این نسخه فقط ساخت اپ از روی کد HTML را پشتیبانی می‌کند.",
      });
    }

    const createdAt = Date.now();

    await ghFetch(
      `${GH_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: BRANCH, inputs: { marker } }),
      }
    );

    jobs.set(id, { marker, createdAt, runId: null });
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/status/:id", async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "شناسه پیدا نشد" });

    if (!job.runId) {
      const runs = await ghFetch(
        `${GH_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=10`
      );
      const match = (runs.workflow_runs || []).find(
        (r) => new Date(r.created_at).getTime() >= job.createdAt - 20000
      );
      if (match) job.runId = match.id;
      else return res.json({ state: "queued" });
    }

    const run = await ghFetch(`${GH_API}/repos/${OWNER}/${REPO}/actions/runs/${job.runId}`);

    if (run.status !== "completed") {
      return res.json({
        state: run.status === "queued" ? "queued" : "in_progress",
        logs: run.html_url,
      });
    }
    if (run.conclusion !== "success") {
      return res.json({ state: "failed", logs: run.html_url });
    }

    let asset = null;
    try {
      const release = await ghFetch(
        `${GH_API}/repos/${OWNER}/${REPO}/releases/tags/${job.marker}`
      );
      asset = (release.assets || []).find((a) => a.name.endsWith(".apk"));
    } catch {
      // ریلیز هنوز ثبت نشده
    }

    if (!asset) {
      return res.json({ state: "in_progress", logs: run.html_url });
    }

    res.json({ state: "success", url: asset.browser_download_url, logs: run.html_url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`سرور روی پورت ${PORT} در حال اجراست`));
