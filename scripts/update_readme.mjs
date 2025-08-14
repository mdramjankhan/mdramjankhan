// scripts/update_readme.mjs
import fs from "node:fs/promises";

const GH_TOKEN = process.env.GH_TOKEN;
const LOGIN = process.env.GITHUB_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;

if (!GH_TOKEN) {
  console.error("Missing GH_TOKEN env.");
  process.exit(1);
}
if (!LOGIN) {
  console.error("Missing GITHUB_LOGIN env.");
  process.exit(1);
}

const GQL = "https://api.github.com/graphql";
const REST = "https://api.github.com";

async function gql(query, variables) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GraphQL error: ${res.status} ${t}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
}

async function rest(path, params = "") {
  const url = `${REST}${path}${params}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`REST error: ${res.status} ${t}`);
  }
  return res.json();
}

function toIST(date) {
  // Convert UTC string to IST (UTC+5:30)
  const d = new Date(date);
  const ist = new Date(d.getTime() + (5.5 * 60) * 60 * 1000);
  return ist;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDayIST(d) {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  return dd;
}
function endOfDayIST(d) {
  const dd = new Date(d);
  dd.setHours(23, 59, 59, 999);
  return dd;
}

async function getDailyCommits(lastNDays = 7) {
  const to = new Date();
  const from = new Date(to.getTime() - (lastNDays - 1) * 86400000);
  const query = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const data = await gql(query, {
    login: LOGIN,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const days = [];
  for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
    for (const c of w.contributionDays) days.push(c);
  }
  // Keep only lastNDays, sorted ascending by date
  days.sort((a, b) => new Date(a.date) - new Date(b.date));
  const last = days.slice(-lastNDays);

  // Build a map date => commits
  const result = last.map(d => ({
    date: d.date.slice(0, 10),
    commits: d.contributionCount,
  }));
  return result;
}

async function getEventsPages(pages = 3) {
  // User events: public only; 100 per page
  const items = [];
  for (let p = 1; p <= pages; p++) {
    const page = await rest(`/users/${LOGIN}/events`, `?per_page=100&page=${p}`);
    items.push(...page);
    if (page.length < 100) break;
  }
  return items;
}

function summarizeByDay(events, daysBack = 7) {
  const today = startOfDayIST(new Date());
  const map = new Map();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    map.set(fmtDate(d), { prs: 0, issues: 0 });
  }

  for (const e of events) {
    const createdIST = toIST(e.created_at);
    const key = fmtDate(startOfDayIST(createdIST));
    if (!map.has(key)) continue;

    if (e.type === "PullRequestEvent") map.get(key).prs += 1;
    if (e.type === "IssuesEvent") map.get(key).issues += 1;
  }

  // return newest first
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, v]) => ({ date, ...v }));
}

function summarizeHalfDay(events) {
  // Commit counts from PushEvent sizes over last 24h, two windows in IST
  const now = new Date();
  const start24 = new Date(now.getTime() - 24 * 3600 * 1000);

  let firstHalf = 0;
  let secondHalf = 0;

  for (const e of events) {
    if (e.type !== "PushEvent") continue;
    const t = toIST(e.created_at);
    if (t < start24) continue;
    const commits = e.payload?.size ?? 0;
    const hour = t.getHours();
    if (hour < 12) firstHalf += commits;
    else secondHalf += commits;
  }
  return { firstHalf, secondHalf };
}

function makeBar(n, max = 20) {
  const filled = Math.max(0, Math.min(max, Math.round(n)));
  return "█".repeat(filled) + "░".repeat(max - filled);
}

async function main() {
  const readmePath = "README.md";
  let md = await fs.readFile(readmePath, "utf8");

  const dailyCommits = await getDailyCommits(7);               // [{date, commits}]
  const events = await getEventsPages(3);                       // recent events
  const dayPRIssue = summarizeByDay(events, 7);                 // [{date, prs, issues}]
  const half = summarizeHalfDay(events);                        // {firstHalf, secondHalf}

  // Merge rows by date (commits + PRs + Issues)
  const merged = dailyCommits
    .slice()
    .reverse() // newest first to match PR/Issues order
    .map(d => {
      const p = dayPRIssue.find(x => x.date === d.date) || { prs: 0, issues: 0 };
      return { date: d.date, commits: d.commits, prs: p.prs, issues: p.issues, notes: "" };
    });

  const dailyTable = [
    "| Date | Commits | PRs | Issues | Notes |",
    "|------|---------|-----|--------|-------|",
    ...merged.map(r => `| ${r.date} | ${r.commits} | ${r.prs} | ${r.issues} | ${r.notes} |`)
  ].join("\n");

  const halfTable = [
    "| Window (IST) | Commits | Activity |",
    "|--------------|---------|----------|",
    `| 00:00–11:59  | ${half.firstHalf} | ${makeBar(Math.min(20, half.firstHalf))} |`,
    `| 12:00–23:59  | ${half.secondHalf} | ${makeBar(Math.min(20, half.secondHalf))} |`,
  ].join("\n");

  // Replace markers in README
  md = md.replace(
    /<!--START_SECTION:daily_activity-->([\s\S]*?)<!--END_SECTION:daily_activity-->/,
    `<!--START_SECTION:daily_activity-->\n${dailyTable}\n<!--END_SECTION:daily_activity-->`
  );

  md = md.replace(
    /<!--START_SECTION:halfday_activity-->([\s\S]*?)<!--END_SECTION:halfday_activity-->/,
    `<!--START_SECTION:halfday_activity-->\n${halfTable}\n<!--END_SECTION:halfday_activity-->`
  );

  await fs.writeFile(readmePath, md, "utf8");
  console.log("README updated.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
